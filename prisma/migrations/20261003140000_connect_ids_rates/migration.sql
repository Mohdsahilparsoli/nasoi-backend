-- 1) Personal meeting link, rejected fields
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "meeting_link" VARCHAR(500);
ALTER TABLE "entries" ADD COLUMN IF NOT EXISTS "reject_fields" JSONB;
ALTER TABLE "verifications" ADD COLUMN IF NOT EXISTS "fields" JSONB;

-- 2) Verifier money only for a FINAL approval: rejections earn nothing.
UPDATE "verifications" SET "rate" = 0 WHERE "decision" = 'rejected' AND "rate" <> 0;

-- 3) Old login IDs keep working after the rename.
CREATE TABLE "user_id_aliases" (
  "old_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_id_aliases_pkey" PRIMARY KEY ("old_id")
);
CREATE INDEX "user_id_aliases_user_id_idx" ON "user_id_aliases"("user_id");
ALTER TABLE "user_id_aliases" ADD CONSTRAINT "user_id_aliases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) Rename DEO / verifier IDs to DEO-01-2026 / VR-01-2026 (number per role per
--    registration year, in order of registration). Foreign keys cascade.
CREATE TEMP TABLE id_map AS
  SELECT id AS old_id,
         (CASE WHEN role = 'deo' THEN 'DEO-' ELSE 'VR-' END) || lpad(n::text, 2, '0') || '-' || yr AS new_id,
         role, yr, n
  FROM (
    SELECT id, role, extract(year FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS yr,
           row_number() OVER (PARTITION BY role, extract(year FROM created_at AT TIME ZONE 'Asia/Kolkata') ORDER BY created_at, id) AS n
    FROM "users"
    WHERE role IN ('deo', 'verifier') AND id !~ '^(DEO|VR)-[0-9]+-[0-9]{4}$'
  ) t;

UPDATE "users" u SET id = m.new_id FROM id_map m WHERE u.id = m.old_id;
-- Columns without a foreign key
UPDATE "verifications" v SET deo_id = m.new_id FROM id_map m WHERE v.deo_id = m.old_id;
UPDATE "notifications" SET link = replace(link, '/admin/operators/' || m.old_id, '/admin/operators/' || m.new_id)
  FROM id_map m WHERE link = '/admin/operators/' || m.old_id;
INSERT INTO "user_id_aliases" (old_id, user_id) SELECT old_id, new_id FROM id_map;
INSERT INTO "notifications" (id, user_id, title, body, link)
  SELECT gen_random_uuid(), new_id, 'Your new User ID: ' || new_id,
         'Your User ID has changed from ' || old_id || ' to ' || new_id || '. Please use the new ID to log in (your old ID, mobile number and e-mail also still work).',
         CASE WHEN role = 'deo' THEN '/deo/profile' ELSE '/verifier/profile' END
  FROM id_map;
-- Next numbers for new registrations
INSERT INTO "id_counters" (key, value)
  SELECT role || ':' || yr, max(n) FROM id_map GROUP BY role, yr
  ON CONFLICT (key) DO UPDATE SET value = GREATEST(id_counters.value, EXCLUDED.value);

DROP TABLE id_map;

-- 5) Meetings and requests
CREATE TYPE "MeetingStatus" AS ENUM ('scheduled', 'cancelled');
CREATE TYPE "RequestKind" AS ENUM ('meeting', 'entry', 'general');
CREATE TYPE "RequestStatus" AS ENUM ('open', 'accepted', 'declined', 'closed');

CREATE TABLE "meetings" (
  "id" TEXT NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "platform" VARCHAR(20) NOT NULL,
  "link" VARCHAR(500) NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "duration_min" INTEGER NOT NULL DEFAULT 30,
  "notes" VARCHAR(1000),
  "entry_id" TEXT,
  "status" "MeetingStatus" NOT NULL DEFAULT 'scheduled',
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "meetings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meetings_duration_check" CHECK ("duration_min" BETWEEN 5 AND 480)
);
CREATE INDEX "meetings_starts_at_idx" ON "meetings"("starts_at");
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "meeting_participants" (
  "meeting_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("meeting_id", "user_id")
);
CREATE INDEX "meeting_participants_user_id_idx" ON "meeting_participants"("user_id");
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "connect_requests" (
  "id" TEXT NOT NULL,
  "kind" "RequestKind" NOT NULL,
  "from_id" TEXT NOT NULL,
  "to_id" TEXT NOT NULL,
  "entry_id" TEXT,
  "subject" VARCHAR(120) NOT NULL,
  "message" VARCHAR(1000) NOT NULL,
  "preferred_at" TIMESTAMPTZ(6),
  "status" "RequestStatus" NOT NULL DEFAULT 'open',
  "reply" VARCHAR(1000),
  "responded_at" TIMESTAMPTZ(6),
  "meeting_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "connect_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "connect_requests_meeting_id_key" ON "connect_requests"("meeting_id");
CREATE INDEX "connect_requests_to_id_status_idx" ON "connect_requests"("to_id", "status");
CREATE INDEX "connect_requests_from_id_created_at_idx" ON "connect_requests"("from_id", "created_at" DESC);
ALTER TABLE "connect_requests" ADD CONSTRAINT "connect_requests_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connect_requests" ADD CONSTRAINT "connect_requests_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connect_requests" ADD CONSTRAINT "connect_requests_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
