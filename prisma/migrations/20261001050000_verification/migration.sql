-- Entries are assigned to a verifier automatically
ALTER TABLE "entries" ADD COLUMN "verifier_id" TEXT, ADD COLUMN "assigned_at" TIMESTAMPTZ(6);
CREATE INDEX "entries_verifier_id_status_idx" ON "entries"("verifier_id", "status");
ALTER TABLE "entries" ADD CONSTRAINT "entries_verifier_id_fkey" FOREIGN KEY ("verifier_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "VerificationDecision" AS ENUM ('approved', 'rejected');

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "entry_id" TEXT NOT NULL,
    "verifier_id" TEXT NOT NULL,
    "deo_id" TEXT NOT NULL,
    "decision" "VerificationDecision" NOT NULL,
    "reason" TEXT,
    "rate" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "verifications_verifier_id_created_at_idx" ON "verifications"("verifier_id", "created_at" DESC);
CREATE INDEX "verifications_entry_id_idx" ON "verifications"("entry_id");
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_verifier_id_fkey" FOREIGN KEY ("verifier_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "app_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "verifier_rate" INTEGER NOT NULL DEFAULT 2,
    "default_deo_rate" INTEGER NOT NULL DEFAULT 10,
    "payout_window" TEXT NOT NULL DEFAULT '15th – 25th of every month',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_settings_single_row" CHECK ("id" = 1)
);
INSERT INTO "app_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
