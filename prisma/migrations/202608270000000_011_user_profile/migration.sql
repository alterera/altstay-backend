-- User profile fields for the account page.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "gender" TEXT,
  ADD COLUMN IF NOT EXISTS "dateOfBirth" DATE,
  ADD COLUMN IF NOT EXISTS "cityOfResidence" TEXT,
  ADD COLUMN IF NOT EXISTS "referralCode" TEXT,
  ADD COLUMN IF NOT EXISTS "alterCashBalance" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "membershipTier" TEXT NOT NULL DEFAULT 'Alterstay Member',
  ADD COLUMN IF NOT EXISTS "membershipExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "users_referralCode_key" ON "users"("referralCode");
