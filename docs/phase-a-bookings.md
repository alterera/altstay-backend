# Phase A — Bookings

Authenticated booking creation with authoritative server-side pricing, transactional
inventory locking, `PAYMENT_PENDING` reservations, inventory holds, and hold expiry.

No payment gateway. There is no Cashfree integration, no `pay.alterera.net` call, no
`Payment` row creation, no `CONFIRMED` transition, and no frontend wiring in this
phase.

## API

No global `/api` prefix is configured, so routes match the existing `/auth` and
`/search` convention. Every route requires a JWT.

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/bookings` | Create a `PAYMENT_PENDING` reservation and hold its inventory |
| `GET` | `/bookings/me` | List the caller's bookings, newest first |
| `GET` | `/bookings/:reference` | Fetch one booking by reservation number, owner only |

`/bookings/me` is declared before `/bookings/:reference` so the literal path is not
captured by the parameter.

### POST /bookings

Requires an `Idempotency-Key` header (8–128 characters of letters, digits, dot,
underscore, colon or hyphen).

```jsonc
{
  "propertySlug": "hotel-alpha",
  "roomTypeId": "<uuid>",
  "ratePlanId": "<uuid>",
  "checkIn": "2026-11-17",          // yyyy-MM-dd, UTC calendar date
  "checkOut": "2026-11-19",
  "rooms": 2,
  "adults": 4,
  "guest": { "firstName": "Asha", "lastName": "Rao", "email": "...", "phone": "..." },
  "businessBooking": {               // optional; all three required together
    "companyName": "Alterera Technologies",
    "gstin": "29ABCDE1234F1Z5",
    "billingAddress": "12 MG Road, Bengaluru 560001"
  }
}
```

The DTO is validated with `whitelist` and `forbidNonWhitelisted`, so a client cannot
smuggle in its own `totalAmount`. Amounts are always computed by the server.

Responses: `201` on creation, `200` on an idempotent replay, `400` for invalid input,
`404` for an unknown property/room/rate, `409` when sold out or when the idempotency
key conflicts, `429` when rate limited.

## Status codes worth knowing

| Situation | Code | Reason |
|-----------|------|--------|
| Any night short of rooms | `409` | Sold out under the inventory lock |
| No inventory row loaded for a night | `409` | Nothing to sell, not a client error |
| Same key, different body | `409` | Key reuse with different input |
| Same key, sibling request in flight | `409` + `retryAfterSec` | Claim held by another request |
| Booking belongs to another user | `404` | Not `403` — see below |

`GET /bookings/:reference` answers `404` rather than `403` when the reservation exists
but belongs to someone else. A `403` would confirm the reference is real and turn the
endpoint into an enumeration oracle. A reservation number is a customer-facing
reference, not a credential; ownership is always checked explicitly against
`req.user.id`. Admin access will be added as a separate role-guarded route rather than
by relaxing this check.

## Pricing

`PricingService` ([src/pricing/pricing.service.ts](../src/pricing/pricing.service.ts))
is the single source of truth for money, imported by both `SearchModule` and
`BookingsModule`.

```
PricingModule
   ^        ^
Search    Bookings
```

It has two entry points so neither caller has to compromise:

- `computeQuote(prices, rooms)` — pure math over already-loaded rows. Search prices
  many rate plans from one bulk query with it, avoiding N+1.
- `loadAndQuote(client, ratePlanId, nights, rooms)` — loads and quotes through a given
  client. Bookings calls it with the transaction client.

Phase A rules: `subtotal = sum(basePrice) * rooms`, `taxAmount = round(subtotal * 0.18)`,
`discountAmount = 0`, `totalAmount = subtotal + taxAmount`. No convenience fee exists in
the schema; the one in `frontend/lib/booking-url.ts` is display-only and ignored.

`estimateTaxes` was removed from `search.utils.ts` so the 18% rule exists in exactly one
place.

## Rate restrictions

`RatePrice.minStay`, `maxStay`, `closedToArrival` and `closedToDeparture` are
**enforced** by `PricingService.assertStayAllowed`, but are **never populated today**.
They appear only in the schema and migration 004 — the admin DTO, admin service, seed,
admin UI and search all ignore them, so they are always `NULL`/`false` in practice.

Enforcement was implemented anyway because it is a handful of lines and costs nothing
against current data. Leaving it out would mean that the day an admin starts writing
those columns, guests could book stays the property had explicitly closed.

`pricingRulesJson` is not interpreted at all.

## Concurrency

Availability and price are both resolved *inside* the transaction. Validation before
`BEGIN` is advisory only: it exists to return fast, specific 4xx errors, and its result
never reaches the reservation.

```
validate (advisory)
BEGIN
  lock room_inventory rows FOR UPDATE, ordered by date
  sum active holds per night
  free = totalRooms - blockedRooms - soldRooms - activeHolds
  reject if any night short                      -> 409
  PricingService.loadAndQuote(tx, ...)            <- authoritative
  insert reservation (PAYMENT_PENDING) from that quote
  insert items, guests, holds
  mark idempotency claim COMPLETED
COMMIT
```

The `FOR UPDATE` is what serializes competing bookings. A second transaction blocks on
the lock until the first commits; because each statement under READ COMMITTED takes a
fresh snapshot, its hold query then sees the winner's hold. Locks are always taken in
date order so concurrent requests queue rather than deadlock.

`soldRooms` is never incremented in Phase A. Holds are the only mechanism consuming
inventory before a payment exists; `soldRooms` becomes Phase B's job on confirmation.

## Idempotency

Correctness rests on the unique index `(userId, idempotencyKey)`, never on a
read-then-write check — the latter is not safe when two requests arrive together.

1. **Claim.** Insert an `IN_PROGRESS` row in its own short transaction. If the insert
   wins, this request owns the key. If it raises a unique violation, read the existing
   row and branch: different `requestHash` -> `409`; `COMPLETED` -> replay the stored
   reservation; `IN_PROGRESS` -> `409` with `retryAfterSec`.
2. **Book.** The reservation insert and the claim's flip to `COMPLETED` happen in the
   *same* transaction, so a committed booking always has a committed claim. This is what
   makes the lost-response retry return the original booking rather than create a second.
3. **Release.** If the booking transaction rolls back, the claim is deleted so the client
   can retry with the same key. If the process dies first, the stale sweep handles it.

The request hash is a SHA-256 of the canonicalized body, so field ordering does not
affect it.

### Expiry versus the unique constraint

`expiresAt` alone frees nothing — the unique index still matches an expired row. A key
becomes reusable only once its row is **deleted**. `BookingMaintenanceService` sweeps
every 5 minutes:

- `COMPLETED` claims past their 24h `expiresAt`
- `IN_PROGRESS` claims older than 5 minutes (a request that died mid-flight)

## Hold expiry

Candidates are listed without locks, then each is processed in its own transaction:

```
BEGIN
  SELECT status, holdExpiresAt FROM reservations WHERE id = $1 FOR UPDATE
  if status = PAYMENT_PENDING and holdExpiresAt <= now:
      status -> EXPIRED
      delete inventory_holds for the reservation
COMMIT
```

The re-read inside the lock is the point: without it the job could act on a snapshot
taken before a concurrent payment confirmation and expire a booking that was just paid
for. Phase B's confirmation path will take the same lock, so the two serialize. A
reservation another path already moved on is skipped, not errored.

## Lifecycle

`booking-lifecycle.ts` holds the full transition map; status is only ever mutated through
`BookingsService`.

```
              createBooking
                    |
                    v
            PAYMENT_PENDING
             /      |      \
       (A) EXPIRED  |   (B) CANCELLED
                    |
              (B) CONFIRMED
```

(A) is implemented in Phase A; (B) is declared but not yet reachable. There is no
`PAYMENT_FAILED` status — a failed payment resolves to `CANCELLED`.

## Reservation number

`ALTSTAY-{yyyyMMdd}-{6 chars}` using Crockford base32 (no I, L, O or U), stamped from the
UTC date. The keyspace is 32^6 (~1.07 billion) per day; candidates are checked before
insert and the unique index plus a transaction retry covers the rest.

## Schema (migration 009)

`reservations` gains three nullable columns, written together or not at all:
`companyName`, `gstin`, `billingAddress`.

New `booking_idempotency` table with a new `IdempotencyStatus` enum
(`IN_PROGRESS`, `COMPLETED`). It deliberately has **no** foreign key to `reservations`:
the claim is created before the reservation exists, and the sweep must be free to delete
claims without touching bookings.

`ReservationItem.snapshotJson` stores the frozen quote — nightly prices, tax rate, rooms,
adults, property slug, and `quotedAt` — so a later admin rate change cannot alter what
the guest purchased.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOOKING_HOLD_TTL_MINUTES` | `10` | How long a `PAYMENT_PENDING` reservation holds inventory |
| `TEST_DATABASE_URL` | unset | Overrides `DATABASE_URL` for `npm run test:e2e` |

## Rate limiting

`POST /bookings` reuses `RateLimitService`, now exported from `AuthModule` so both
modules share one set of buckets.

| Key | Limit |
|-----|-------|
| `booking:user:{userId}` | 10 per 5 minutes |
| `booking:ip:{ip}` | 30 per hour |

The limiter is in-memory and therefore per-process; it will not hold across horizontally
scaled instances. Moving it to Redis is the production follow-up.

## Tests

```
npm test          # 97 unit tests
npm run test:e2e  # 48 e2e tests, needs real PostgreSQL
```

E2E needs real PostgreSQL because the suites assert on `SELECT ... FOR UPDATE` behaviour
under concurrency. Set `TEST_DATABASE_URL` to use a dedicated database; without it the
suites run against `DATABASE_URL` and remove their own fixtures, which are namespaced
with a random suffix.

Two infrastructure notes: Jest needs `moduleNameMapper` to strip the `.js` specifiers the
generated Prisma client emits, and `test:e2e` runs with
`NODE_OPTIONS=--experimental-vm-modules` because Prisma 7 loads its query compiler through
a dynamic import.

| Suite | Covers |
|-------|--------|
| `bookings.concurrency.e2e-spec.ts` | 10 users / 2 rooms, 2 users / 1 room, expired hold released and rebooked |
| `bookings.idempotency.e2e-spec.ts` | Concurrent identical keys, lost-response replay, body mismatch, reuse after sweep |
| `bookings.api.e2e-spec.ts` | Auth, ownership 404, pagination, snapshots, business fields, rate limiting |

## Assumptions carried into Phase B

- Tax is a flat 18%, matching what search already displays
- No promotions, coupons or convenience fees
- `soldRooms` untouched until payment confirmation
- Rate restrictions are enforced but never populated; `pricingRulesJson` ignored
- Stays are capped at 30 nights, which also bounds how many inventory rows one request locks
- One room type per booking; the schema supports multiple `ReservationItem`s but the API takes one
- Rate limiting is in-memory and per-process
- **Search results do not subtract active holds** (see below)

## Phase B

Implemented. See [phase-b-payments.md](./phase-b-payments.md). Search still does
not subtract active holds; that remains a Phase C/search follow-up.
