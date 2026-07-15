'use strict';

// Tests for lib/pin-lockout.js — per-account PIN lockout.
//
// Wave 2.B PIN hardening: on top of the existing per-IP rate limiter (which
// stays), track failed PIN attempts per matched-or-claimed employee. 5
// consecutive failures → 15-minute lockout for that employee. Success resets
// the counter. The UX message stays generic (never reveal lock state or which
// account).

const assert = require('assert');
const {
  MAX_ATTEMPTS,
  LOCKOUT_MS,
  isLocked,
  nextState,
  getLockout,
  isEmployeeLocked,
  recordAttempt,
} = require('../lib/pin-lockout');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => {
          console.log('  PASS:', name);
          passed++;
        })
        .catch((e) => {
          console.error('  FAIL:', name, '-', e.message);
          failed++;
        });
    }
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.error('  FAIL:', name, '-', e.message);
    failed++;
  }
  return Promise.resolve();
}

const NOW = Date.parse('2026-07-15T12:00:00Z');

// Minimal mock of the Supabase surface used by the store:
//   .from('pin_lockouts').select().eq().maybeSingle()  -> read
//   .from('pin_lockouts').upsert(row, {onConflict})     -> write (insert/update)
//   .from('pin_lockouts').update(patch).eq()            -> write (update only)
function makeMockSupabase(initialRows = {}) {
  const rows = { ...initialRows }; // keyed by employee_id
  return {
    __rows: rows,
    from() {
      const state = { filterId: null, pendingUpdate: null };
      const api = {
        select() {
          return api;
        },
        eq(_col, val) {
          state.filterId = val;
          if (state.pendingUpdate) {
            if (rows[val]) rows[val] = { ...rows[val], ...state.pendingUpdate };
            return Promise.resolve({ data: null, error: null });
          }
          return api;
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[state.filterId] || null, error: null });
        },
        upsert(row) {
          rows[row.employee_id] = { ...row };
          return Promise.resolve({ data: row, error: null });
        },
        update(patch) {
          state.pendingUpdate = patch;
          return api;
        },
      };
      return api;
    },
  };
}

async function runTests() {
  console.log('\nconstants:');
  test('MAX_ATTEMPTS is 5', () => assert.strictEqual(MAX_ATTEMPTS, 5));
  test('LOCKOUT_MS is 15 minutes', () => assert.strictEqual(LOCKOUT_MS, 15 * 60 * 1000));

  console.log('\nisLocked:');
  test('null/undefined record is not locked', () => {
    assert.strictEqual(isLocked(null, NOW), false);
    assert.strictEqual(isLocked(undefined, NOW), false);
  });
  test('record with no locked_until is not locked', () => {
    assert.strictEqual(isLocked({ failed_count: 3, locked_until: null }, NOW), false);
  });
  test('record locked until the future IS locked', () => {
    const rec = { failed_count: 5, locked_until: new Date(NOW + 60000).toISOString() };
    assert.strictEqual(isLocked(rec, NOW), true);
  });
  test('record whose lock has expired is NOT locked', () => {
    const rec = { failed_count: 5, locked_until: new Date(NOW - 1000).toISOString() };
    assert.strictEqual(isLocked(rec, NOW), false);
  });
  test('lock exactly at boundary (locked_until == now) is not locked', () => {
    const rec = { failed_count: 5, locked_until: new Date(NOW).toISOString() };
    assert.strictEqual(isLocked(rec, NOW), false);
  });

  console.log('\nnextState on failure:');
  test('first failure → count 1, not locked', () => {
    const s = nextState(null, false, NOW);
    assert.strictEqual(s.failed_count, 1);
    assert.strictEqual(s.locked_until, null);
  });
  test('failures accumulate up to 4 without locking', () => {
    let rec = null;
    for (let i = 1; i <= 4; i++) {
      rec = nextState(rec, false, NOW);
      assert.strictEqual(rec.failed_count, i);
      assert.strictEqual(rec.locked_until, null, `should not lock at ${i}`);
    }
  });
  test('5th consecutive failure sets a 15-min lock', () => {
    let rec = { failed_count: 4, locked_until: null };
    rec = nextState(rec, false, NOW);
    assert.strictEqual(rec.failed_count, 5);
    assert.ok(rec.locked_until, 'locked_until set');
    assert.strictEqual(Date.parse(rec.locked_until), NOW + LOCKOUT_MS);
  });
  test('failure while already locked keeps the lock (extends window)', () => {
    let rec = { failed_count: 5, locked_until: new Date(NOW + 1000).toISOString() };
    rec = nextState(rec, false, NOW);
    assert.strictEqual(rec.failed_count, 6);
    assert.strictEqual(Date.parse(rec.locked_until), NOW + LOCKOUT_MS);
  });

  console.log('\nnextState on success:');
  test('success resets count and clears lock', () => {
    const rec = { failed_count: 4, locked_until: null };
    const s = nextState(rec, true, NOW);
    assert.strictEqual(s.failed_count, 0);
    assert.strictEqual(s.locked_until, null);
  });
  test('success from a fresh (null) record → zeroed state', () => {
    const s = nextState(null, true, NOW);
    assert.strictEqual(s.failed_count, 0);
    assert.strictEqual(s.locked_until, null);
  });

  console.log('\nDB-backed store:');
  await test('getLockout returns null when no row', async () => {
    const sb = makeMockSupabase();
    assert.strictEqual(await getLockout(sb, 7), null);
  });
  await test('isEmployeeLocked false for null employeeId', async () => {
    const sb = makeMockSupabase();
    assert.strictEqual(await isEmployeeLocked(sb, null, NOW), false);
  });
  await test('recordAttempt: 5 failures lock the account', async () => {
    const sb = makeMockSupabase();
    let result;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      result = await recordAttempt(sb, 42, false, NOW);
    }
    assert.strictEqual(result.failed_count, MAX_ATTEMPTS);
    assert.strictEqual(result.locked, true);
    assert.strictEqual(await isEmployeeLocked(sb, 42, NOW + 1000), true);
    // Unlocked after the window elapses
    assert.strictEqual(await isEmployeeLocked(sb, 42, NOW + LOCKOUT_MS + 1), false);
  });
  await test('recordAttempt: 4 failures do NOT lock', async () => {
    const sb = makeMockSupabase();
    let result;
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      result = await recordAttempt(sb, 5, false, NOW);
    }
    assert.strictEqual(result.locked, false);
    assert.strictEqual(await isEmployeeLocked(sb, 5, NOW), false);
  });
  await test('recordAttempt success clears an existing lock', async () => {
    const sb = makeMockSupabase();
    for (let i = 0; i < MAX_ATTEMPTS; i++) await recordAttempt(sb, 8, false, NOW);
    assert.strictEqual(await isEmployeeLocked(sb, 8, NOW + 1000), true);
    await recordAttempt(sb, 8, true, NOW + 2000);
    assert.strictEqual(sb.__rows[8].failed_count, 0);
    assert.strictEqual(sb.__rows[8].locked_until, null);
    assert.strictEqual(await isEmployeeLocked(sb, 8, NOW + 3000), false);
  });
  await test('recordAttempt success is a no-op when no row exists', async () => {
    const sb = makeMockSupabase();
    await recordAttempt(sb, 123, true, NOW);
    assert.strictEqual(sb.__rows[123], undefined);
  });

  console.log('\n' + '='.repeat(50));
  console.log(`PIN lockout: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests();
