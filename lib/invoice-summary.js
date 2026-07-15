'use strict';

// Shared invoice/pay-period aggregation.
//
// The same batched "group client_entries + product_sales by time_entry, sum
// commissions / tips / cash-tips / product-commissions, compute wages and
// payable" logic used to be copy-pasted into four server.js routes
// (pay-period summary, submit-invoice email detail, invoice-media image,
// invoice-preview). This module owns that math once so the four routes can't
// drift apart. Routes still handle their own concerns (payouts, extra display
// columns, date clamping, ordering) around this core.
//
// Money-math contract (must stay byte-identical to the pre-extraction routes):
//   dayCommissions        += client.amount_earned      || 0
//   dayTips               += client.tip_amount         || 0
//   if (client.tip_received_cash) dayCashTips += client.tip_amount || 0
//   dayProductCommissions += sale.commission_amount    || 0
//   wages                  = entry.hours * (hourlyWage || 0)
//   totalPayable = totalWages + totalCommissions + totalTips
//                  + totalProductCommissions - totalCashTips

/**
 * Pure aggregation. No I/O. Given time entries plus client/product rows already
 * grouped by time_entry_id, produce per-entry day aggregates and rolled-up
 * period totals.
 *
 * @param {Array} entries              time_entries rows (id, date, hours, ...)
 * @param {Object} clientsByEntry      { [time_entry_id]: client_entries[] }
 * @param {Object} salesByEntry        { [time_entry_id]: product_sales[] }
 * @param {number} hourlyWage          employee hourly wage (nullish → 0)
 * @returns {{ perEntry: Array, totals: Object }}
 */
function aggregateEntries(entries, clientsByEntry, salesByEntry, hourlyWage) {
  const wage = hourlyWage || 0;
  const clientsBy = clientsByEntry || {};
  const salesBy = salesByEntry || {};

  const perEntry = [];
  let totalHours = 0;
  let totalCommissions = 0;
  let totalTips = 0;
  let totalCashTips = 0;
  let totalProductCommissions = 0;

  for (const entry of entries || []) {
    const clients = clientsBy[entry.id] || [];
    const sales = salesBy[entry.id] || [];

    let dayCommissions = 0;
    let dayTips = 0;
    let dayCashTips = 0;
    let dayProductCommissions = 0;

    for (const c of clients) {
      dayCommissions += c.amount_earned || 0;
      dayTips += c.tip_amount || 0;
      if (c.tip_received_cash) dayCashTips += c.tip_amount || 0;
    }
    for (const s of sales) {
      dayProductCommissions += s.commission_amount || 0;
    }

    totalHours += entry.hours;
    totalCommissions += dayCommissions;
    totalTips += dayTips;
    totalCashTips += dayCashTips;
    totalProductCommissions += dayProductCommissions;

    perEntry.push({
      ...entry,
      wages: entry.hours * wage,
      commissions: dayCommissions,
      productCommissions: dayProductCommissions,
      tips: dayTips,
      cashTips: dayCashTips,
      clients,
      products: sales,
    });
  }

  const totalWages = totalHours * wage;

  return {
    perEntry,
    totals: {
      totalHours,
      totalWages,
      totalCommissions,
      totalTips,
      totalCashTips,
      totalProductCommissions,
      totalPayable:
        totalWages + totalCommissions + totalTips + totalProductCommissions - totalCashTips,
    },
  };
}

/**
 * Batched fetch + aggregate. Loads the period's time entries, then the related
 * client_entries and product_sales in one `.in()` query each (avoiding the N+1
 * pattern), groups them, and runs aggregateEntries.
 *
 * @param {object} supabase           Supabase client (service-role in prod)
 * @param {object} opts
 * @param {number|string} opts.employeeId
 * @param {string} opts.periodStart    inclusive lower bound (date column)
 * @param {string} opts.periodEnd      inclusive upper bound (date column)
 * @param {number} opts.hourlyWage
 * @param {{column:string, ascending:boolean}} [opts.order]  entry ordering
 *        (default ascending by date)
 * @param {string} [opts.entryColumns='id, date, hours']  columns to select from
 *        time_entries (routes that need start_time/end_time widen this)
 * @param {string} [opts.clientColumns] columns to select from client_entries
 * @param {string} [opts.productColumns] columns to select from product_sales
 * @returns {Promise<{ entries: Array, totals: Object }>}
 *          `entries` is the per-entry aggregate array from aggregateEntries.
 */
async function fetchInvoiceSummary(supabase, opts) {
  const {
    employeeId,
    periodStart,
    periodEnd,
    hourlyWage,
    order = { column: 'date', ascending: true },
    entryColumns = 'id, date, hours',
    clientColumns = 'time_entry_id, amount_earned, tip_amount, tip_received_cash',
    productColumns = 'time_entry_id, commission_amount',
  } = opts;

  const { data: entries } = await supabase
    .from('time_entries')
    .select(entryColumns)
    .eq('employee_id', employeeId)
    .gte('date', periodStart)
    .lte('date', periodEnd)
    .order(order.column, { ascending: order.ascending });

  const entryIds = (entries || []).map((e) => e.id);

  const { data: allClients } =
    entryIds.length > 0
      ? await supabase.from('client_entries').select(clientColumns).in('time_entry_id', entryIds)
      : { data: [] };

  const { data: allSales } =
    entryIds.length > 0
      ? await supabase.from('product_sales').select(productColumns).in('time_entry_id', entryIds)
      : { data: [] };

  const clientsByEntry = {};
  const salesByEntry = {};
  for (const c of allClients || []) {
    (clientsByEntry[c.time_entry_id] = clientsByEntry[c.time_entry_id] || []).push(c);
  }
  for (const s of allSales || []) {
    (salesByEntry[s.time_entry_id] = salesByEntry[s.time_entry_id] || []).push(s);
  }

  const { perEntry, totals } = aggregateEntries(entries, clientsByEntry, salesByEntry, hourlyWage);
  return { entries: perEntry, totals };
}

module.exports = { aggregateEntries, fetchInvoiceSummary };
