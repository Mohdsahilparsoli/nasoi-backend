-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('active', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "deo_id" TEXT NOT NULL,
    "assigned_by_id" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "rate_per_entry" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "village" TEXT NOT NULL,
    "pincode" VARCHAR(6) NOT NULL,
    "deadline" DATE NOT NULL,
    "instructions" TEXT,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'active',
    "seen_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assignments_deo_id_status_idx" ON "assignments"("deo_id", "status");

-- CreateIndex
CREATE INDEX "assignments_pincode_status_idx" ON "assignments"("pincode", "status");

-- CreateIndex
CREATE INDEX "assignments_status_created_at_idx" ON "assignments"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_deo_id_fkey" FOREIGN KEY ("deo_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Remove demo and test accounts (example.com / example.in e-mails), except the
-- verifier demo account VR101 which is kept until the verification module goes live.
DELETE FROM "users"
 WHERE "role" IN ('deo', 'verifier')
   AND "id" <> 'VR101'
   AND ("email" LIKE '%@example.com' OR "email" LIKE '%@example.in');
