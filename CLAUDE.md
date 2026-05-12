@../CLAUDE.md

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
- **Tech:** Node.js, Express, Supabase (PostgreSQL), vanilla JS frontend
- **Deployment:** Render.com (auto-deploys on push to main)
- **Production URL:** https://paytrack.lemedspa.app

## Running Locally

```bash
npm run dev    # Starts server on port 3000 with --watch
```

Requires `.env` file with:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `PAYTRACK_ENCRYPTION_KEY` — **required** — AES-256-GCM key for onboarding sensitive fields; server exits on startup if missing. Generate once: `node scripts/generate-encryption-key.mjs`
- `RESEND_API_KEY` (optional — for invoice emails)
- `ADMIN_PASSWORD` (optional — defaults to hardcoded value)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (optional — for onboarding SMS links)

## Key Files

- `server.js` — Express API (all routes, Supabase client, pay period logic)
- `public/index.html` — Employee app (PIN login, time entry, pay review, invoice)
- `public/admin.html` — Admin panel (review entries, employees, reports)
- `supabase-schema.sql` — Database schema (paste into Supabase SQL Editor)
- `render.yaml` — Render deployment config

## Database

All data lives in Supabase PostgreSQL. Tables:
- `employees` — name, PIN, email, hourly_wage, pay_type (note: `006-flatten-employees.sql` flattened legacy structure)
- `time_entries` — date, hours, start/end times, breaks
- `client_entries` — patient services (linked to time_entry)
- `product_sales` — product commissions (linked to time_entry)
- `invoices` — submitted pay period invoices
- `worker_onboarding` (002–004) — self-onboarding flow with AES-256-GCM encrypted TIN/banking
- `tax_filings` (005) — 1099 prep + filing tracking
- `compliance_*` (007) — compliance scanner output (background job nightly)
- `plaid_*` (009/010) — bank-sync via Plaid (production, read-only against user accounts)

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

## Conventions

- No frameworks — plain Express + vanilla JS
- Direct Supabase client calls (no ORM)
- LA timezone for all date logic
- Pay period navigation uses offset from current period (0 = current, -1 = previous, etc.)

## Deployment

Render auto-deploys on push to `main`. Manual deploy:
```bash
git push origin main
# Wait ~2-3 min for Render to rebuild
```

Keep-alive ping runs every 14 minutes to prevent free tier spin-down.

## Environment Variables (Production)

Set in Render dashboard:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `RESEND_API_KEY`
- `ADMIN_PASSWORD`
- `PORT` (Render sets automatically)
- `RENDER_EXTERNAL_URL` (for keep-alive pings)
- `NODE_ENV=production`

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
