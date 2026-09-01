-- Migration 014: Alter Cash coins ledger + reservation coin fields

CREATE TYPE "AlterCashTransactionType" AS ENUM ('EARN', 'REDEEM', 'REDEEM_REFUND', 'ADJUST');

ALTER TABLE "reservations"
  ADD COLUMN IF NOT EXISTS "coinsRedeemed" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "coinsEarnable" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "coinsEarnedAt" TIMESTAMP(3);

ALTER TABLE "booking_quotes"
  ADD COLUMN IF NOT EXISTS "coinsToRedeem" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "alter_cash_transactions" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "type" "AlterCashTransactionType" NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,
  "balanceAfter" DECIMAL(12, 2) NOT NULL,
  "reservationId" UUID,
  "userMembershipId" UUID,
  "description" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "alter_cash_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alter_cash_transactions_userId_createdAt_idx" ON "alter_cash_transactions"("userId", "createdAt");
CREATE INDEX "alter_cash_transactions_reservationId_idx" ON "alter_cash_transactions"("reservationId");
CREATE INDEX "reservations_status_checkOut_idx" ON "reservations"("status", "checkOut");

ALTER TABLE "alter_cash_transactions"
  ADD CONSTRAINT "alter_cash_transactions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alter_cash_transactions"
  ADD CONSTRAINT "alter_cash_transactions_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "alter_cash_transactions"
  ADD CONSTRAINT "alter_cash_transactions_userMembershipId_fkey"
  FOREIGN KEY ("userMembershipId") REFERENCES "user_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;
