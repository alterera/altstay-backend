# Backend setup

## Database migrations

Prisma migrations are numbered by domain:

| Migration | Domain |
|-----------|--------|
| `001_auth_rbac` | Users, OTP, sessions, platform RBAC |
| `002_organizations_properties` | Organizations, properties, addresses |
| `003_room_catalog` | Room types, physical rooms, amenities, images |
| `004_inventory_rate_plans` | Inventory, rate plans, pricing |
| `005_reservations_holds` | Reservations, guests, inventory holds |
| `006_payments_webhooks` | Payments, refunds, webhook idempotency |
| `007_reviews` | Verified stay reviews |

Apply all pending migrations:

```bash
cp .env.example .env   # set DATABASE_URL and JWT secrets
npm run prisma:migrate -- --name skip   # or: npx prisma migrate deploy
npm run prisma:seed
```

Regenerate incremental migration SQL from schema snapshots:

```bash
node scripts/generate-migrations.js
```

## AWS RDS connectivity

If you see `P1001: Can't reach database server`, ensure:

1. The RDS instance is running.
2. Your IP is allowed in the RDS security group (inbound TCP 5432).
3. `DATABASE_URL` in `.env` uses the correct password and `sslmode=require`.

## Auth API

Server runs on port `3001` by default.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/otp/request` | Send OTP (stub logs code in dev) |
| POST | `/auth/otp/verify` | Verify OTP and issue tokens |
| POST | `/auth/login` | Password login |
| POST | `/auth/refresh` | Rotate refresh token |
| POST | `/auth/logout` | Revoke refresh token |
| GET | `/auth/me` | Current user (Bearer token) |

## Inventory locking (Migration 005+)

When implementing booking holds, lock **every nightly** `room_inventory` row in the stay range inside a single transaction. Always acquire locks in deterministic order: `room_type_id ASC`, then `date ASC`, to prevent deadlocks between concurrent bookings.
