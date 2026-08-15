-- Migration 008: Cities, areas, property tags, property search fields

CREATE TABLE "cities" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "state" TEXT,
    "country" TEXT NOT NULL DEFAULT 'India',

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cities_name_key" ON "cities"("name");
CREATE UNIQUE INDEX "cities_slug_key" ON "cities"("slug");

CREATE TABLE "areas" (
    "id" UUID NOT NULL,
    "cityId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "areas_cityId_slug_key" ON "areas"("cityId", "slug");
CREATE INDEX "areas_cityId_idx" ON "areas"("cityId");

ALTER TABLE "areas" ADD CONSTRAINT "areas_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "property_tags" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "property_tags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "property_tags_code_key" ON "property_tags"("code");

CREATE TABLE "property_tag_assignments" (
    "propertyId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "property_tag_assignments_pkey" PRIMARY KEY ("propertyId", "tagId")
);

ALTER TABLE "property_tag_assignments" ADD CONSTRAINT "property_tag_assignments_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "property_tag_assignments" ADD CONSTRAINT "property_tag_assignments_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "property_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "properties" ADD COLUMN "areaId" UUID;
ALTER TABLE "properties" ADD COLUMN "guestRating" DECIMAL(2, 1);
ALTER TABLE "properties" ADD COLUMN "isBusinessHotel" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "properties_areaId_idx" ON "properties"("areaId");

ALTER TABLE "properties" ADD CONSTRAINT "properties_areaId_fkey"
    FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
