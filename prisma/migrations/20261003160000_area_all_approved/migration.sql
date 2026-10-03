-- When the verifier has approved every entry of an assignment (approved = target),
-- the admin is told and can mark the work completed.
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "all_approved_at" TIMESTAMPTZ(6);
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "all_approved_by" TEXT;

UPDATE "assignments" a
   SET all_approved_at = now(), all_approved_by = a.verifier_id
 WHERE a.status = 'active' AND a.all_approved_at IS NULL
   AND (SELECT count(*) FROM "entries" e WHERE e.assignment_id = a.id AND e.status = 'approved') >= a.target;

-- Requests sent by the admin to many people at once share a group id.
ALTER TABLE "connect_requests" ADD COLUMN IF NOT EXISTS "group_id" TEXT;
CREATE INDEX IF NOT EXISTS "connect_requests_group_id_idx" ON "connect_requests"("group_id");
