-- CreateTable
CREATE TABLE "public"."cancellation_policies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rulesJson" JSONB,

    CONSTRAINT "cancellation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."meal_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "meal_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."property_policies" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "policyType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "property_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."room_inventory" (
    "id" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "totalRooms" INTEGER NOT NULL,
    "blockedRooms" INTEGER NOT NULL DEFAULT 0,
    "soldRooms" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "room_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."rate_plans" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "mealPlanId" UUID,
    "cancellationPolicyId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "rate_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."rate_prices" (
    "id" UUID NOT NULL,
    "ratePlanId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "basePrice" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "minStay" INTEGER,
    "maxStay" INTEGER,
    "closedToArrival" BOOLEAN NOT NULL DEFAULT false,
    "closedToDeparture" BOOLEAN NOT NULL DEFAULT false,
    "pricingRulesJson" JSONB,

    CONSTRAINT "rate_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_policies_name_key" ON "public"."cancellation_policies"("name");

-- CreateIndex
CREATE UNIQUE INDEX "meal_plans_code_key" ON "public"."meal_plans"("code");

-- CreateIndex
CREATE INDEX "property_policies_propertyId_idx" ON "public"."property_policies"("propertyId");

-- CreateIndex
CREATE INDEX "room_inventory_date_idx" ON "public"."room_inventory"("date");

-- CreateIndex
CREATE UNIQUE INDEX "room_inventory_roomTypeId_date_key" ON "public"."room_inventory"("roomTypeId", "date");

-- CreateIndex
CREATE INDEX "rate_plans_propertyId_roomTypeId_idx" ON "public"."rate_plans"("propertyId", "roomTypeId");

-- CreateIndex
CREATE INDEX "rate_prices_date_idx" ON "public"."rate_prices"("date");

-- CreateIndex
CREATE UNIQUE INDEX "rate_prices_ratePlanId_date_key" ON "public"."rate_prices"("ratePlanId", "date");

-- AddForeignKey
ALTER TABLE "public"."property_policies" ADD CONSTRAINT "property_policies_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."room_inventory" ADD CONSTRAINT "room_inventory_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "public"."room_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rate_plans" ADD CONSTRAINT "rate_plans_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rate_plans" ADD CONSTRAINT "rate_plans_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "public"."room_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rate_plans" ADD CONSTRAINT "rate_plans_mealPlanId_fkey" FOREIGN KEY ("mealPlanId") REFERENCES "public"."meal_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rate_plans" ADD CONSTRAINT "rate_plans_cancellationPolicyId_fkey" FOREIGN KEY ("cancellationPolicyId") REFERENCES "public"."cancellation_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."rate_prices" ADD CONSTRAINT "rate_prices_ratePlanId_fkey" FOREIGN KEY ("ratePlanId") REFERENCES "public"."rate_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

