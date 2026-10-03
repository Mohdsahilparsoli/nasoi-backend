-- Default e-mail template for files sent from the admin panel (NULL = built-in default).
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "mail_subject" VARCHAR(200);
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "mail_message" TEXT;
