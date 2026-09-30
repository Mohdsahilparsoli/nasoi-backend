# NASOI Backend API

REST API for the **NASOI School Data Entry Portal**, built with Node.js, Express 5, and PostgreSQL (Supabase).
It is deployed to Vercel as a separate project from the Next.js frontend.

This first module is **Login / Auth**. The other modules (registration, assignments, entries, verification, payouts) will be added one by one.

## Endpoints (v1)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/v1/health` | – | API and database status |
| POST | `/api/v1/auth/login` | – | `{ loginId, password }` → `{ user, accessToken, expiresIn }` and the refresh cookie. The role is taken from the account. |
| POST | `/api/v1/auth/refresh` | refresh cookie | `{ role }` → new access token. The refresh token is rotated. |
| POST | `/api/v1/auth/logout` | refresh cookie | `{ role }` → revokes the session |
| GET  | `/api/v1/auth/me` | Bearer | The current user |
| POST | `/api/v1/auth/change-password` | Bearer | `{ currentPassword, newPassword }` → logs out all other devices |

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
  - Helmet headers and CORS allowlist.
  - A 20 kb body limit.
  - `Cache-Control: no-store` on auth responses.
  - No stack traces are sent to clients.
- **Database:**
  - Only parameterised SQL is used.
  - Row Level Security is on and access is revoked for Supabase's `anon` and `authenticated` roles, so the public Supabase REST API cannot read these tables.
- **Audit log:** `audit_logs` records logins, failures, lockouts, token reuse, logouts and password changes. It never stores secrets.

## Setup

### 1. Database (one time)

In Supabase, open **SQL Editor**, paste the contents of `db/SUPABASE_SETUP.sql`, and click **Run**.
This creates the `users`, `auth_sessions` and `audit_logs` tables and the demo accounts. It is safe to re-run.

### 2. Environment variables

Set these in Vercel → Project → Settings → Environment Variables. **Never commit them.**

| Key | Value |
|---|---|
| `DATABASE_URL` | Supabase → Connect → **Transaction pooler** URI (port 6543), with your DB password |
| `JWT_SECRET` | The output of `openssl rand -base64 48` |
| `CORS_ORIGINS` | `https://nasoi-frontend.vercel.app` (comma-separate any extra origins) |
| `DATABASE_SSL_CA` | *(optional)* The Supabase root certificate (PEM), for full certificate verification |

### 3. Local development

```bash
npm install
cp .env.example .env      # fill in the values
npm run db:migrate -- --seed
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
