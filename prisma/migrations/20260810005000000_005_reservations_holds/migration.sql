-- CreateEnum
CREATE TYPE "public"."ReservationStatus" AS ENUM ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "public"."reservations" (
    "id" UUID NOT NULL,
    "reservationNumber" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "status" "public"."ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "holdExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."reservation_items" (
    "id" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "ratePlanId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "roomTypeName" TEXT NOT NULL,
    "ratePlanName" TEXT NOT NULL,
    "mealPlanName" TEXT,
    "cancellationPolicyText" TEXT,
    "snapshotJson" JSONB,

    CONSTRAINT "reservation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."guests" (
    "id" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "age" INTEGER,
    "gender" TEXT,
    "phone" TEXT,
    "email" TEXT,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."inventory_holds" (
    "id" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "quantity" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservations_reservationNumber_key" ON "public"."reservations"("reservationNumber");

-- CreateIndex
CREATE INDEX "reservations_userId_idx" ON "public"."reservations"("userId");

-- CreateIndex
CREATE INDEX "reservations_propertyId_status_idx" ON "public"."reservations"("propertyId", "status");

-- CreateIndex
CREATE INDEX "reservation_items_reservationId_idx" ON "public"."reservation_items"("reservationId");

-- CreateIndex
CREATE INDEX "guests_reservationId_idx" ON "public"."guests"("reservationId");

-- CreateIndex
CREATE INDEX "inventory_holds_reservationId_idx" ON "public"."inventory_holds"("reservationId");

-- CreateIndex
CREATE INDEX "inventory_holds_roomTypeId_date_idx" ON "public"."inventory_holds"("roomTypeId", "date");

-- AddForeignKey
ALTER TABLE "public"."reservations" ADD CONSTRAINT "reservations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reservations" ADD CONSTRAINT "reservations_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reservation_items" ADD CONSTRAINT "reservation_items_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reservation_items" ADD CONSTRAINT "reservation_items_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "public"."room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reservation_items" ADD CONSTRAINT "reservation_items_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "public"."rate_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."guests" ADD CONSTRAINT "guests_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_holds" ADD CONSTRAINT "inventory_holds_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_holds" ADD CONSTRAINT "inventory_holds_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "public"."room_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

