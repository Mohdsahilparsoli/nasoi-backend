-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('aadhaar', 'pan', 'bank_proof', 'photo', 'signature');

-- CreateTable
CREATE TABLE "profiles" (
    "user_id" TEXT NOT NULL,
    "father_name" TEXT NOT NULL,
    "mother_name" TEXT NOT NULL,
    "dob" DATE NOT NULL,
    "gender" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "religion" TEXT NOT NULL,
    "alt_mobile" VARCHAR(10),
    "country" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "sub_district" TEXT NOT NULL,
    "post_office" TEXT NOT NULL,
    "pincode" VARCHAR(6) NOT NULL,
    "police_station" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "qualification" TEXT NOT NULL,
    "aadhaar_last4" VARCHAR(4) NOT NULL,
    "aadhaar_hash" TEXT NOT NULL,
    "aadhaar_enc" TEXT NOT NULL,
    "pan" VARCHAR(10),
    "bank_name" TEXT NOT NULL,
    "account_holder" TEXT NOT NULL,
    "account_last4" VARCHAR(4) NOT NULL,
    "account_enc" TEXT NOT NULL,
    "ifsc" VARCHAR(11) NOT NULL,
    "bank_proof_type" TEXT NOT NULL,
    "terms_accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "user_id" TEXT,
    "kind" "DocumentKind" NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "upload_token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attached_at" TIMESTAMPTZ(6),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_counters" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "id_counters_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_aadhaar_hash_key" ON "profiles"("aadhaar_hash");

-- CreateIndex
CREATE INDEX "documents_user_id_idx" ON "documents"("user_id");

-- CreateIndex
CREATE INDEX "documents_attached_at_created_at_idx" ON "documents"("attached_at", "created_at");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
