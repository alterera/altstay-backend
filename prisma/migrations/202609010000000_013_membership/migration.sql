-- CreateEnum
CREATE TYPE "MembershipPurchaseStatus" AS ENUM ('PENDING', 'CAPTURED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "UserMembershipStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MembershipCancellationReason" AS ENUM ('ADMIN', 'REFUNDED', 'UPGRADE');

-- CreateTable
CREATE TABLE "membership_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "discountPercent" INTEGER NOT NULL,
    "benefitsDescription" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_purchases" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "paymentReference" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "MembershipPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "providerPaymentId" TEXT,
    "paymentMethod" TEXT,
    "failureReason" TEXT,
    "refundReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_memberships" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "status" "UserMembershipStatus" NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "cancellationReason" "MembershipCancellationReason",
    "upgradeCreditDays" INTEGER,
    "upgradeCreditValue" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "membership_plans_code_key" ON "membership_plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "membership_purchases_paymentReference_key" ON "membership_purchases"("paymentReference");

-- CreateIndex
CREATE UNIQUE INDEX "membership_purchases_userId_idempotencyKey_key" ON "membership_purchases"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "membership_purchases_userId_status_idx" ON "membership_purchases"("userId", "status");

-- CreateIndex
CREATE INDEX "membership_purchases_status_expiresAt_idx" ON "membership_purchases"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_memberships_purchaseId_key" ON "user_memberships"("purchaseId");

-- CreateIndex
CREATE INDEX "user_memberships_userId_status_idx" ON "user_memberships"("userId", "status");

-- CreateIndex
CREATE INDEX "user_memberships_status_expiresAt_idx" ON "user_memberships"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "membership_purchases" ADD CONSTRAINT "membership_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_purchases" ADD CONSTRAINT "membership_purchases_planId_fkey" FOREIGN KEY ("planId") REFERENCES "membership_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_planId_fkey" FOREIGN KEY ("planId") REFERENCES "membership_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "membership_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Expire legacy free memberships granted on signup
UPDATE "users"
SET "membershipTier" = 'Free',
    "membershipExpiresAt" = NULL
WHERE "membershipExpiresAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "membership_purchases" mp WHERE mp."userId" = "users"."id"
  );

-- Default tier for users without legacy expiry
UPDATE "users"
SET "membershipTier" = 'Free'
WHERE "membershipTier" = 'Alterstay Member'
  AND "membershipExpiresAt" IS NULL;
