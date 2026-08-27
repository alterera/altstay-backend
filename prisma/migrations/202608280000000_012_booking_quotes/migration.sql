-- Booking quotes: checkout price snapshots without inventory holds.

CREATE TABLE "booking_quotes" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "ratePlanId" UUID NOT NULL,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "rooms" INTEGER NOT NULL,
    "adults" INTEGER NOT NULL,
    "quoteJson" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_quotes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "booking_quotes_token_key" ON "booking_quotes"("token");
CREATE INDEX "booking_quotes_userId_idx" ON "booking_quotes"("userId");
CREATE INDEX "booking_quotes_expiresAt_idx" ON "booking_quotes"("expiresAt");

ALTER TABLE "booking_quotes" ADD CONSTRAINT "booking_quotes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "booking_quotes" ADD CONSTRAINT "booking_quotes_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
