-- Per-account PIN lockout (Wave 2.B, Task 3).
--
-- The existing per-IP rate limiter (express-rate-limit, 10 attempts / 15 min)
-- stays as-is. This table adds a SECOND, independent layer: per-employee
-- lockout so that repeated failed attempts against ONE account lock that
-- account regardless of source IP. After 5 consecutive failures for a given
-- employee, the account is locked for 15 minutes. A successful auth clears it.
--
-- Keyed by employee_id: change-pin knows the target employee directly; verify-pin
-- can only attribute a failure to an account when the submitted PIN's owner can
-- be inferred, so verify-pin uses this to reset the counter on success and (per
-- the app logic) does not lock non-existent accounts.
CREATE TABLE IF NOT EXISTS pin_lockouts (
  employee_id  INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  failed_count INTEGER      NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast "is this account currently locked?" lookups.
CREATE INDEX IF NOT EXISTS idx_pin_lockouts_locked_until
  ON pin_lockouts (locked_until);
