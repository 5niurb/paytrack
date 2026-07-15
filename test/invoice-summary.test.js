'use strict';

// Characterization + unit tests for lib/invoice-summary.js
//
// Wave 2.B correctness fix: the batched per-entry aggregation math
// (commissions / tips / cash-tips / product-commissions / wages / payable)
// was copy-pasted into four server.js routes. These tests lock down the exact
// current behavior BEFORE extraction so the shared helper is provably
// equivalent. The fixture numbers are the source of truth.

const assert = require('assert');
const {
  aggregateEntries,
  fetchInvoiceSummary,
} = require('../lib/invoice-summary');

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

// ---------------------------------------------------------------------------
// Fixture dataset
// ---------------------------------------------------------------------------
// 3 time entries. Day 1: two clients (one cash tip, one not) + one product
// sale. Day 2: one client, non-cash tip, no products. Day 3: no clients, one
// product sale, and a null tip_amount / null commission_amount to exercise the
// `|| 0` guards.
const HOURLY_WAGE = 20;

const ENTRIES = [
  { id: 101, date: '2026-01-01', hours: 8 },
  { id: 102, date: '2026-01-02', hours: 5 },
  { id: 103, date: '2026-01-03', hours: 6.5 },
];

const CLIENTS = [
  // entry 101
  { time_entry_id: 101, amount_earned: 40, tip_amount: 10, tip_received_cash: true },
  { time_entry_id: 101, amount_earned: 25, tip_amount: 5, tip_received_cash: false },
  // entry 102
  { time_entry_id: 102, amount_earned: 30, tip_amount: 8, tip_received_cash: false },
  // entry 103 — null tip to test guard
  { time_entry_id: 103, amount_earned: 15, tip_amount: null, tip_received_cash: false },
];

const SALES = [
  { time_entry_id: 101, commission_amount: 12 },
  { time_entry_id: 103, commission_amount: null }, // null to test guard
  { time_entry_id: 103, commission_amount: 7 },
];

// Hand-computed expected values (the characterization baseline):
// Day 101: comm 40+25=65, tips 10+5=15, cashTips 10, prodComm 12, wages 8*20=160
// Day 102: comm 30, tips 8, cashTips 0, prodComm 0, wages 5*20=100
// Day 103: comm 15, tips 0 (null), cashTips 0, prodComm 0+7=7, wages 6.5*20=130
// Totals: hours 19.5, comm 110, tips 23, cashTips 10, prodComm 19, wages 390
// payable = 390 + 110 + 23 + 19 - 10 = 532

// ---------------------------------------------------------------------------
// Mock Supabase client mimicking the .from().select().eq().gte().lte().in()
// .order().single() chain used by the routes. Records tables queried and
// returns fixture rows keyed by table name.
// ---------------------------------------------------------------------------
function makeMockSupabase({ entries = ENTRIES, clients = CLIENTS, sales = SALES } = {}) {
  const calls = [];
  function queryBuilder(table) {
    const state = { table, filters: {}, inIds: null, ordered: null };
    const builder = {
      select() {
        return builder;
      },
      eq(col, val) {
        state.filters[col] = val;
        return builder;
      },
      gte(col, val) {
        state.filters['gte_' + col] = val;
        return builder;
      },
      lte(col, val) {
        state.filters['lte_' + col] = val;
        return builder;
      },
      in(col, ids) {
        state.inIds = ids;
        return builder;
      },
      order(col, opts) {
        state.ordered = { col, ...opts };
        return builder;
      },
      then(resolve, reject) {
        // Awaiting the builder resolves the query.
        return Promise.resolve(resolveQuery()).then(resolve, reject);
      },
    };
    function resolveQuery() {
      calls.push({ table, ...state });
      if (table === 'time_entries') {
        let rows = entries.slice();
        if (state.ordered && state.ordered.ascending === false) {
          rows = rows.slice().reverse();
        }
        return { data: rows, error: null };
      }
      if (table === 'client_entries') {
        const rows = clients.filter((c) => (state.inIds || []).includes(c.time_entry_id));
        return { data: rows, error: null };
      }
      if (table === 'product_sales') {
        const rows = sales.filter((s) => (state.inIds || []).includes(s.time_entry_id));
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    }
    return builder;
  }
  return {
    __calls: calls,
    from(table) {
      return queryBuilder(table);
    },
  };
}

async function runTests() {
  console.log('\naggregateEntries (pure math):');

  const grouped = (rows) => {
    const by = {};
    for (const r of rows) {
      (by[r.time_entry_id] = by[r.time_entry_id] || []).push(r);
    }
    return by;
  };

  await test('per-entry aggregates match hand-computed day values', () => {
    const { perEntry } = aggregateEntries(
      ENTRIES,
      grouped(CLIENTS),
      grouped(SALES),
      HOURLY_WAGE,
    );
    assert.strictEqual(perEntry.length, 3);

    const d1 = perEntry[0];
    assert.strictEqual(d1.commissions, 65);
    assert.strictEqual(d1.tips, 15);
    assert.strictEqual(d1.cashTips, 10);
    assert.strictEqual(d1.productCommissions, 12);
    assert.strictEqual(d1.wages, 160);

    const d2 = perEntry[1];
    assert.strictEqual(d2.commissions, 30);
    assert.strictEqual(d2.tips, 8);
    assert.strictEqual(d2.cashTips, 0);
    assert.strictEqual(d2.productCommissions, 0);
    assert.strictEqual(d2.wages, 100);

    const d3 = perEntry[2];
    assert.strictEqual(d3.commissions, 15);
    assert.strictEqual(d3.tips, 0); // null tip_amount coerced to 0
    assert.strictEqual(d3.cashTips, 0);
    assert.strictEqual(d3.productCommissions, 7); // null + 7
    assert.strictEqual(d3.wages, 130);
  });

  await test('rolled-up totals match hand-computed period values', () => {
    const { totals } = aggregateEntries(
      ENTRIES,
      grouped(CLIENTS),
      grouped(SALES),
      HOURLY_WAGE,
    );
    assert.strictEqual(totals.totalHours, 19.5);
    assert.strictEqual(totals.totalCommissions, 110);
    assert.strictEqual(totals.totalTips, 23);
    assert.strictEqual(totals.totalCashTips, 10);
    assert.strictEqual(totals.totalProductCommissions, 19);
    assert.strictEqual(totals.totalWages, 390);
    assert.strictEqual(totals.totalPayable, 532);
  });

  await test('payable formula = wages + comm + tips + prodComm - cashTips', () => {
    const { totals } = aggregateEntries(
      ENTRIES,
      grouped(CLIENTS),
      grouped(SALES),
      HOURLY_WAGE,
    );
    assert.strictEqual(
      totals.totalPayable,
      totals.totalWages +
        totals.totalCommissions +
        totals.totalTips +
        totals.totalProductCommissions -
        totals.totalCashTips,
    );
  });

  await test('preserves each entry base fields (id, date, hours)', () => {
    const { perEntry } = aggregateEntries(ENTRIES, grouped(CLIENTS), grouped(SALES), HOURLY_WAGE);
    assert.strictEqual(perEntry[0].id, 101);
    assert.strictEqual(perEntry[0].date, '2026-01-01');
    assert.strictEqual(perEntry[0].hours, 8);
  });

  await test('includes the raw grouped clients/products on each entry', () => {
    const { perEntry } = aggregateEntries(ENTRIES, grouped(CLIENTS), grouped(SALES), HOURLY_WAGE);
    assert.strictEqual(perEntry[0].clients.length, 2);
    assert.strictEqual(perEntry[0].products.length, 1);
    assert.strictEqual(perEntry[2].clients.length, 1);
    assert.strictEqual(perEntry[2].products.length, 2);
  });

  await test('null/undefined hourlyWage treated as 0 wages', () => {
    const { totals } = aggregateEntries(ENTRIES, grouped(CLIENTS), grouped(SALES), null);
    assert.strictEqual(totals.totalWages, 0);
    // payable then = 0 + 110 + 23 + 19 - 10 = 142
    assert.strictEqual(totals.totalPayable, 142);
  });

  await test('empty entries → all-zero totals, empty perEntry', () => {
    const { perEntry, totals } = aggregateEntries([], {}, {}, HOURLY_WAGE);
    assert.strictEqual(perEntry.length, 0);
    assert.strictEqual(totals.totalHours, 0);
    assert.strictEqual(totals.totalPayable, 0);
  });

  await test('missing entries arg (null) is safe', () => {
    const { perEntry, totals } = aggregateEntries(null, null, null, HOURLY_WAGE);
    assert.strictEqual(perEntry.length, 0);
    assert.strictEqual(totals.totalPayable, 0);
  });

  console.log('\nfetchInvoiceSummary (batched fetch + aggregate):');

  await test('fetches entries, clients, sales and returns totals', async () => {
    const sb = makeMockSupabase();
    const result = await fetchInvoiceSummary(sb, {
      employeeId: 1,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-15',
      hourlyWage: HOURLY_WAGE,
    });
    assert.strictEqual(result.totals.totalPayable, 532);
    assert.strictEqual(result.entries.length, 3);
    // Queried all three tables
    const tables = sb.__calls.map((c) => c.table);
    assert.ok(tables.includes('time_entries'));
    assert.ok(tables.includes('client_entries'));
    assert.ok(tables.includes('product_sales'));
  });

  await test('no time entries → skips client/sales queries, zero totals', async () => {
    const sb = makeMockSupabase({ entries: [] });
    const result = await fetchInvoiceSummary(sb, {
      employeeId: 1,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-15',
      hourlyWage: HOURLY_WAGE,
    });
    assert.strictEqual(result.entries.length, 0);
    assert.strictEqual(result.totals.totalPayable, 0);
    // Must NOT issue an .in() query with an empty id list
    const tables = sb.__calls.map((c) => c.table);
    assert.ok(!tables.includes('client_entries'));
    assert.ok(!tables.includes('product_sales'));
  });

  await test('descending order option reverses entry order', async () => {
    const sb = makeMockSupabase();
    const result = await fetchInvoiceSummary(sb, {
      employeeId: 1,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-15',
      hourlyWage: HOURLY_WAGE,
      order: { column: 'date', ascending: false },
    });
    assert.strictEqual(result.entries[0].date, '2026-01-03');
    assert.strictEqual(result.entries[2].date, '2026-01-01');
    // Totals are order-independent
    assert.strictEqual(result.totals.totalPayable, 532);
  });

  console.log('\n' + '='.repeat(50));
  console.log(`Invoice summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
