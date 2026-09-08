-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "restrictions" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_restrictions" (
    "propertyId" UUID NOT NULL,
    "restrictionId" UUID NOT NULL,

    CONSTRAINT "property_restrictions_pkey" PRIMARY KEY ("propertyId","restrictionId")
);

-- AlterTable: reviews
ALTER TABLE "reviews" ADD COLUMN "ratingCheckIn" INTEGER;
ALTER TABLE "reviews" ADD COLUMN "ratingRoom" INTEGER;
ALTER TABLE "reviews" ADD COLUMN "ratingStaff" INTEGER;
ALTER TABLE "reviews" ADD COLUMN "ratingSurroundings" INTEGER;

-- Convert propertyId to UUID if needed (was TEXT in original migration)
ALTER TABLE "reviews" ALTER COLUMN "propertyId" TYPE UUID USING "propertyId"::uuid;

-- Convert status to enum
ALTER TABLE "reviews" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "reviews" ALTER COLUMN "status" TYPE "ReviewStatus" USING (
  CASE
    WHEN "status" = 'APPROVED' THEN 'APPROVED'::"ReviewStatus"
    WHEN "status" = 'REJECTED' THEN 'REJECTED'::"ReviewStatus"
    ELSE 'PENDING'::"ReviewStatus"
  END
);
ALTER TABLE "reviews" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "restrictions_label_key" ON "restrictions"("label");
CREATE INDEX "reviews_propertyId_status_idx" ON "reviews"("propertyId", "status");

-- AddForeignKey
ALTER TABLE "property_restrictions" ADD CONSTRAINT "property_restrictions_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "property_restrictions" ADD CONSTRAINT "property_restrictions_restrictionId_fkey" FOREIGN KEY ("restrictionId") REFERENCES "restrictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
