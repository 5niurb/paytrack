@../CLAUDE.md
@../AIT/memory/shared/reference_credentials_workspace.md
@./.claude/memory/reference_credentials_paytrack.md

# CLAUDE.md — paytrack (LM PayTrack)

## Session Management

### Starting a Session
- Read `SESSION_NOTES.md` first to restore context from previous sessions.
- Briefly confirm what you understand the current state to be before diving in.

### During a Session
- After completing each major task or milestone, append an update to `SESSION_NOTES.md`.
- Every ~15 minutes of active work, checkpoint progress to `SESSION_NOTES.md`.
- After implementing any new feature, design change, or component, update `SPECS.md` with the requirement, acceptance criteria, and any design decisions made. (Use `/capture-specs` to batch-update at session end if preferred.)
- If the conversation is getting long (50+ exchanges), proactively write a summary and suggest starting a fresh session.

### Ending a Session
- Always write a final summary to `SESSION_NOTES.md` before the session ends, including:
  - What was accomplished
  - Current state and what's working
  - Known issues or bugs
  - Recommended next steps
  - Dev server port and access URLs if running

---

## What This Is

Employee time & payroll tracking PWA for Le Med Spa staff.
- **App name:** LM PayTrack
- **Repo:** github.com/5niurb/paytrack
- **Tech:** Node.js (v22), Express, Supabase (PostgreSQL), vanilla JS frontend (no build step, no framework)
- **Deployment:** Fly.io (app `lm-paytrack`, region `sjc`) as of 2026-05-30 — see the Deployment section below. (Migrated off Render; the Render service still exists but is out of the traffic path.)
- **Production URL:** https://paytrack.lemedspa.app

## Running Locally

```bash
npm run dev    # = `node server.js` — no watcher; restart manually after edits
npm start      # same thing (production entrypoint)
npm test       # runs the full suite via test/run-all.mjs (see Testing)
```

Server listens on `process.env.PORT || 3000` locally (Fly injects `PORT=8080` in prod).

Requires `.env` file with:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `PAYTRACK_ENCRYPTION_KEY` — **required** — AES-256-GCM key for onboarding sensitive fields; server exits on startup if missing. Generate once: `node scripts/generate-encryption-key.mjs`
- `RESEND_API_KEY` (optional — for invoice emails)
- `ADMIN_PASSWORD` (optional — defaults to hardcoded value)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (optional — for onboarding SMS links)
- `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (optional — for bank sync)
- `SENTRY_DSN` (optional — error tracking; no-ops if unset)
- `SUPABASE_SERVICE_ROLE_KEY` (for storage/file uploads)

## Key Files & Layout

Server (Express + Supabase, no ORM):
- `server.js` — main Express app: middleware, most API routes, Supabase client, startup guards (~2900 lines; the large one to grep)
- `lib/` — pure, unit-tested helpers extracted from `server.js`:
  - `pay-periods.js` — 26-period-per-year date logic (LA timezone)
  - `crypto.js` — AES-256-GCM encrypt/decrypt for onboarding PII
  - `health.js` — health-report builder (liveness vs deep DB probe)
  - `onboarding-validation.js` — server-side onboarding form validation (also shared with tests)
  - `compliance-tokens.js`, `compliance-scan.mjs`, `compliance-notifications.mjs` — compliance job pieces
  - `debug.js` — DEBUG-gated logging
- `routes/` — modular route sub-apps mounted in `server.js`:
  - `compliance.js` → `/api/compliance` (init'd via `initCompliance`)
  - `plaid.js` → `/api/admin/plaid` (init'd via `initPlaid`)
- `server/` — Plaid clients: `plaid-client.js`, `plaid-sync.js`

Frontend (`public/`, served statically, no bundler):
- `index.html` + `js/index.js` + `css/index.css` — Employee app (PIN login, time entry, pay review, invoice)
- `admin.html` + `js/admin.js` + `css/admin.css` — Admin panel (large — most admin logic lives in `js/admin.js`)
- `onboarding.html` — self-onboarding flow
- `review.html` — pay review / invoice review page
- `compliance.html` — compliance scanner dashboard
- `sw.js`, `manifest.json`, `icon*.{svg,png}` — PWA shell

Data & config:
- `supabase-schema.sql` — base database schema (paste into Supabase SQL Editor)
- `migrations/` — numbered incremental migrations (`002`–`010`); apply in order
- `fly.toml`, `Dockerfile` — Fly.io deployment
- `render.yaml` — legacy Render config (out of traffic path; kept for reference)
- `test/` — Node test suites; `.github/workflows/ci.yml` — CI

## Database

All data lives in Supabase PostgreSQL. Tables:
- `employees` — name, PIN, email, hourly_wage, pay_type (note: `006-flatten-employees.sql` flattened legacy structure)
- `time_entries` — date, hours, start/end times, breaks
- `client_entries` — patient services (linked to time_entry)
- `product_sales` — product commissions (linked to time_entry)
- `invoices` — submitted pay period invoices
- `employee_onboarding` (002–004) — self-onboarding flow with AES-256-GCM encrypted TIN/banking
- `employee_documents`, `compliance_documents`, `compliance_requests` (007/008) — compliance scanner output & COI/license tracking
- `tax_filings` (005) — 1099 prep + filing tracking
- `plaid_pending` / `plaid_*` (009/010) — bank-sync via Plaid (production, read-only against user accounts)
- `app_settings` — key/value app config

Schema is layered: `supabase-schema.sql` is the base; subsequent changes live as numbered files in `migrations/` (currently `002-worker-onboarding.sql` through `010_plaid_fixes.sql`). Apply in numeric order via Supabase SQL Editor or the `/migrate` skill.

## Pay Periods

26 pay periods per year:
- **1st–15th** of each month
- **16th–end** of each month

All dates use Los Angeles timezone (`America/Los_Angeles`).

## Features

### Employee App (`/`)
- PIN-based login (4 digits)
- Two tabs: **Daily Entry** (time + services + sales) and **Pay Review** (period summary)
- Invoice preview with daily breakdown
- Delete entries from Pay Review tab

### Admin Panel (`/admin`)
- **Review Entries** — Pay period navigation with arrows, employee filter, daily breakdown table
- **Team Members** — Add/edit/delete team members, set pay type and hourly wage
- **Reports** — Date range reports with earnings by team member

### Onboarding (`/onboarding`)
- Self-onboarding flow for new team members (SMS/email link from admin)
- Encrypted fields (TIN, bank routing/account) via `PAYTRACK_ENCRYPTION_KEY`
- Conditional license/insurance fields for clinical titles

### Compliance (`/compliance`)
- Compliance scanner dashboard (license expirations, insurance COI, tax docs)
- Background job: `com.lemed.compliance-scanner` (daily 11pm — see workspace CLAUDE.md)
- Contractor-facing email/SMS is **gated OFF** by `COMPLIANCE_CONTACT_ENABLED` (kill-switch) until Mike says go-live

### Bank Sync (Plaid) — admin only
- `routes/plaid.js` (`/api/admin/plaid`) + `server/plaid-client.js`, `server/plaid-sync.js`
- Read-only against the user's own Chase account; admin assigns synced transactions to workers/payments
- Tables: `plaid_*` (migrations `009`/`010`)

### Tax Filings & Payments (admin)
- 1099 prep + filing tracking (`tax_filings`, migration `005`), CSV export by year
- Manual payment records assignable to workers (`/api/admin/payments`)

## Conventions

- No frameworks, no build step — plain Express + vanilla JS (frontend served straight from `public/`)
- Direct Supabase client calls (no ORM)
- LA timezone for all date logic
- Pay period navigation uses offset from current period (0 = current, -1 = previous, etc.)
- **Admin auth:** every admin/plaid/compliance route reads the `x-admin-password` request header (standardized 2026-06 — the legacy `password` header fallback was removed). The login POST body to `/api/admin/verify` still uses `{ password }`. Password compare is timing-safe (`crypto.timingSafeEqual`).
- **Middleware order in `server.js`:** `compression` → CORS allowlist (`paytrack.lemedspa.app`, `lemedspa.app`, `api.lemedspa.app`, localhost) → `express.json` → static (`maxAge 1d` + ETag) → `no-store` on all `/api/` responses (payroll/PII must never be cached).
- **Rate limiting:** `express-rate-limit` on admin routes (100 req/15min) and PIN routes; `trust proxy` is set to `1` (single reverse proxy). Rate-limit responses return JSON, not plain text (a plain-string 429 once broke a client `resp.json()`).
- **Extract → test:** pull pure logic out of `server.js` into `lib/` so it can be unit-tested without booting Express (see `lib/health.js`, `lib/pay-periods.js`, `lib/crypto.js`).

## Testing & CI

- Run everything with `npm test` (→ `test/run-all.mjs`). The runner executes every `test/*.test.js` file **in its own process**, continues past failures, and exits non-zero if any suite fails.
- Suites: `crypto`, `validation`, `health`, `pay-periods` logic, `compliance-tokens`, `compliance-routes`, `plaid-client`, `plaid-sync`, `integration-mocks`. Tests use Node's built-in test facilities — no external test framework, no live Supabase.
- **CI** (`.github/workflows/ci.yml`, Node 22) on push/PR to `main`: `npm ci` → `node -c server.js` (syntax check) → `npm test`. On merge to `main` it also runs a non-blocking production health smoke check against `/api/health`.
- After a `git push`, the `ci-check` hook polls GitHub Actions and reports pass/fail so failures can be fixed immediately.

## Deployment

**Fly.io as of 2026-05-30** (migrated off Render — workspace hit Render's shared 750 free-instance-hours/month cap; the 2 zombie lm-app-api Render services were the main culprit and were deleted). App: `lm-paytrack` (region `sjc`).

**Always-on, single machine** (changed from the original sleep-when-idle config): `fly.toml` now sets `auto_stop_machines = "off"` and `min_machines_running = 1` so daily time entry never hits a cold start. One `shared-cpu-1x:512MB` machine running 24/7 ≈ $3.19/mo — under Fly's ~$5/mo invoice waiver, so effectively free AND always warm. **Do not** add a second machine (no HA pair) or bump RAM — either would push past the free threshold. Internal port is **8080** (`http_service.internal_port`). Fly's health check hits `/api/health?deep=0` (liveness only — a DB blip must not restart the machine).

```bash
cd paytrack && fly deploy -a lm-paytrack    # token: grep access_token ~/.fly/config.yml; pass -t
```

**Routing:** `paytrack.lemedspa.app` → Cloudflare Worker `paytrack-proxy` (custom-domain bound) → `https://lm-paytrack.fly.dev`. The Worker's `ORIGIN` const (in `lmdev/paytrack-proxy/worker.js`) is the cutover point — change it + redeploy the worker to repoint. NO direct DNS record edits (the host is Worker-managed/read-only in Cloudflare).

**Render:** `LM-PayTrack` service still EXISTS on Render (left in place per Mike 2026-05-30, "leave render alone until we have a reason to tear it down") but is OUT of the traffic path. Don't push-deploy it. Config files (`fly.toml`, `Dockerfile`) live in the paytrack repo.

## Environment Variables (Production)

Set as Fly secrets on `lm-paytrack` (migrated from Render 2026-05-30; values also still in Render service `srv-d632r5m8alac73cbqubg`). Manage with `fly secrets set KEY=value -a lm-paytrack`:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `PAYTRACK_ENCRYPTION_KEY`
- `RESEND_API_KEY`
- `ADMIN_PASSWORD`
- `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `SENTRY_DSN` (error tracking)
- `CRON_SECRET` (authenticates scheduler HTTP calls)
- `COMPLIANCE_CONTACT_ENABLED` — **currently UNSET/OFF**; gates ALL contractor email/SMS. Do not enable without Mike's go-live (see `reference_credentials_paytrack.md`).
- `PORT` (Fly injects `8080` automatically), `NODE_ENV=production`

Note: the old Render `RENDER_EXTERNAL_URL` keep-alive ping was removed (dead code deleted 2026-06). The `server/render-api.js` env-var-write-back helper (used only by the old Render-hosted Plaid cursor persistence) was removed 2026-07 — Plaid state persists to Supabase via `saveSetting` only now.

## Email

**Invoice emails** sent via Resend:
- **From:** `paytrack@lemedspa.com`
- **To:** `lea@lemedspa.com`, `ops@lemedspa.com`
- **CC:** Employee email (if set)

**Onboarding link emails** sent via Resend:
- **From:** `ops@lemedspa.com`
- **To:** Team member email
- **CC:** `lea@lemedspa.com`
- **Subject:** "LeMed Spa — New Team Member Onboarding"

**Onboarding link SMS** sent via Twilio:
- **From:** `+12134442242`
- **To:** Team member mobile phone

## Claude Code Automations

### Skills (`.claude/skills/`)
- **`/commit`** — Stage, commit, push with formatted message
- **`/deploy`** — Push to main and verify Render deployment
- **`/capture-specs`** — Reviews current session and batch-updates SPECS.md with new requirements, acceptance criteria, and design decisions
- **`/checkpoint`** — Git-backed save points. Supports `create`, `list`, `restore <sha>`. Auto-checkpoints before restore
- **`/orchestrate`** — Chains agents through dev pipeline: plan → implement → review → qa → verify. Supports `feature`, `bugfix`, `refactor` modes. Final verdict: SHIP/NEEDS WORK/BLOCKED
- **`/api-design`** — Interactive API specification and endpoint planning with request/response examples
- **`/postgres-patterns`** — Analyzes and documents PostgreSQL query patterns, indexes, and optimization opportunities
- **`/database-migrations`** — Generates and verifies schema migrations with rollback safety checks
- **`/security-review`** — Scans for OWASP Top 10 vulnerabilities, secret leakage, and auth bypass risks
- **`/strategic-compact`** — Evaluates when to compact context, creates recovery snapshots, and restores session state
- **`/continuous-learning-v2`** — Extracts production errors and API quirks from logs, updates SKILL.md Learnings sections to prevent recurrence

### Agents (inherited from workspace — `.claude/agents/`)
- **`code-reviewer`** — Zero-context code review with severity tiers (Info/Warning/Error) and PASS/FAIL verdict. Model: Sonnet
- **`qa`** — Generates tests, executes them across multiple languages (Python/JS/Bash), reports pass/fail. Model: Sonnet
- **`research`** — Deep investigation via web search and codebase exploration. Returns concise sourced findings. Model: Sonnet
- **`architect`** — Read-only system design analysis. Evaluates scalability, trade-offs, and integration impact. Model: Opus
- **`build-error-resolver`** — Minimal-diff build fixes. No refactoring — just fixes compilation errors. Model: Sonnet
- **`database-reviewer`** — PostgreSQL/Supabase specialist. Flags SELECT *, unindexed FKs, missing RLS, OFFSET pagination, N+1 queries. Model: Sonnet
- **`deploy-verifier`** — Post-deploy health checks: site loads, CORS headers, no localhost in bundles, API health endpoints. Model: Sonnet
- **`email-classifier`** — Classifies emails into Action Required / Waiting On / Reference. Adapted for M365/Outlook. Model: Sonnet
- **`planner`** — Breaks down features into milestones and implementation steps with effort estimates. Model: Sonnet
- **`security-reviewer`** — OWASP Top 10 analysis, secret detection, XSS/SQL injection/auth bypass checks. Auto-triggers on auth/payment/PII code. Model: Opus

### Inherited from Workspace
- **Prettier auto-format** hook — Formats JS/HTML/CSS on every edit
- **`.env` blocker** hook — Prevents accidental edits to sensitive files
- **CI & Deploy Check** hook — After `git push`: polls GitHub Actions (up to 3min), reports pass/fail with failure logs so Claude can fix immediately. Non-blocking. Script: `.claude/scripts/post-push-ci-check.mjs`
- **Observe** hooks — SessionStart hook loads previous session state from memory; Stop hook persists context before exit
- **Strategic Compact** hook — Evaluates context saturation, creates recovery snapshots before compaction, auto-restores branch/session state on reentry

## Recent Changes

- **2026-06-11:** Fixed admin rate limiter breaking bank-transaction assign — bumped admin limit 10→100 req/15min, made 429 responses JSON, hardened `adminFetch()` to check `resp.ok` and surface real error messages.
- **2026-06-02/07:** Standardized admin auth on the `x-admin-password` header across `server.js`, `routes/compliance.js`, `routes/plaid.js` and all 24 frontend admin fetches; removed the legacy `password` header fallback. Deployed + verified live.
- **2026-06:** Resilience pass — enhanced `/api/health` (liveness vs deep DB probe, extracted to `lib/health.js`), added Sentry (`SENTRY_DSN`-gated), CI workflow + production health smoke check, uptime monitor; removed dead Render keep-alive code.
- **2026-05-30:** Made the Fly machine always-warm — `auto_stop_machines = off`, `min_machines_running = 1` (no cold starts for daily time entry).
- **2026-05-30:** Migrated deployment Render → Fly.io (`lm-paytrack`, `sjc`); routing via Cloudflare Worker `paytrack-proxy`.
- **2026-05-29:** Performance pass — added `compression` (gzip) + HTTP cache-control/ETag headers; eliminated 5 N+1 query patterns (pre-fetch `.in()` + group-by-id) across pay-period summary, invoice email, admin review, admin time-entries, and employee-removal cleanup. All 179 tests pass.
- **2026-05:** Plaid bank sync (Chase, read-only) for admin transaction assignment; compliance COI/license workflow + contractor-contact kill-switch (`COMPLIANCE_CONTACT_ENABLED`, default OFF).
- **2026-05:** Frontend split out of inline HTML into `public/js/{index,admin}.js` + `public/css/{index,admin}.css`; added `review.html` and `compliance.html`.
- **2026-04-16:** Renamed "Employees" → "Team Members" throughout entire app
- **2026-04-16:** Pre-form overlay for adding team members (replaces inline form), auto-generated PIN
- **2026-04-16:** Send Link feature: SMS (Twilio) + Email (Resend) for onboarding links
- **2026-04-16:** Onboarding form Round 2: merged sections, conditional license/insurance for clinical titles, blur validation, phone auto-format, TIN format validation
- **2026-04-16:** Resend domain swapped: `updates.lemedspa.com` → `lemedspa.com`
- **2026-04-16:** `SUPABASE_SERVICE_ROLE_KEY` set on Render for file uploads
- **2026-04-15:** Worker self-onboarding system with AES-256-GCM encryption
- Migrated from SQLite to Supabase PostgreSQL
- Admin Review Entries tab with pay period navigation
- Employee Pay Review tab with delete functionality
- LA timezone sync for all dates
