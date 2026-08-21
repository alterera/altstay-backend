# Phase B — Payments

Turns a `PAYMENT_PENDING` reservation into an authoritative `CONFIRMED` booking
after Cashfree reports a verified payment, without the frontend ever deciding
the amount, the outcome, or the inventory.

Frontend wiring (the summary-page `onSubmit`, the result page, polling) is Phase C.
This document is the frozen contract Phase C should code against.

## Trust boundaries

- The hotel backend owns reservations, prices, inventory, holds, and status.
- `pay.alterera.net` owns Cashfree credentials, order creation, webhook
  verification, the payment transaction, notification retries, and reconciliation.
- The browser receives only an opaque checkout URL and later reads
  `GET /bookings/:reference`. A Cashfree redirect is not proof of payment.

## Customer-facing API

### `POST /bookings/:reference/payment-session`

JWT + ownership 404 (same rule as `GET /bookings/:reference`). No request body.
The payable amount is the reservation total, never a client-supplied figure.

Three-phase flow: a short lock to create or reuse a live `Payment` row, an
external call to the payment service **outside** any reservation lock, then a
short re-lock to publish or abort the session.

```json
{
  "paymentReference": "PAY-9f2c...",
  "paymentSessionId": "session_...",
  "checkoutUrl": "https://payments.cashfree.com/order/#session_...",
  "cashfreeMode": "production",
  "sessionExpiresAt": "2026-08-20T07:05:00.000Z",
  "amount": "8700.00",
  "currency": "INR",
  "holdExpiresAt": "2026-08-20T07:10:00.000Z"
}
```

- 201 — checkout URL issued
- 404 — unknown or not owned
- 409 — already paid, expired, or hold too close to expiry
- 502 — payment service unreachable; the live `PENDING` attempt is kept for retry

A failed attempt is never reused. The next Pay click mints a new
`paymentReference`. A `PENDING` attempt that has been sitting longer than
`PAYMENT_ATTEMPT_STALE_MINUTES` is abandoned the same way.

### `GET /bookings/:reference`

Authoritative status after checkout. Extended with a single payment summary.
Provider identifiers are not included.

| Reservation status | Payment shown |
| --- | --- |
| `CONFIRMED` | The `CAPTURED` payment that bought the booking |
| `PAYMENT_PENDING` | The live attempt, else the most recent `FAILED` |
| `EXPIRED` / `CANCELLED` | A `CAPTURED` payment with `refundRequired`, else the latest attempt |

## Internal API

`POST /internal/payments/notifications` — HMAC-signed
(`X-Alterera-Signature`, `X-Alterera-Timestamp`, `X-Alterera-Event-Id`) over
`${timestamp}.${rawBody}`.

- 200 processed (terminal)
- 202 captured but not confirmable, refund required (terminal)
- 409 earlier delivery still in flight (retry)
- 422 permanent rejection (stop)
- 401 bad signature

Duplicate `eventId`s replay the stored `responseStatus` and `responsePayload`.

## Confirmation

Both hold expiry and confirmation take `SELECT ... FROM reservations FOR UPDATE`
on the same row.

- On-time (`PAYMENT_PENDING`, `holdExpiresAt > now`, holds exist): convert holds
  to `soldRooms` in the same transaction. Free rooms stay constant.
- Late (`holdExpiresAt` passed, or status already `EXPIRED`): re-check inventory
  from `ReservationItem`. Confirm if capacity exists (`EXPIRED -> CONFIRMED` is
  allowed only on this path). Otherwise mark the payment `CAPTURED` with
  `refundRequired` and return 202.
- Failure: mark the payment `FAILED`. The reservation stays `PAYMENT_PENDING`
  with its hold intact.
- Late success on a `FAILED` attempt: refund-required, 202, do not confirm.

## Schema (migration 010)

- `payments.paymentReference` NOT NULL unique; partial unique index of one live
  (`PENDING`/`AUTHORIZED`) attempt per reservation
- `refundRequired`, `failureReason`, `updatedAt`
- `payment_webhook_events` stores `responseStatus` / `responsePayload` for replay
- `reservations.confirmedAt`
- `reservation_status_history`

## Environment

See `.env.example`. Notable knobs:

- `PAYMENT_SERVICE_BASE_URL` / `PAYMENT_SERVICE_TOKEN`
- `PAYMENT_NOTIFICATION_SIGNING_SECRET` / `PAYMENT_NOTIFICATION_MAX_SKEW_SECONDS`
- `PAYMENT_SESSION_MIN_HOLD_REMAINING_SECONDS` (default 60)
- `PAYMENT_ATTEMPT_STALE_MINUTES` (default 15)
- `BOOKING_RESULT_URL` (the booking reference is appended as `?ref=`)

## Tests

| Suite | Covers |
| --- | --- |
| `payments.sessions.e2e-spec.ts` | Session contract, reuse, failed-attempt retry, lock not held during the provider call |
| `payments.confirmation.e2e-spec.ts` | On-time conversion, late path, duplicates, failure, signature, concurrent expiry |
| `src/payments/__tests__/*` | HTTP client, HMAC guard |
| `src/bookings/dto/__tests__/payment-summary.spec.ts` | Customer-visible payment selection |

Phase A suites are unchanged and still required to pass.
