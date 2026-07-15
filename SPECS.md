# SPECS.md — LM PayTrack (Timetracker)

> **Auto-maintained by Claude.** Updated after each feature, design change, or component implementation.
> Detailed enough to rebuild the entire app from scratch.

---

## Architecture Overview

| Layer | Tech | Deployment |
|-------|------|-----------|
| Frontend | Vanilla HTML/CSS/JS (PWA) | Render.com (served by Express) |
| Backend | Express.js (Node.js) | Render.com (auto-deploy on push) |
| Database | Supabase PostgreSQL | Supabase hosted |
| Email | Resend API | Transactional invoices |
| Auth | PIN-based (employees), Password (admin) | — |

---

## Employee App (`/`)

### Login

**Purpose:** 4-digit PIN entry for employee authentication.

**Acceptance Criteria:**
- [ ] 4-digit PIN validated against `employees.pin`
- [ ] Invalid PIN shows error
- [ ] Successful login loads main app with employee context
- [ ] Employee can change PIN from within app
- [ ] Rate limiting: per-IP limiter (10 attempts / 15 min) on verify-pin + change-pin
- [ ] Per-account lockout (2026-07): 5 consecutive failed attempts against one employee
      (via change-pin's claimed employeeId) → 15-min lockout for that account, independent
      of IP. Successful auth clears the counter. Messages stay generic — a locked account
      given the correct PIN gets the same "Invalid PIN" response (no lock-state oracle).
      Table: `pin_lockouts` (migration 011); logic: `lib/pin-lockout.js`.

---

### Pay Entry Tab

**Purpose:** Daily time and earnings logging.

**Components:**
- Date picker (scrollable wheel, limited to past dates only)
- Start/end time inputs with automatic hour calculation
- Break time input (minutes, deducted from total)
- Service entries: patient name, procedure, amount earned, tip amount
- Sales entries: product name, sale amount, commission (percentage or flat toggle)
- Duplicate date detection with override modal

**Acceptance Criteria:**
- [ ] Date wheel only allows past dates
- [ ] Hours auto-calculate from start/end times minus breaks
- [ ] Service entries capture patient, procedure, earnings, tips
- [ ] Sales entries toggle between percentage and flat commission
- [ ] Duplicate date detected → override confirmation modal
- [ ] Save persists all data to Supabase

---

### Pay Review Tab

**Purpose:** Summary of current pay period with invoice generation.

**Components:**
- Pay period navigation (arrows: previous/next, label shows 1st-15th or 16th-end)
- Summary stats cards: Hours, Wages, Commissions, Tips, Total Payable
- Daily breakdown table (expandable, delete per entry)
- Generate Invoice button → Preview modal → Confirm & Submit

**Pay Period Logic:**
- Period 1: 1st–15th of each month
- Period 2: 16th–last day of month
- Navigation arrows move between periods

**Invoice Flow:**
1. Click "Generate Invoice"
2. Preview modal shows daily breakdown + totals
3. Confirm → Email sent via Resend to:
   - TO: lea@lemedspa.com, ops@lemedspa.com
   - CC: Employee email
4. Invoice record saved to `invoices` table
5. Cannot submit same period twice

**Acceptance Criteria:**
- [ ] Period navigation shows correct date ranges
- [ ] Summary stats match individual entries
- [ ] Daily breakdown accurate (hours, wages, commissions, tips)
- [ ] Delete entry removes from database + updates totals
- [ ] Invoice preview shows all line items
- [ ] Email sent on submit (HTML formatted)
- [ ] Double-submit prevented

---

## Admin Panel (`/admin`)

### Login

- Admin password verification (single shared password)
- Not PIN-based (separate from employee auth)

---

### Review Entries Tab

**Purpose:** View and manage all employee time entries by pay period.

**Components:**
- Pay period navigation (arrows)
- Employee filter dropdown
- Daily entries table with details modal
- Delete individual entries

**Acceptance Criteria:**
- [ ] Navigate pay periods with arrows
- [ ] Filter by employee or show all
- [ ] Click entry → details modal (earnings breakdown)
- [ ] Delete entries with confirmation
- [ ] Current/previous/future period labels

---

### Team Members Tab (formerly "Employees")

**Purpose:** Staff management — add, edit, delete team members.

**Components:**
- Team member table: Name (with email below), PIN, Job Title, Job Type, Pay Rate, Response Form status, Actions
- "Add New Team Member" button → full-screen pre-form overlay
- Edit/delete actions per row
- Row spacing: 18px padding, 1.5 line-height

**Pre-Form (Add New Team Member):**

Full-screen overlay (onboarding-form styled) with:
- Personal & Contact Info: First Name, Last Name, Email, Mobile Phone (auto-format `(###) ###-####`)
- Job Info: Job Title (dropdown: 8 titles), Job Type (Contract/Full-time), Pay Components (checkboxes), Pay Rate, Additional Pay Rate, Comments
- Start Date (optional, approximate)
- PIN auto-generated (random 4-digit) on creation — not in pre-form

**Job Titles:** Esthetician, Aesthetic Nurse, Aesthetic Nurse Practitioner, Physician, Front Desk, Office Manager, Marketing, Other

**Job Types:** Contract, Full-time

**Send Link Modal (post-creation):**

After creating team member, shows:
- Response Form link (copyable)
- "Send via SMS" button → preview → confirm (sends via Twilio from +12134442242)
- "Send via Email" button → preview → confirm (sends via Resend from ops@lemedspa.com, CC lea@lemedspa.com)
- "Done" button → refreshes team members list

**Pay Types (checkbox combinations):**

| Pay Type | Hourly | Service Commissions | Sales Commissions |
|----------|--------|--------------------|--------------------|
| `hourly` | ✓ | | |
| `commission` | | ✓ and/or ✓ | |
| `hourly_services` | ✓ | ✓ | |
| `hourly_sales` | ✓ | | ✓ |
| `hourly_all` | ✓ | ✓ | ✓ |

**Acceptance Criteria:**
- [ ] "Add New Team Member" button opens full-screen pre-form overlay
- [ ] Pre-form validates required fields (first name, last name, email)
- [ ] Phone auto-formats as `(###) ###-####` on input
- [ ] PIN auto-generated (4-digit random) on creation
- [ ] After creation: send link modal with SMS/Email options
- [ ] SMS sends via Twilio REST API
- [ ] Email sends via Resend with approved "LeMed Spa family" verbiage
- [ ] Edit modal: split first/last name, job title dropdown, job type dropdown
- [ ] Delete with confirmation (prevents accidental removal)
- [ ] All labels say "Team Member" (not "Employee")

---

### Reports Tab

**Purpose:** Earnings analytics across employees and date ranges.

**Components:**
- Date range picker (start/end)
- Grand total stats cards
- Per-employee breakdown: hours, wages, commissions, tips, tips owed

**Acceptance Criteria:**
- [ ] Date range filters data correctly
- [ ] Grand totals match sum of employee breakdowns
- [ ] Tips owed = total tips - cash tips already received
- [ ] Per-employee rows show all earning components

---

## Worker Response Form (`/onboarding/:token`)

### Overview

Token-gated public form for workers to submit their own information. Replaces manual data collection. Admin generates a unique per-employee link; worker fills in and submits the form; admin reviews via the Team Members tab.

### User Flows

**Admin flow:**
1. Creates team member via Team Members tab → server auto-generates `review_token` (UUID v4)
2. Response Form link displayed in success banner after adding team member
3. Team Members tab shows per-employee status: Pending (token exists, not submitted) / Complete (with date + "View Details" button) / — (no token)
4. Admin can view submitted data via "View Details" → modal with all fields (sensitive fields show last 4 only)

**Worker flow:**
1. Receives link `https://paytrack.lemedspa.app/onboarding/<uuid>`
2. 8-section form rendered with dark + gold PayTrack styling
3. Fills out all sections (see below)
4. Submits → success screen replaces form (non-reversible, no back button)
5. Already-submitted tokens show graceful "already received" message

### Form Sections

1. **Personal & Contact Information** — First name (required, blur-validated), last name (required, blur-validated), date of birth (required, ≥18), home phone, mobile phone (required, auto-format `(###) ###-####`, blur-validated), email (blur-validated), address subsection: street (required), city (required), state (CA preselected, 2-char US allowlist), ZIP (required, 5 or 9 digits, blur-validated)
2. **Tax (W-9)** — TIN type (SSN/EIN), TIN number (standard text input with format validation based on type), W-9 tax classification (with Business/Entity Name hint below input), W-9 signature date
3. **Drivers License / Government ID** — DL/ID number, state, expiry (must be future if provided)
4. **Professional License** *(clinical titles only: Esthetician, Aesthetic Nurse, Aesthetic Nurse Practitioner, Physician)* — Dynamic license entries with: license type, number, state, expiry (must be future), verification URL (required, with DCA guidance text), optional file upload per entry. Add/remove license entries.
5. **Insurance** *(clinical titles only)* — Company, policy number, expiry, per-occurrence coverage amount (required), aggregate coverage amount (required)
6. **Payment Information** — Bank name (required), account owner name (required). "Preferred Payment Method" radio: **Zelle** or **ACH**. Zelle contact field (required when Zelle). ACH: account type + routing + account number (required when ACH). Routing/account numbers NOT stored for Zelle.
7. **Contract Details** — Pre-filled job info grid (job title, job type, pay components, pay rate, additional pay rate from admin pre-form), time commitment bucket, other commitments, comments (full-width textarea)
8. **Acknowledgment & Attestation** — IC agreement version display, checkbox certification (required), typed signature (required), date (required)

### Sensitive Field Handling

- SSN/EIN: `type="password"` with 👁/🙈 reveal toggle. Shown as `***-**-XXXX` after blur.
- Routing/account numbers: Same `type="password"` treatment.
- Server never logs raw values. Database stores `*_encrypted` column (AES-256-GCM ciphertext) + `*_last4` masked value always stored.
- Admin modal shows only `*_last4` values (e.g., `*****6789`).

### Encryption

**Algorithm:** AES-256-GCM (authenticated encryption — detects tampering).

**Ciphertext encoding:** `base64(IV(12 bytes) || authTag(16 bytes) || ciphertext(N bytes))` stored in TEXT columns.

**Encrypted columns:** `tin_encrypted`, `bank_routing_encrypted`, `bank_account_encrypted`.

**Key location:** `PAYTRACK_ENCRYPTION_KEY` env var — base64-encoded 32 bytes. Set in Render env vars. Never committed to git.

**Key generation:** `node scripts/generate-encryption-key.mjs` — run once, set in Render and local `.env`.

**Startup check:** Server calls `process.exit(1)` on startup if `PAYTRACK_ENCRYPTION_KEY` is missing or decodes to a length other than 32 bytes.

**Decrypt path:** `lib/crypto.js` `decryptValue()` — used by future 1099 export workflow. Admin "View Details" modal shows only `*_last4` and never calls `decryptValue`.

**Key rotation procedure:** Generate new key → set in Render env vars → run a one-time migration script to re-encrypt all existing rows with the new key → remove old key. (No rows exist as of first deploy; this procedure applies to future rotations.)

**Library:** Node built-in `crypto` module (`createCipheriv`/`createDecipheriv`). No added dependencies.

### Validation (client + server)

| Field | Rule |
|-------|------|
| SSN | `/^\d{3}-\d{2}-\d{4}$/` |
| EIN | `/^\d{2}-\d{7}$/` |
| ZIP | 5 digits or 9 digits (with or without dash) |
| Phone | ≥10 digits when stripped of formatting, ≤15. Mobile phone required. |
| State | 2-char uppercase allowlist (50 states + DC) |
| Bank routing | 9 digits + ABA checksum: `(3*(d1+d4+d7) + 7*(d2+d5+d8) + (d3+d6+d9)) % 10 === 0` |
| Bank account | 4–17 digits |
| Date of birth | Past date, worker must be ≥18 years old |
| License/insurance expiration | Must be strictly future if provided |
| Attestation | Checkbox required, typed signature required, date required |
| Time commitment bucket | One of under_15, 15_to_25, 25_to_35, over_35 (required) |
| Payment method | zelle or ach only (required); other values rejected |
| Routing + account | Required when payment_method=ach; ignored (not stored) when zelle |
| Zelle contact | Required when payment_method=zelle |

### API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/onboarding/:token` | None (token validates) | Render onboarding form |
| POST | `/api/onboarding/:token` | None (token validates) | Submit onboarding data |
| GET | `/api/admin/employees/:id/onboarding` | Admin password header | Fetch submitted data (masked) |
| POST | `/api/admin/employees/:id/onboarding-token` | Admin password header | Regenerate token |
| POST | `/api/admin/employees/:id/send-link` | Admin password header | Send onboarding link via SMS or email |

### Database Changes

**`employees` table — 8 new columns:**

| Column | Type | Purpose |
|--------|------|---------|
| `phone` | TEXT | Primary phone |
| `designation` | TEXT | Job title/role |
| `contractor_type` | TEXT | Classification (W-2/1099) |
| `start_date` | DATE | Employment start |
| `ic_agreement_signed` | BOOLEAN | IC agreement accepted |
| `ic_agreement_signed_at` | TIMESTAMPTZ | When signed |
| `review_token` | TEXT UNIQUE | UUID for Response Form link |
| `review_completed_at` | TIMESTAMPTZ | When form was submitted |

**New `employee_onboarding` table (~35 columns):** Full form submission, one row per employee. Identity, address, tax, license, insurance, banking fields. `tin_encrypted`, `bank_routing_encrypted`, `bank_account_encrypted` stored as AES-256-GCM ciphertext. `*_last4` columns always populated. `submitted_at`, `ip_address`, `ic_agreement_version` for audit trail.

**Migration 003 applied 2026-04-16:**
- `time_commitment_hours_per_week` (INTEGER) removed; replaced by `time_commitment_bucket` TEXT CHECK IN (under_15, 15_to_25, 25_to_35, over_35)
- `payment_method` constrained to CHECK IN (zelle, ach); values direct_deposit and check no longer accepted

### Validation Library (`lib/onboarding-validation.js`)

Shared module used by both server.js and tests. Exports: `validateSSN`, `validateEIN`, `validateZip`, `validatePhone`, `validateState`, `validateBankRouting`, `validateBankAccount`, `validateDOB`, `validateFutureDate`, `extractLast4SSN`, `extractLast4Routing`, `extractLast4Account`, `validateOnboarding`, `JOB_TITLES`, `CLINICAL_TITLES`.

### Tests

- `test/validation.test.js` — 113 tests covering all validators + full form validation + conditional ACH/Zelle rules + time_commitment_bucket enum + mobile phone required + insurance coverage amounts required for clinical titles + conditional license/insurance validation. Written red-first.
- `test/crypto.test.js` — 23 tests covering AES-256-GCM round-trip, non-determinism (random IV), tampering rejection, wrong-key rejection, empty string, null/undefined passthrough, `isEncrypted` heuristic, `generateKey`, and invalid key detection. Written red-first.

### Design Decisions

- Token security: UUID v4 via `crypto.randomUUID()` (Node built-in, no dependency)
- Encryption: AES-256-GCM via Node built-in `crypto` module. No new dependencies. Key in env var. Startup fails loudly if key is missing or wrong length.
- pgsodium not used: application-layer AES-256-GCM chosen over pgsodium for simpler setup and no Supabase extension dependency. Same security guarantees for this use case.
- Send Link feature: SMS via Twilio (+12134442242) and email via Resend (ops@lemedspa.com, CC lea@lemedspa.com)
- No 1099 export (out of scope)
- Never store plaintext SSN/EIN in plain database columns — only in `*_encrypted` columns

---

## Database Schema

| Table | Purpose | Key fields |
|-------|---------|-----------|
| `employees` | Staff profiles | name, pin, email, hourly_wage, commission_rate, pay_type, review_token, review_completed_at |
| `employee_onboarding` | Worker onboarding submissions | employee_id, personal info, address, tax (W-9), license, banking, attestation |
| `time_entries` | Daily hours | employee_id, date, start_time, end_time, break_minutes, hours |
| `client_entries` | Service work | time_entry_id, client_name, procedure_name, amount_earned, tip_amount, tip_received_cash |
| `product_sales` | Sales commissions | time_entry_id, product_name, sale_amount, commission_amount |
| `invoices` | Submitted summaries | employee_id, pay_period_start/end, totals, submitted_at, email_sent |
| `filings_1099` | 1099-NEC filing records | tax_year, form, irs_submit_date, tin_encrypted, tin_last4, recipient_name, address, compensation boxes, state income |

---

## Earning Calculation Logic

```
Total Hours    = sum(time_entries.hours) for period
Total Wages    = Total Hours × employee.hourly_wage
Total Comms    = sum(client_entries.amount_earned) for period
Total Tips     = sum(client_entries.tip_amount) for period
Product Comms  = sum(product_sales.commission_amount) for period
Cash Tips Recv = sum(client_entries.tip_received_cash) for period
Total Payable  = Wages + Comms + Tips + Product Comms - Cash Tips Recv
```

Components included depend on employee's `pay_type` setting.

---

## Technical Notes

- **Timezone:** All date logic uses Los Angeles time (America/Los_Angeles)
- **Keep-alive:** Pings every 14 minutes to prevent Render free tier spin-down
- **PWA:** Service worker registered for offline capability
- **Migration history:** SQLite → Supabase PostgreSQL (completed)
- **Design:** Dark + gold luxury theme matching lemedspa-website

---

## Design Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-08 | PIN-based employee auth | Simple, fast login for spa staff (no email/password friction) |
| 2025-08 | Single admin password | Small team, shared admin access sufficient |
| 2025-08 | Semi-monthly pay periods (1-15, 16-end) | Matches California semi-monthly pay requirements |
| 2025-10 | Migrated SQLite → Supabase | Cloud database accessible from any device |
| 2025-11 | Resend for invoice emails | Same provider as lm-app, simple API |
| 2026-01 | Dark + gold theme | Consistent brand across all LM properties |
| 2026-01 | Commission type toggle (% vs flat) | Accommodates different compensation structures |
| 2026-02 | Tips owed tracking | Separates cash tips already paid from tips still owed |
| 2026-04 | Worker self-onboarding via token link | Replaces manual data collection; UUID token is single-use per employee |
| 2026-04 | AES-256-GCM for onboarding sensitive fields | Application-layer encryption via Node built-in crypto. Key in Render env var. Startup guard if key missing. |
| 2026-04 | Admin password stored in sessionStorage | Needed to authenticate `/api/admin/employees/:id/onboarding` from the browser |
| 2026-04 | Renamed "Employees" → "Team Members" throughout | Warmer, more inclusive terminology aligned with brand voice |
| 2026-04 | Pre-form overlay replaces inline add form | Full-screen modal matches onboarding form styling; better UX for data entry |
| 2026-04 | Auto-generated PIN (removed from pre-form) | PIN access is separate concern from onboarding; handled after joining |
| 2026-04 | Conditional license/insurance sections | Only clinical titles (Esthetician, Aesthetic Nurse, Aesthetic NP, Physician) need professional credentials |
| 2026-04 | Send Link feature (SMS + Email) | Streamlines onboarding distribution; email uses approved "LeMed Spa family" verbiage |
| 2026-04 | Resend domain: lemedspa.com (was updates.lemedspa.com) | Free plan 1-domain limit; root domain is more professional |
| 2026-04 | Standard text inputs for TIN/phone (not digit boxes) | Digit boxes caused sizing/styling issues; auto-formatting text fields are simpler and more accessible |
| 2026-04 | Renamed "Onboarding" → "Response Form" throughout UI | Rebranded for clarity — this is a response/confirmation form, not just initial onboarding. Route URL `/onboarding/:token` and schema column names (`review_token`, `review_completed_at`) unchanged. |
| 2026-04 | `filings_1099` table for 1099-NEC tracking | IRS filing history per contractor. SSNs encrypted (AES-256-GCM, same key as employees.tin_encrypted). Leena Osman SSN was masked on source form — only tin_last4 stored. |
