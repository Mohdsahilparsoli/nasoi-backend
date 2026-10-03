-- Employee status: pending (new registration), inactive, rejected
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'inactive';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'rejected';
ALTER TABLE "users" ADD COLUMN "status_reason" TEXT, ADD COLUMN "status_changed_at" TIMESTAMPTZ(6);

-- Payout receipts
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "amount" INTEGER NOT NULL,
    "transaction_id" VARCHAR(60) NOT NULL,
    "payee_name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "paid_on" DATE NOT NULL,
    "entries_count" INTEGER,
    "period_from" DATE,
    "period_to" DATE,
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");
CREATE INDEX "payments_user_id_paid_on_idx" ON "payments"("user_id", "paid_on" DESC);
CREATE INDEX "payments_role_paid_on_idx" ON "payments"("role", "paid_on" DESC);
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
