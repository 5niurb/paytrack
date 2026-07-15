'use strict';

const assert = require('assert');
const {
  getPayPeriod,
  formatDateForDB,
  getPayPeriodByOffset,
  getPayPeriodLabel,
} = require('../lib/pay-periods');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.error('  FAIL:', name, '-', e.message);
    failed++;
  }
}

// Helper: assert a period's start/end match expected Y/M/D (local-time, no TZ ambiguity).
function assertPeriod(period, expectedStartYMD, expectedEndYMD, label) {
  const fmtStart = formatDateForDB(period.start);
  const fmtEnd = formatDateForDB(period.end);
  assert.equal(fmtStart, expectedStartYMD, `${label}: start mismatch`);
  assert.equal(fmtEnd, expectedEndYMD, `${label}: end mismatch`);
}

console.log('getPayPeriod — 1st-15th vs 16th-end boundaries:');

test('day 1 of month falls in period 1 (1st-15th)', () => {
  assertPeriod(getPayPeriod('2026-03-01'), '2026-03-01', '2026-03-15', 'day 1');
});

test('day 15 (last day of period 1) still falls in period 1', () => {
  assertPeriod(getPayPeriod('2026-03-15'), '2026-03-01', '2026-03-15', 'day 15');
});

test('day 16 (first day of period 2) falls in period 2', () => {
  assertPeriod(getPayPeriod('2026-03-16'), '2026-03-16', '2026-03-31', 'day 16');
});

console.log('\ngetPayPeriod — Feb 28/29 (leap year) handling:');

test('Feb 2026 (non-leap year): period 2 ends on the 28th', () => {
  assertPeriod(getPayPeriod('2026-02-20'), '2026-02-16', '2026-02-28', 'Feb 2026 non-leap');
});

test('Feb 2026: the 28th itself is the last day of period 2', () => {
  assertPeriod(getPayPeriod('2026-02-28'), '2026-02-16', '2026-02-28', 'Feb 28 2026');
});

test('Feb 2028 (leap year): period 2 ends on the 29th', () => {
  assertPeriod(getPayPeriod('2028-02-20'), '2028-02-16', '2028-02-29', 'Feb 2028 leap');
});

test('Feb 2028: the 29th itself is the last day of period 2', () => {
  assertPeriod(getPayPeriod('2028-02-29'), '2028-02-16', '2028-02-29', 'Feb 29 2028');
});

test('Feb 2024 (another leap year, sanity check): period 2 ends on the 29th', () => {
  assertPeriod(getPayPeriod('2024-02-29'), '2024-02-16', '2024-02-29', 'Feb 29 2024');
});

console.log('\ngetPayPeriod — 31-day month end boundaries:');

test('Jan (31 days): period 2 ends on the 31st', () => {
  assertPeriod(getPayPeriod('2026-01-31'), '2026-01-16', '2026-01-31', 'Jan 31 2026');
});

test('Mar (31 days): period 2 ends on the 31st', () => {
  assertPeriod(getPayPeriod('2026-03-31'), '2026-03-16', '2026-03-31', 'Mar 31 2026');
});

test('Apr (30 days): period 2 ends on the 30th, not 31st', () => {
  assertPeriod(getPayPeriod('2026-04-30'), '2026-04-16', '2026-04-30', 'Apr 30 2026');
});

test('Dec (31 days): period 2 ends on the 31st', () => {
  assertPeriod(getPayPeriod('2026-12-31'), '2026-12-16', '2026-12-31', 'Dec 31 2026');
});

console.log('\ngetPayPeriod — invalid input:');

test('throws on invalid date string', () => {
  assert.throws(() => getPayPeriod('not-a-date'), /Invalid date/);
});

console.log('\ngetPayPeriodByOffset — year-boundary navigation:');

test('offset +1 from Dec 16-31, 2026 crosses into Jan 1-15, 2027', () => {
  const period = getPayPeriodByOffset(1, '2026-12-20');
  assertPeriod(period, '2027-01-01', '2027-01-15', 'Dec 2026 -> Jan 2027 (+1)');
});

test('offset -1 from Jan 1-15, 2027 crosses back into Dec 16-31, 2026', () => {
  const period = getPayPeriodByOffset(-1, '2027-01-05');
  assertPeriod(period, '2026-12-16', '2026-12-31', 'Jan 2027 -> Dec 2026 (-1)');
});

test('offset +2 from Dec 1-15, 2026 skips two periods into Jan 1-15, 2027', () => {
  const period = getPayPeriodByOffset(2, '2026-12-05');
  assertPeriod(period, '2027-01-01', '2027-01-15', 'Dec 2026 -> Jan 2027 (+2)');
});

test('offset 0 returns the period containing the reference date', () => {
  const period = getPayPeriodByOffset(0, '2026-06-10');
  assertPeriod(period, '2026-06-01', '2026-06-15', 'offset 0');
});

test('offset -1 within the same month (period 2 -> period 1)', () => {
  const period = getPayPeriodByOffset(-1, '2026-06-20');
  assertPeriod(period, '2026-06-01', '2026-06-15', 'offset -1 same month');
});

test('offset navigation across Feb 2028 leap-year boundary (+1 from Jan 16-31)', () => {
  const period = getPayPeriodByOffset(1, '2028-01-20');
  assertPeriod(period, '2028-02-01', '2028-02-15', 'Jan 2028 -> Feb 2028 (+1)');
});

test('offset navigation lands on leap-day period (+2 from Jan 16-31, 2028)', () => {
  const period = getPayPeriodByOffset(2, '2028-01-20');
  assertPeriod(period, '2028-02-16', '2028-02-29', 'Jan 2028 -> Feb 16-29 2028 (+2)');
});

console.log('\ngetPayPeriod — DST transitions (America/Los_Angeles):');

test('2026 spring-forward date (Mar 8, 2026) resolves to the correct period', () => {
  // DST 2026 "spring forward" is Sunday, March 8, 2026 at 2am LA time.
  assertPeriod(getPayPeriod('2026-03-08'), '2026-03-01', '2026-03-15', 'spring forward day 2026');
});

test('period spanning the 2026 spring-forward transition still resolves consistent start/end', () => {
  // The period 2026-03-01..03-15 contains the DST transition (Mar 8) inside it.
  const period = getPayPeriod('2026-03-10');
  assertPeriod(period, '2026-03-01', '2026-03-15', 'period spanning spring-forward');
});

test('2026 fall-back date (Nov 1, 2026) resolves to the correct period', () => {
  // DST 2026 "fall back" is Sunday, November 1, 2026 at 2am LA time.
  assertPeriod(getPayPeriod('2026-11-01'), '2026-11-01', '2026-11-15', 'fall back day 2026');
});

test('period spanning the 2026 fall-back transition still resolves consistent start/end', () => {
  const period = getPayPeriod('2026-11-03');
  assertPeriod(period, '2026-11-01', '2026-11-15', 'period spanning fall-back');
});

test('offset navigation across the spring-forward transition (+1 from Feb 16-28)', () => {
  // Feb 16-28, 2026 -> Mar 1-15, 2026 (period boundary is Mar 1, five days before DST starts).
  const period = getPayPeriodByOffset(1, '2026-02-20');
  assertPeriod(period, '2026-03-01', '2026-03-15', 'offset across spring-forward');
});

test('offset navigation across the fall-back transition (+1 from Oct 16-31)', () => {
  // Oct 16-31, 2026 -> Nov 1-15, 2026 (period boundary is Nov 1, the DST fall-back day itself).
  const period = getPayPeriodByOffset(1, '2026-10-20');
  assertPeriod(period, '2026-11-01', '2026-11-15', 'offset across fall-back');
});

console.log('\nformatDateForDB:');

test('formats a Date object as YYYY-MM-DD', () => {
  assert.equal(formatDateForDB(new Date(2026, 1, 5)), '2026-02-05');
});

test('formats a bare ISO date string as YYYY-MM-DD (no day-shift)', () => {
  assert.equal(formatDateForDB('2026-02-05'), '2026-02-05');
});

test('throws on invalid input', () => {
  assert.throws(() => formatDateForDB('garbage'), /Invalid date/);
});

console.log('\ngetPayPeriodLabel:');

test('labels a period-1 span correctly', () => {
  assert.equal(getPayPeriodLabel(getPayPeriod('2026-02-05')), 'Feb 1–15, 2026');
});

test('labels a period-2 span ending on Feb 28 (non-leap) correctly', () => {
  assert.equal(getPayPeriodLabel(getPayPeriod('2026-02-20')), 'Feb 16–28, 2026');
});

test('labels a period-2 span ending on Feb 29 (leap year) correctly', () => {
  assert.equal(getPayPeriodLabel(getPayPeriod('2028-02-20')), 'Feb 16–29, 2028');
});

test('labels a period spanning a year boundary using the start month/year', () => {
  assert.equal(getPayPeriodLabel(getPayPeriod('2026-12-20')), 'Dec 16–31, 2026');
});

console.log(`\nPay periods: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
