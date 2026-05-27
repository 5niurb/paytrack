# Compliance Workflow — Phase 2 Implementation Plan

## Overview
Complete the compliance document renewal system by adding license auto-lookup (BreEZe), Docuseal e-signature integration, and the nightly scan orchestrator that triggers all three document workflows.

**Scope:** Professional license verification, W9/contract e-signing, nightly automation
**Time estimate:** 4-6 hours
**Risk level:** Medium (new integrations, polling/webhooks)

---

## Phase 2A: BreEZe Professional License Lookup

### What it does
- Queries California state license databases (via BreEZe API)
- Auto-verifies license status for clinical team members
- Sends "valid through X" or "renew now" notifications
- No manual confirmation needed (unlike COI)

### Implementation steps

1. **Add BreEZe API client** (`lib/breeze-client.mjs`)
   - Authenticate with BreEZe token (env: `BREEZE_API_TOKEN`)
   - Query licenses by name + license number
   - Return status (valid/expired/invalid)

2. **Add license check endpoint** (`POST /api/compliance/check-license`)
   - Called by nightly scan or admin trigger
   - Input: `employee_id`, optionally `manual_query_params`
   - Output: `{ status, license_number, expiry, profession }`
   - On auto-verify: update `employees.professional_license_expiry` + send notification

3. **Add license notification templates** (`compliance-notifications.mjs`)
   - `sendLicenseValid()` — "Your license is valid through X"
   - `sendLicenseRenewal()` — "Time to renew your license"
   - `sendLicenseInvalid()` — "Your license status could not be verified, please contact ops"

4. **Update compliance_documents table** (new columns via migration 008)
   - `license_status` (enum: valid/expired/invalid/not_found)
   - `license_verified_at` (timestamp)
   - `license_profession` (text)
   - `license_expiry_notified_at` (timestamp)

---

## Phase 2B: Docuseal E-Signature Integration

### What it does
- Generates W9/contract documents
- Sends to worker for e-signature via Docuseal
- Webhook receives signature completion
- Marks `employees.w9_signed` / `contract_signed` true

### Implementation steps

1. **Add Docuseal API client** (`lib/docuseal-client.mjs`)
   - Authenticate with Docuseal token (env: `DOCUSEAL_API_TOKEN`)
   - Create template submissions
   - Webhook handler for signature events
   - Pre-fill worker name/email

2. **Create W9 and Contract templates in Docuseal**
   - W9 form (employer EIN, payer name, worker TIN)
   - Service contract (basic independent contractor terms)
   - Both templates have `worker_name`, `worker_email`, `timestamp` fillable fields

3. **Add e-sign request endpoint** (`POST /api/compliance/esign-request`)
   - Input: `employee_id`, `document_type` (w9 or contract)
   - Create `compliance_requests` with type='esign'
   - Create `compliance_documents` with status='pending'
   - Send Docuseal submission link to worker (email + SMS)
   - Return 200 with token

4. **Add webhook handler** (`POST /api/compliance/esign-webhook`)
   - Verify Docuseal signature (X-Docuseal-Webhook header)
   - Parse `document_type`, `employee_id` from submission data
   - Update `compliance_documents` status='signed'
   - Update `employees.w9_signed` or `contract_signed`
   - Mark `compliance_requests` token as used
   - Send "We received your signature" notification

5. **Add e-sign notification templates**
   - `sendESignRequest()` — "Sign your W9/Contract" link
   - `sendESignComplete()` — "Thanks for signing!"

---

## Phase 2C: Nightly Scan Orchestrator

### What it does
- Runs nightly (11:30 PM PT, launchd)
- Checks all three compliance triggers for each active employee
- Auto-verifies where possible (licenses)
- Triggers reminders where needed (COI, W9, contract)
- Uses parallel requests to BreEZe

### Implementation steps

1. **Add nightly scan endpoint** (`POST /api/compliance/scan`)
   - Auth: `CRON_SECRET` header (same as existing cron jobs)
   - Queries all employees with `created_at` NOT null
   - For each employee:
     - Check COI expiry vs today → trigger reminder if needed
     - Check professional license (BreEZe) → auto-verify or trigger reminder
     - Check W9/contract status → trigger esign if not signed
   - Return summary: `{ checked: N, reminders_triggered: N, errors: [] }`

2. **Add scan logic** (`lib/compliance-scan.mjs`)
   - Export `runComplianceScan(supabase)` async function
   - Parallel BreEZe queries for all employees (batch 10 at a time)
   - Fire-and-forget notifications (no blocking on send)
   - Log errors but continue (one failure ≠ skip rest)

3. **Register launchd job** (`~/Library/LaunchAgents/com.lemed.compliance-scanner.plist`)
   - Daily 11:30 PM Pacific
   - Calls `POST https://paytrack.lemedspa.app/api/compliance/scan` with `CRON_SECRET` header
   - 15-minute timeout
   - SMS alert on HTTP error

4. **Update Render env vars**
   - Add `BREEZE_API_TOKEN` (from BreEZe dashboard)
   - Add `DOCUSEAL_API_TOKEN` (from Docuseal dashboard)
   - Restart service after

---

## Phase 2D: Frontend Additions

1. **Admin Compliance Dashboard** (`public/admin.html` → new tab or modal)
   - View all pending documents (COI, license, W9, contract)
   - Filter by employee, document type, status
   - Inline approval/rejection buttons
   - Last scan timestamp + next scan ETA

2. **Employee Compliance View** (`public/index.html` → new section)
   - Show current compliance status (COI valid until X, W9 signed, etc.)
   - Quick action buttons (upload COI, sign W9, check license)

---

## Database Migrations

**Migration 008: License verification schema**
```sql
ALTER TABLE compliance_documents
  ADD COLUMN license_status text CHECK (license_status IN ('valid', 'expired', 'invalid', 'not_found')),
  ADD COLUMN license_verified_at timestamptz,
  ADD COLUMN license_profession text,
  ADD COLUMN license_expiry_notified_at timestamptz;

CREATE INDEX idx_compliance_docs_verification ON compliance_documents(document_type, status);
```

---

## Testing Checklist

- [ ] BreEZe API responds correctly to valid/invalid license queries
- [ ] License notification email templates render correctly
- [ ] Docuseal template links work and prefill worker data
- [ ] Webhook signature verification passes
- [ ] Nightly scan completes without errors
- [ ] Parallel BreEZe requests don't exceed rate limits
- [ ] Admin dashboard loads all pending documents
- [ ] Worker notification emails/SMS are received

---

## Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| BreEZe API rate limit exceeded | Batch requests, implement exponential backoff, log and retry next scan |
| Docuseal template misconfiguration | Test in sandbox first, prefill with sample data |
| Webhook signature mismatch | Verify X-Docuseal-Webhook header format in API docs |
| Scan runs too long (>15min timeout) | Monitor response times, add query indexes if needed |
| License data stale (BreEZe cache lag) | Accept 24h lag, rescan on manual trigger via admin |

---

## Deployment Order

1. **Commit 1:** BreEZe client + license check endpoint + migrations
2. **Commit 2:** License notifications + admin trigger UI
3. **Commit 3:** Docuseal client + esign endpoints + webhooks
4. **Commit 4:** Docuseal templates configured + tested in sandbox
5. **Commit 5:** Nightly scan logic + launchd registration
6. **Final:** Deploy to Render, register launchd on Mac, smoke test

---

## Files to Create/Modify

### New files
- `lib/breeze-client.mjs`
- `lib/docuseal-client.mjs`
- `lib/compliance-scan.mjs`
- `migrations/008-license-verification-schema.sql`

### Modified files
- `routes/compliance.js` — add new endpoints
- `lib/compliance-notifications.mjs` — add license/esign templates
- `public/admin.html` — add compliance dashboard tab
- `public/index.html` — add employee compliance status
- `server.js` — register new endpoints
- `package.json` — no changes (BreEZe/Docuseal are REST-only)

### Infrastructure
- Render env vars: `BREEZE_API_TOKEN`, `DOCUSEAL_API_TOKEN`
- launchd: `com.lemed.compliance-scanner.plist`
- Docuseal templates: W9, Service Contract (configured in Docuseal dashboard, not code)

---

## Next Steps

1. ✅ Review this plan with Mike
2. → Implement BreEZe client + endpoints
3. → Set up Docuseal templates
4. → Implement e-sign workflow
5. → Deploy nightly scan
6. → Smoke test end-to-end
