/**
 * Pay period helpers for LM PayTrack.
 *
 * Le Med Spa runs 26 pay periods per year:
 *   Period 1: 1st–15th of each month
 *   Period 2: 16th–last day of month
 *
 * All dates are treated as LA timezone (America/Los_Angeles)
 * by convention — the caller is responsible for TZ conversion
 * before passing dates into these functions.
 */

/**
 * Safely converts a date input to a local-time Date object.
 *
 * Bare ISO date strings ("2026-02-15") are parsed as UTC midnight
 * by the JS spec, which shifts to the previous day in timezones
 * west of UTC. Appending T00:00:00 (no Z) forces local-time parsing.
 *
 * @param {Date|string|number} date
 * @returns {Date}
 */
function toLocalDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Date(`${date}T00:00:00`);
  }
  return new Date(date);
}

/**
 * Returns the pay period (start/end Date objects) that contains
 * the given date.
 *
 * @param {Date|string} date - A date within the desired pay period
 * @returns {{ start: Date, end: Date }}
 */
function getPayPeriod(date) {
  const d = toLocalDate(date);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }

  const year = d.getFullYear();
  const month = d.getMonth();
  const day = d.getDate();

  if (day <= 15) {
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month, 15),
    };
  }

  const lastDay = new Date(year, month + 1, 0).getDate();
  return {
    start: new Date(year, month, 16),
    end: new Date(year, month, lastDay),
  };
}

/**
 * Formats a Date as YYYY-MM-DD for Supabase queries.
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDateForDB(date) {
  const d = toLocalDate(date);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns the pay period N offsets from the current one.
 *   offset  0 → current period
 *   offset -1 → previous period
 *   offset  1 → next period
 *
 * IMPORTANT: Always uses LA timezone (America/Los_Angeles) for date calculations.
 * If called from server.js, pass getLATodayString() result as a reference.
 *
 * @param {number} offset
 * @param {string|Date} [referenceDate] - Optional LA date (YYYY-MM-DD string or Date). Defaults to today in LA.
 * @returns {{ start: Date, end: Date }}
 */
function getPayPeriodByOffset(offset = 0, referenceDate = null) {
  let today;

  if (referenceDate) {
    today = toLocalDate(referenceDate);
  } else {
    // Convert current time to LA timezone
    const now = new Date();
    const laDateStr = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    today = new Date(laDateStr.getFullYear(), laDateStr.getMonth(), laDateStr.getDate());
  }

  let targetDate = new Date(today);

  for (let i = 0; i < Math.abs(offset); i++) {
    if (offset < 0) {
      const currentPeriod = getPayPeriod(targetDate);
      targetDate = new Date(currentPeriod.start);
      targetDate.setDate(targetDate.getDate() - 1);
    } else {
      const currentPeriod = getPayPeriod(targetDate);
      targetDate = new Date(currentPeriod.end);
      targetDate.setDate(targetDate.getDate() + 1);
    }
  }

  return getPayPeriod(targetDate);
}

/**
 * Returns a human-readable label for a pay period.
 *
 * Examples:
 *   "Feb 1–15, 2026"
 *   "Feb 16–28, 2026"
 *   "Dec 16–31, 2025"
 *
 * @param {{ start: Date, end: Date }} period
 * @returns {string}
 */
function getPayPeriodLabel(period) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  const start = new Date(period.start);
  const end = new Date(period.end);

  const month = months[start.getMonth()];
  const startDay = start.getDate();
  const endDay = end.getDate();
  const year = start.getFullYear();

  return `${month} ${startDay}\u2013${endDay}, ${year}`;
}

module.exports = {
  getPayPeriod,
  formatDateForDB,
  getPayPeriodByOffset,
  getPayPeriodLabel,
};
