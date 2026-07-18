# TODO — paytrack

Open items for the employee time & payroll PWA (Fly.io `lm-paytrack`).
**Read at session start; update at session end.** A SessionStart hook prints open items automatically.

**What belongs here:** work that outlives a single session — follow-ups, known problems,
deferred decisions. Anything a future session would otherwise have to rediscover.

**What does NOT belong here:** a log of what happened (that's `SESSION_NOTES.md`), or
in-session task tracking (that's TodoWrite). This file is *mutable current state* —
check items off, delete them when done, rewrite freely. SESSION_NOTES is append-only history.

**Format:** `- [ ] Item — why it matters / what "done" looks like` · add `(blocked: X)` when waiting.

---

**This repo is in good shape.** The two most recent sessions (2026-06-11 admin rate-limiter,
2026-06-02/07 admin auth standardization) both closed with "Issues: None / Next steps: None."
The items below are older loose ends, not active problems.

## 👀 For Mike

- [ ] **`COMPLIANCE_CONTACT_ENABLED` is OFF pending your go-live decision** — confirmed still
      current in CLAUDE.md: "currently UNSET/OFF... do not enable without Mike's go-ahead."
      This gates real outbound contact, so it stays off until you say otherwise.

## Open loose ends

- [ ] **Manual end-to-end test of Phase 2 compliance workflows** — license verification,
      e-signature, nightly compliance scan. Outstanding since the 2026-05-29 session; may
      still be relevant. **Done =** each flow exercised once against real data.
- [x] ~~SESSION_NOTES out of sync with CLAUDE.md's changelog~~ — **RESOLVED 2026-07-17.**
      The premise was stale: the 2026-07-15 Wave 2.B entry already existed (buried at the
      *bottom* of SESSION_NOTES, line ~1214). Root cause of the confusion: the file is NOT
      chronologically ordered, so the SessionStart hook reads the top entry (2026-06-11) as
      "last session" and never surfaces newer work. Two same-day follow-up commits (`a6b2ccf`
      invoice-presentation extraction → server.js 809→496; `613b064` Wave 3 config dedupe) were
      genuinely undocumented — now appended. Added a file-order caveat note to SESSION_NOTES.

**Settled — don't re-litigate:**
- **Admin auth is standardized on the `x-admin-password` header only** — the legacy
  `password` header fallback was deliberately removed (verified live: legacy header returns
  401). Don't reintroduce it.
- **Rate-limit responses must be JSON, not plain text** — a plain-string 429 crashed
  `resp.json()` client-side. This cost **two** separate incidents before it was fixed.
- **The rate limiter must key on IP (via `ipKeyGenerator`), NEVER on the submitted password**
  — keying on the password hands an attacker a fresh brute-force budget per guess, defeating
  the protection entirely. Caught by an independent security review.
- **`trust proxy` must be exactly `1`** (Fly/Render = single LB hop) — `true` or omitted both
  break per-client rate limiting or `req.ip` accuracy.
- **`Cache-Control` on `/api/` must be `no-store`, never `public`** — a payroll/PII app can't
  let shared caches serve one employee's data to another. This was a self-caught regression
  from an earlier performance pass.
- **Fly config is deliberately tuned to stay under the ~$5/mo invoice waiver** (~$3.19/mo,
  `lm-paytrack`, region `sjc`). **Do not add a second machine or bump RAM** — either pushes
  past the free threshold. Render (`LM-PayTrack`) still exists but is out of the traffic
  path; never deploy to it.
- **paytrack is staff-facing, not patient-facing** — per the 2026-07-15 timing-constraint
  clarification it is **not** subject to the 8pm–6am deploy window. Downtime inconveniences
  an employee, not a customer.
- **Render bulk PUT for env vars wipes ALL vars**, including dashboard-set ones not returned
  by GET — this caused a full env-var wipe once. `render-api.js` was rewritten to
  fetch-all→merge→PUT-all-back. The lesson generalizes to any bulk-write API.
