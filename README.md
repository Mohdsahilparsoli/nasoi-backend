# NASOI Backend API

REST API for the **NASOI School Data Entry Portal**, built with Node.js, Express 5, **Prisma 7** (`@prisma/adapter-pg`) and **PostgreSQL** (Prisma Postgres).
It is deployed to Vercel as a separate project from the Next.js frontend.

**Live API:** `https://nasoi-api.vercel.app` (the default everywhere for now; it will move to `https://api.nasoi.com` later).

Modules done: **Login / Auth**, **Registration** (DEO & Verifier, with documents and profile), **Assign work** (admin) with notifications, **School entries** (DEO). The other modules (registration, assignments, entries, verification, payouts) will be added one by one.

## Endpoints (v1)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/v1/health` | – | API and database status |
| POST | `/api/v1/auth/login` | – | `{ loginId, password }` → `{ user, accessToken, expiresIn }` and the refresh cookie. The role is taken from the account. |
| POST | `/api/v1/auth/refresh` | refresh cookie | `{ role }` → new access token. The refresh token is rotated. |
| POST | `/api/v1/auth/logout` | refresh cookie | `{ role }` → revokes the session |
| GET  | `/api/v1/auth/me` | Bearer | The current user |
| POST | `/api/v1/auth/change-password` | Bearer | `{ currentPassword, newPassword }` → logs out all other devices |
| POST | `/api/v1/auth/forgot-password` | – | `{ email }` → e-mails a reset link (JWT, 30 min, single-use). Same answer whether the e-mail exists or not |
| POST | `/api/v1/auth/reset-password` | – | `{ token, newPassword }` → sets the password, logs out all devices |
| POST | `/api/v1/registrations/uploads` | – | multipart `kind` + `file` (PDF/JPG/PNG ≤ 2 MB, type checked from file bytes) → `{ upload: { id, token } }` |
| POST | `/api/v1/registrations` | – | Full registration form + upload refs + password → `{ user, emailSent }` and a confirmation e-mail with the ID (never the password or Aadhaar) (role `deo` → `DEO1001…`, `verifier` → `VR201…`) |
| GET  | `/api/v1/profile/me` | Bearer | Own profile (Aadhaar / account masked) and document list |
| PATCH | `/api/v1/profile/me/contact` | Bearer | Mobile, alternate mobile, email, address |
| PATCH | `/api/v1/profile/me/bank` | Bearer | Bank details |
| GET  | `/api/v1/documents/:id` | Bearer | View a document (owner, verifier or admin) |
| GET  | `/api/v1/admin/operators?q=` | Admin | All DEOs with location, current work and eligibility |
| GET  | `/api/v1/admin/operators/:id` | Admin | Full profile (masked), documents, assignments |
| PATCH | `/api/v1/admin/operators/:id/status` | Admin | `{ status: "active" \| "blocked" }` (blocking logs the DEO out) |
| GET / POST | `/api/v1/admin/assignments` | Admin | List / assign work. Rules: one active assignment per DEO and per PIN code; ID `ASG-<PIN>-001` |
| PATCH | `/api/v1/admin/assignments/:id` | Admin | `{ status: "completed" \| "cancelled" }` |
| GET  | `/api/v1/me/assignments` | DEO | `{ current, history }` with entry progress (`?seen=1` marks the current one seen) |
| GET  | `/api/v1/me/summary` | DEO | Totals (pending / approved / rejected), earnings = approved × rate, month-wise history, progress of current work |
| GET / POST | `/api/v1/me/entries` | DEO | List (`?status=&q=`) / add a school record (UDISE, school name, block, LGD details, category, management, years, type). State, district and PIN come from the current assignment. UDISE codes are unique; no entries beyond the target |
| GET / PATCH | `/api/v1/me/entries/:id` | DEO | View / correct a pending entry, or fix and resubmit a rejected one (approved entries are final) |
| GET  | `/api/v1/notifications` / POST `/notifications/read` | Bearer | In-app notifications (bell) |

All `POST` requests must send the header `X-NASOI-Client: web`.

## Security

- **Passwords:** hashed with bcrypt (cost 12) and never returned or logged. The timing is equalised for unknown users.
- **Login ID:** users can log in with their User ID, their mobile number (with or without +91), or their email. The error message is the same for every failure, so it does not reveal which accounts exist.
- **Brute force protection:**
  - The account locks for 15 minutes after 5 wrong passwords.
  - A per IP + ID rate limit allows 10 attempts per 15 minutes.
- **Tokens:**
  - The access token is a JWT (HS256) that lasts 15 minutes. The frontend keeps it only in memory.
  - Every request also checks that the session is still live and the user is still active.
  - The refresh token is random (32 bytes) and lives in an **httpOnly, Secure, SameSite=Strict** cookie scoped to `/api/v1/auth`. There is one cookie per role, so DEO, Verifier and Admin can stay logged in side by side.
  - Only the refresh token's SHA-256 hash is stored in the database.
  - The refresh token rotates on every use. Replaying an old token kills the session.
- **CSRF:** SameSite=Strict cookies, a custom header, and an Origin allowlist.
- **HTTP hardening:**
  - Strict security headers (CSP, HSTS, nosniff, frame deny) and a CORS allowlist.
  - A 20 kb body limit.
  - `Cache-Control: no-store` on auth responses.
  - No stack traces are sent to clients.
- **Database:**
  - All access goes through Prisma (parameterised queries only).
  - TLS is on and the certificate is verified by default.
- **Sensitive data:**
  - Aadhaar and bank account numbers are stored AES-256-GCM encrypted (`DATA_ENCRYPTION_KEY`). Only the last 4 digits are kept in clear.
  - Duplicate Aadhaar is detected with a keyed HMAC, never the plain number.
  - Uploaded documents are encrypted in the database.
- **Uploads:**
  - Each file gets a one-time token and must be attached within 24 hours.
  - Uploads and registrations are rate-limited per IP.
- **Password reset:**
  - The e-mailed link carries a signed JWT that lasts 30 minutes, with its own audience so it can never be used as a login token.
  - The JWT holds a fingerprint of the current password hash, so the link stops working after one use or after any password change.
  - The link puts the token after `#`, so browsers never send it to servers or write it to logs.
  - The answer is the same (and takes the same time) whether the e-mail exists or not.
  - Requests are rate-limited per e-mail and per IP.
  - A reset logs the account out on every device.
- **Audit log:** `audit_logs` records logins, failures, lockouts, token reuse, logouts and password changes. It never stores secrets.

## Setup

The whole app runs from one database URL. Tables are created and updated **automatically on every deploy**: Vercel runs `prisma migrate deploy`, so no manual SQL is needed.

### Environment variables

Set these in Vercel → **nasoi-api** → Settings → Environment Variables. **Never commit them.**

| Key | Value |
|---|---|
| `DATABASE_URL` | Prisma Console → NASOI database → Connect → the **pooled** URL (`…@pooled.db.prisma.io:5432/postgres?sslmode=require`) |
| `JWT_SECRET` | The output of `openssl rand -base64 48` (already set) |
| `CORS_ORIGINS` | `https://nasoi-frontend.vercel.app` (already set) |
| `SMTP_HOST` / `SMTP_PORT` | SMTP server for e-mails (Nodemailer), e.g. `smtp.hostinger.com` / `465` or `smtp.gmail.com` / `587` |
| `SMTP_USER` / `SMTP_PASS` | SMTP login (for Gmail use an App Password) |
| `SMTP_FROM` | Sender, e.g. `NASOI <no-reply@yourdomain.com>` |
| `APP_URL` | Website URL used in e-mail links (default `https://nasoi-frontend.vercel.app`) |
| `DATA_ENCRYPTION_KEY` | The output of `openssl rand -base64 32`. **Keep a backup** — without it, encrypted Aadhaar, account numbers and documents cannot be read |
| `SEED_DEMO_USERS` | `true` creates the demo accounts on deploy; set it to `false` for real launch |
| `DIRECT_DATABASE_URL` | *(optional)* A direct, non-pooled URL used only for migrations |

### Database schema

- The schema is `prisma/schema.prisma`, with the tables `users`, `auth_sessions` and `audit_logs`.
- Migrations live in `prisma/migrations/`.
- To change the schema: edit `schema.prisma`, run `npm run db:migrate:dev -- --name <change>`, commit, and push. The next deploy applies the change.

### Local development

```bash
npm install
cp .env.example .env      # fill in the values
npm run db:generate
npm run db:migrate && npm run db:seed
npm run dev               # http://localhost:4000
npm test                  # integration tests (needs a Postgres in DATABASE_URL)
```

## Demo accounts

These are created by the seed. **Change or delete them before going live.**

| ID | Password | Role |
|---|---|---|
| DEO126 | Abcd@2026 | Data Entry Operator |
| VR101 | Abcd@2026 | Verifier |
| ADMIN | Admin@2026 | Super Admin |
