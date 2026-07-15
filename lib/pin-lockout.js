'use strict';

// Per-account PIN lockout (Wave 2.B, Task 3).
//
// Second layer on top of the per-IP express-rate-limit limiter (which stays):
// after MAX_ATTEMPTS consecutive failed PIN attempts against a single employee
// account, that account is locked for LOCKOUT_MS regardless of source IP. A
// successful auth clears the counter. UX messages stay generic (the caller
// decides copy) so we never reveal whether a PIN matched a real account.
//
// State lives in the `pin_lockouts` table (migration 011). The pure decision
// helpers below (isLocked, nextState) are unit-tested without a DB; the
// DB-backed functions are thin wrappers around them.

const MAX_ATTEMPTS = 5; // consecutive failures before lockout
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Is a lockout record currently locked at time `now`?
 * A lock exactly at the boundary (locked_until === now) has expired.
 * @param {{locked_until: string|Date|null}|null|undefined} rec
 * @param {number} now epoch ms (default Date.now())
 * @returns {boolean}
 */
function isLocked(rec, now = Date.now()) {
  if (!rec || !rec.locked_until) return false;
  return new Date(rec.locked_until).getTime() > now;
}

/**
 * Compute the next lockout record given the prior record and the outcome of an
 * attempt.
 *
 * On success: counter resets to 0, lock cleared.
 * On failure: counter increments; once it reaches MAX_ATTEMPTS the record locks
 *   until now + LOCKOUT_MS. A failure while already locked keeps climbing and
 *   refreshes the window, so a burst can't slip through as the window lapses.
 *
 * @param {{failed_count?:number}|null|undefined} rec
 * @param {boolean} success  true if the attempt authenticated successfully
 * @param {number} now epoch ms (default Date.now())
 * @returns {{failed_count:number, locked_until:string|null}}
 */
function nextState(rec, success, now = Date.now()) {
  if (success) {
    return { failed_count: 0, locked_until: null };
  }
  const prior = rec && Number.isFinite(rec.failed_count) ? rec.failed_count : 0;
  const failed_count = prior + 1;
  const locked_until =
    failed_count >= MAX_ATTEMPTS ? new Date(now + LOCKOUT_MS).toISOString() : null;
  return { failed_count, locked_until };
}

// ---------------------------------------------------------------------------
// DB-backed store. `supabase` is the service-role client. Keyed by employee_id.
// ---------------------------------------------------------------------------

/**
 * Fetch the lockout record for an employee (or null if none).
 */
async function getLockout(supabase, employeeId) {
  const { data } = await supabase
    .from('pin_lockouts')
    .select('employee_id, failed_count, locked_until')
    .eq('employee_id', employeeId)
    .maybeSingle();
  return data || null;
}

/**
 * True if the account is currently locked.
 */
async function isEmployeeLocked(supabase, employeeId, now = Date.now()) {
  if (employeeId == null) return false;
  const rec = await getLockout(supabase, employeeId);
  return isLocked(rec, now);
}

/**
 * Record an attempt outcome for an employee and persist the new state. Returns
 * the new state plus whether the account is now locked. On success, only writes
 * if a row exists (avoids creating empty rows for every clean login).
 *
 * @returns {Promise<{failed_count:number, locked_until:string|null, locked:boolean}>}
 */
async function recordAttempt(supabase, employeeId, success, now = Date.now()) {
  const rec = await getLockout(supabase, employeeId);
  const next = nextState(rec, success, now);

  if (success) {
    if (rec) {
      await supabase
        .from('pin_lockouts')
        .update({ ...next, updated_at: new Date(now).toISOString() })
        .eq('employee_id', employeeId);
    }
    return { ...next, locked: false };
  }

  await supabase.from('pin_lockouts').upsert(
    {
      employee_id: employeeId,
      failed_count: next.failed_count,
      locked_until: next.locked_until,
      updated_at: new Date(now).toISOString(),
    },
    { onConflict: 'employee_id' },
  );
  return { ...next, locked: isLocked({ locked_until: next.locked_until }, now) };
}

module.exports = {
  MAX_ATTEMPTS,
  LOCKOUT_MS,
  isLocked,
  nextState,
  getLockout,
  isEmployeeLocked,
  recordAttempt,
};
