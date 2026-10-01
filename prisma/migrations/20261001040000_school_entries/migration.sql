-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "entries" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "deo_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "pincode" VARCHAR(6) NOT NULL,
    "udise_code" VARCHAR(11) NOT NULL,
    "school_name" TEXT NOT NULL,
    "educational_block" TEXT NOT NULL,
    "rural_urban" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "lgd_block" TEXT NOT NULL,
    "lgd_panchayat" TEXT NOT NULL,
    "lgd_village" TEXT NOT NULL,
    "school_category" TEXT NOT NULL,
    "school_management" TEXT NOT NULL,
    "year_established" INTEGER NOT NULL,
    "year_recognition_pri" INTEGER,
    "school_type" TEXT NOT NULL,
    "rate_per_entry" INTEGER NOT NULL,
    "status" "EntryStatus" NOT NULL DEFAULT 'pending',
    "reject_reason" TEXT,
    "verified_by_id" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "resubmit_count" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "entries_udise_code_key" ON "entries"("udise_code");
CREATE INDEX "entries_deo_id_submitted_at_idx" ON "entries"("deo_id", "submitted_at" DESC);
CREATE INDEX "entries_assignment_id_status_idx" ON "entries"("assignment_id", "status");
CREATE INDEX "entries_status_submitted_at_idx" ON "entries"("status", "submitted_at");

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entries" ADD CONSTRAINT "entries_deo_id_fkey" FOREIGN KEY ("deo_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "entries" ADD CONSTRAINT "entries_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
