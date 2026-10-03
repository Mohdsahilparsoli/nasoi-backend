-- Assignments: record type (school / college), verifier for the area, verifier amount
ALTER TABLE "assignments"
  ADD COLUMN "record_type" TEXT NOT NULL DEFAULT 'school',
  ADD COLUMN "verifier_id" TEXT,
  ADD COLUMN "verifier_rate" INTEGER;
CREATE INDEX "assignments_verifier_id_status_idx" ON "assignments"("verifier_id", "status");
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_verifier_id_fkey" FOREIGN KEY ("verifier_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Entries: generic record (code, name, JSON data) instead of fixed school columns
ALTER TABLE "entries"
  ADD COLUMN "record_type" TEXT NOT NULL DEFAULT 'school',
  ADD COLUMN "record_code" VARCHAR(20),
  ADD COLUMN "record_name" TEXT,
  ADD COLUMN "data" JSONB NOT NULL DEFAULT '{}';

-- Keep every existing school entry: copy the old columns into the JSON data.
UPDATE "entries" SET
  "record_code" = "udise_code",
  "record_name" = "school_name",
  "data" = jsonb_strip_nulls(jsonb_build_object(
    'udiseCode', "udise_code",
    'schoolName', "school_name",
    'educationalBlock', "educational_block",
    'ruralUrban', "rural_urban",
    'cluster', "cluster",
    'lgdBlock', "lgd_block",
    'lgdPanchayat', "lgd_panchayat",
    'lgdVillage', "lgd_village",
    'schoolCategory', "school_category",
    'schoolManagement', "school_management",
    'yearEstablished', "year_established",
    'yearRecognitionPri', "year_recognition_pri",
    'schoolType', "school_type"
  ));

ALTER TABLE "entries" ALTER COLUMN "record_code" SET NOT NULL, ALTER COLUMN "record_name" SET NOT NULL;
CREATE UNIQUE INDEX "entries_record_code_key" ON "entries"("record_code");

DROP INDEX "entries_udise_code_key";
ALTER TABLE "entries"
  DROP COLUMN "udise_code",
  DROP COLUMN "school_name",
  DROP COLUMN "educational_block",
  DROP COLUMN "rural_urban",
  DROP COLUMN "cluster",
  DROP COLUMN "lgd_block",
  DROP COLUMN "lgd_panchayat",
  DROP COLUMN "lgd_village",
  DROP COLUMN "school_category",
  DROP COLUMN "school_management",
  DROP COLUMN "year_established",
  DROP COLUMN "year_recognition_pri",
  DROP COLUMN "school_type";
