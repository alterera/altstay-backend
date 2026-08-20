-- Migration 010: Payment confirmation plumbing
--
-- Makes the dormant `payments` and `payment_webhook_events` tables from migration
-- 006 usable by a live flow, and adds the reservation audit trail that payment
-- confirmation writes.

-- ---------------------------------------------------------------------------
-- Preflight: `paymentReference` becomes the cross-service correlation key, so it
-- has to be NOT NULL and unique. Rather than assuming the table is empty, refuse
-- to proceed if anything would be silently rewritten.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    null_refs BIGINT;
    dupe_refs BIGINT;
BEGIN
    SELECT COUNT(*) INTO null_refs
      FROM "payments" WHERE "paymentReference" IS NULL;

    SELECT COUNT(*) INTO dupe_refs FROM (
        SELECT "paymentReference"
          FROM "payments"
         WHERE "paymentReference" IS NOT NULL
         GROUP BY "paymentReference"
        HAVING COUNT(*) > 1
    ) d;

    IF null_refs > 0 THEN
        RAISE EXCEPTION
            'Migration 010 aborted: % payments row(s) have a NULL paymentReference. '
            'Backfill them (e.g. UPDATE "payments" SET "paymentReference" = ''PAY-MIG-'' || "id" '
            'WHERE "paymentReference" IS NULL) after review, then re-run.', null_refs;
    END IF;

    IF dupe_refs > 0 THEN
        RAISE EXCEPTION
            'Migration 010 aborted: % duplicated paymentReference value(s) in payments. '
            'Resolve the duplicates before adding the unique constraint.', dupe_refs;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
ALTER TABLE "payments" ALTER COLUMN "paymentReference" SET NOT NULL;

ALTER TABLE "payments" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "payments" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "payments" ADD COLUMN "refundRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payments" ADD COLUMN "refundReason" TEXT;

CREATE UNIQUE INDEX "payments_paymentReference_key"
    ON "payments"("paymentReference");

-- At most one in-flight checkout attempt per reservation. Retries after a failure
-- get a fresh row, so FAILED/CAPTURED/REFUNDED rows stay outside the index and a
-- reservation keeps its full attempt history.
CREATE UNIQUE INDEX "payments_active_per_reservation_key"
    ON "payments"("reservationId")
    WHERE "status" IN ('PENDING', 'AUTHORIZED');

CREATE INDEX "payments_reservationId_status_idx"
    ON "payments"("reservationId", "status");

-- ---------------------------------------------------------------------------
-- payment_webhook_events
--
-- Doubles as the idempotency ledger for inbound notifications from
-- pay.alterera.net. `responseStatus`/`responsePayload` hold the terminal HTTP
-- outcome so a duplicate delivery replays byte-identically instead of guessing.
-- ---------------------------------------------------------------------------
ALTER TABLE "payment_webhook_events" ADD COLUMN "eventType" TEXT;
ALTER TABLE "payment_webhook_events" ADD COLUMN "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "payment_webhook_events" ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'PROCESSING';
ALTER TABLE "payment_webhook_events" ADD COLUMN "processingError" TEXT;
ALTER TABLE "payment_webhook_events" ADD COLUMN "responseStatus" INTEGER;
ALTER TABLE "payment_webhook_events" ADD COLUMN "responsePayload" JSONB;

CREATE INDEX "payment_webhook_events_processingStatus_receivedAt_idx"
    ON "payment_webhook_events"("processingStatus", "receivedAt");

-- ---------------------------------------------------------------------------
-- reservations
-- ---------------------------------------------------------------------------
ALTER TABLE "reservations" ADD COLUMN "confirmedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- reservation_status_history: audit trail, written inside the same transaction as
-- the status change it records.
-- ---------------------------------------------------------------------------
CREATE TABLE "reservation_status_history" (
    "id" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "fromStatus" "ReservationStatus",
    "toStatus" "ReservationStatus" NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_status_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reservation_status_history_reservationId_createdAt_idx"
    ON "reservation_status_history"("reservationId", "createdAt");

ALTER TABLE "reservation_status_history"
    ADD CONSTRAINT "reservation_status_history_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "reservations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
