-- Migration 009: Booking business (GST) details + idempotency claims

ALTER TABLE "reservations" ADD COLUMN "companyName" TEXT;
ALTER TABLE "reservations" ADD COLUMN "gstin" TEXT;
ALTER TABLE "reservations" ADD COLUMN "billingAddress" TEXT;

CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

CREATE TABLE "booking_idempotency" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "reservationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_idempotency_pkey" PRIMARY KEY ("id")
);

-- The correctness guarantee for concurrent POST /bookings with the same key.
CREATE UNIQUE INDEX "booking_idempotency_userId_idempotencyKey_key"
    ON "booking_idempotency"("userId", "idempotencyKey");

CREATE INDEX "booking_idempotency_expiresAt_idx"
    ON "booking_idempotency"("expiresAt");

CREATE INDEX "booking_idempotency_status_createdAt_idx"
    ON "booking_idempotency"("status", "createdAt");
