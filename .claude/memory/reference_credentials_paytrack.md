---
name: paytrack credentials
description: Systems accessed by paytrack (Express + Supabase employee time/payroll tracking app)
type: reference
status: active
created: 2026-05-22
maintains: Supabase, Plaid, Render, Resend, encryption, cron
---

# paytrack Credentials & Access Index

Systems accessed **only or primarily** by paytrack (Express backend + Supabase database for time tracking, pay periods, payroll). Workspace-level credentials (Tailscale, GitHub, Supabase Management API, etc.) are in `reference_credentials_workspace.md`.

**Maintenance rule:** Any new paytrack credential must be added here AND indexed in `reference_credentials.md` (the workspace index).

---

## Supabase (paytrack production)

Shared with lm-app and lemedia — same project but separate tables/schemas.

- **Project:** `lemedapp` / `skvsjcckissnyxcafwyr` (us-west-2, Postgres 17.6)
- **Env vars:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (paytrack API)
- **Paytrack tables:** `employees`, `timesheets`, `pay_periods`, `invoice_items`, `commissions`, `tips`, `product_sales`
- **Auth:** Service-role key for API operations (time entry validation, pay period logic)
- **Pre-authorized:** Query, mutations via service-role, schema inspection, dev DB migrations, storage buckets
- **Ask-first:** Migrations on production tables, dropping production tables, deleting buckets with data, rotating keys
- **Production timing:** 8pm–6am Pacific only
- **Last verified:** 2026-05-08

## Plaid (bank account linking)

- **Env vars:** `PLAID_CLIENT_ID` = `69fbbdaf8a7a05000d309947`, `PLAID_SECRET` = `80e8faa53101959d17896f73a1fe79`, `PLAID_ENV` = `production`
- **Location:** Render env vars (service `srv-d632r5m8alac73cbqubg`), local `.env` for dev
- **Used by:** `paytrack/routes/plaid.js`, `paytrack/server/plaid-client.js` — bank account linking via OAuth (Chase, etc.)
- **Pre-authorized:** Query transactions, create link tokens, exchange public tokens
- **Ask-first:** Nothing — all operations are read-only against user's own bank data
- **Last verified:** 2026-05-08

## Render (paytrack deployment)

- **Env var:** `RENDER_API_KEY` = `rnd_shx6CiwhNgEa8ZGfzvpdiR23f5zJ`
- **Service:** paytrack API deployed on Render.com (auto-deploys on push to main)
- **Pre-authorized:** Query services/deploys, trigger manual deploys, query env vars/logs
- **Ask-first:** Deleting services, modifying production env vars, suspending services
- **Last verified:** 2026-04-13

## Resend (transactional email)

- **Send-only key:** env var `RESEND_API_KEY` (set in paytrack `.env`)
- **Used for:** Invoice delivery, pay period notifications
- **Domain:** `lemedspa.com` (shared with lm-app)
- **Pre-authorized:** Send test emails to Mike only, query email logs
- **Ask-first:** Sending to anyone other than Mike, rotating keys
- **Last verified:** 2026-04-16

## PayTrack Encryption Key

- **Purpose:** AES-256-GCM encryption of onboarding sensitive fields (`tin_encrypted`, `bank_routing_encrypted`, `bank_account_encrypted`)
- **Env var:** `PAYTRACK_ENCRYPTION_KEY` — base64-encoded 32 bytes
- **Location:** Render env vars (service `srv-d632r5m8alac73cbqubg`) + local `paytrack/.env` for dev
- **Generation:** `node paytrack/scripts/generate-encryption-key.mjs` (run once; DO NOT commit output)
- **Startup guard:** `server.js` calls `process.exit(1)` if env var missing or key decodes to != 32 bytes
- **Rotation procedure:** Generate new key → set in Render → run one-time re-encryption migration → remove old key (zero rows at first deploy; rotation applies to future cycles)
- **Pre-authorized:** Use for encrypting/decrypting onboarding data. Read from Render env vars. No key rotation without first backing up old key.
- **Ask-first:** Rotating the key (irreversible if existing rows not re-encrypted first)
- **Last verified:** 2026-04-15 (set in Render env vars, 70+23 tests pass)

## Cron Secret

- **Env var:** `CRON_SECRET` = `9e67ea4d103c33e5a03a37759bccc7f2`
- **Purpose:** Authenticates cron/scheduler HTTP calls to paytrack API endpoints (Authorization header)
- **Used by:** pg_cron jobs that trigger paytrack sync/batch operations
- **Pre-authorized:** Use in cron job commands, read from env vars
- **Ask-first:** Rotating the secret (must update cron job commands atomically across all jobs)
- **Last verified:** 2026-04-13

## Admin Login

- **Env var:** `PAYTRACK_ADMIN_PASSWORD` — gates the paytrack admin UI/API (value in Render env vars + local `.env`, not stored here)
- **Used by:** Admin authentication middleware on protected paytrack routes
- **Pre-authorized:** Read from env for local admin access
- **Ask-first:** Rotating the password (update Render env + notify any admin consumers)
- **Last verified:** 2026-05-29

---

## Related files

- `reference_credentials_workspace.md` — shared systems (Tailscale, NAS, GitHub, etc.)
- `reference_credentials_lm-app.md` — lm-app-specific (Twilio, Stripe, TextMagic, etc.)
- `reference_credentials_lm-mobile.md` — lm-mobile-specific (Expo, EAS, TestingBot, Apple, etc.)
- `reference_credentials_lemedia.md` — lemedia-specific (Cloudinary, etc.)
- `reference_credentials_discord-bot.md` — discord-bot-specific
- `reference_credentials_lemedspa-website.md` — website-specific
- `reference_credentials.md` — workspace index
