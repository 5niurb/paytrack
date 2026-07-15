'use strict';

// Route module: invoices. Extracted verbatim from server.js (Wave 2.B split).
// Shared clients/helpers are injected via init(deps) and destructured into
// module-scoped vars with the same names the handlers use, so the route bodies
// are byte-identical to the original server.js implementation.

const express = require('express');
const router = express.Router();
const { fetchInvoiceSummary } = require('../lib/invoice-summary');
const debug = require('../lib/debug');
const { encryptValue } = require('../lib/crypto');
const { formatDateForDB, getPayPeriodByOffset } = require('../lib/pay-periods');

let supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD, verifyEmployeePin, getLATodayString, buildInvoiceImageSvg, sendInvoiceEmail, sendInvoiceSms;

function init(deps) {
  ({ supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD, verifyEmployeePin, getLATodayString, buildInvoiceImageSvg, sendInvoiceEmail, sendInvoiceSms } = deps);
}

router.get('/api/invoice-media/:invoiceId', async (req, res) => {
  // Require admin authentication before exposing employee PII and financial data.
  // Uses the timing-safe helper; references process.env.ADMIN_PASSWORD directly
  // because the ADMIN_PASSWORD const is declared later in the file (after this route).
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return res.status(503).send('Image generation not available');
  }

  const { invoiceId } = req.params;

  const { data: inv } = await supabaseAdmin
    .from('invoices')
    .select([
      'employee_id',
      'pay_period_start',
      'pay_period_end',
      'total_payable',
      'total_hours',
      'total_wages',
      'total_commissions',
      'total_product_commissions',
      'total_tips',
      'cash_tips_received'
    ].join(', '))
    .eq('id', invoiceId)
    .single();
  if (!inv) return res.status(404).send('Not found');

  const { data: emp } = await supabaseAdmin
    .from('employees')
    .select('name, hourly_wage')
    .eq('id', inv.employee_id)
    .single();

  const { data: rawPayouts } = await supabaseAdmin
    .from('payments')
    .select('payment_date, amount')
    .eq('employee_id', inv.employee_id)
    .gte('payment_date', inv.pay_period_start)
    .lte('payment_date', inv.pay_period_end);

  const payoutsByDate = {};
  for (const p of rawPayouts || []) {
    payoutsByDate[p.payment_date] =
      (payoutsByDate[p.payment_date] || 0) + parseFloat(p.amount || 0);
  }

  // Batched fetch + aggregation via the shared helper. Payouts are a route-only
  // concern (not part of the commissions/tips math) and are merged in below.
  const { entries: aggregated } = await fetchInvoiceSummary(supabaseAdmin, {
    employeeId: inv.employee_id,
    periodStart: inv.pay_period_start,
    periodEnd: inv.pay_period_end,
    hourlyWage: emp?.hourly_wage || 0,
  });

  const entries = aggregated.map((e) => ({
    date: e.date,
    hours: e.hours,
    wages: e.wages,
    commissions: e.commissions,
    productCommissions: e.productCommissions,
    tips: e.tips,
    cashTips: e.cashTips,
    payouts: payoutsByDate[e.date] || 0,
  }));

  const svgStr = buildInvoiceImageSvg(
    emp?.name || 'Employee',
    inv.pay_period_start,
    inv.pay_period_end,
    { totalPayable: parseFloat(inv.total_payable || 0) },
    entries,
  );

  try {
    const png = await sharp(Buffer.from(svgStr)).png().toBuffer();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    console.error('[InvoiceMedia] sharp error:', err.message);
    res.status(500).send('Image generation failed');
  }
});

router.get('/api/pay-period/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const { offset } = req.query;
  const pin = req.headers['x-employee-pin'];

  if (!(await verifyEmployeePin(employeeId, pin))) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const periodOffset = parseInt(offset) || 0;
  const laToday = getLATodayString();
  const period = getPayPeriodByOffset(periodOffset, laToday);

  const startDate = formatDateForDB(period.start);
  const endDate = formatDateForDB(period.end);

  // Get employee info
  const { data: employee } = await supabaseAdmin
    .from('employees')
    .select('hourly_wage, pay_type')
    .eq('id', parseInt(employeeId))
    .single();

  const hourlyWage = employee?.hourly_wage || 0;

  // Batched fetch + aggregation via the shared helper (single source of truth
  // for commissions/tips/wages/payable math — see lib/invoice-summary.js).
  const { entries: aggregated, totals } = await fetchInvoiceSummary(supabaseAdmin, {
    employeeId: parseInt(employeeId),
    periodStart: startDate,
    periodEnd: endDate,
    hourlyWage,
  });

  // Check if invoice already submitted for this period
  const { data: existingInvoice } = await supabaseAdmin
    .from('invoices')
    .select('id, submitted_at')
    .eq('employee_id', parseInt(employeeId))
    .eq('pay_period_start', startDate)
    .eq('pay_period_end', endDate)
    .single();

  res.json({
    periodStart: startDate,
    periodEnd: endDate,
    periodOffset,
    totalHours: totals.totalHours,
    totalWages: totals.totalWages,
    totalCommissions: totals.totalCommissions,
    totalTips: totals.totalTips,
    totalCashTips: totals.totalCashTips,
    totalProductCommissions: totals.totalProductCommissions,
    totalPayable: totals.totalPayable,
    hourlyWage,
    // Preserve the original response shape: bare time-entry rows (id, date, hours),
    // not the aggregated day objects.
    entries: aggregated.map((e) => ({ id: e.id, date: e.date, hours: e.hours })),
    invoiceSubmitted: !!existingInvoice,
    invoiceDate: existingInvoice?.submitted_at
  });
});

router.post('/api/submit-invoice', async (req, res) => {
  const {
    employeeId,
    periodStart,
    periodEnd,
    totalHours,
    totalWages,
    totalCommissions,
    totalTips,
    totalCashTips,
    totalProductCommissions,
    totalPayable
  } = req.body;

  const pin = req.headers['x-employee-pin'];
  const validPin = await verifyEmployeePin(employeeId, pin);
  if (!validPin) {
    return res.status(401).json({ success: false, message: 'Invalid PIN' });
  }

  // Check if already submitted
  const { data: existing } = await supabaseAdmin
    .from('invoices')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('pay_period_start', periodStart)
    .eq('pay_period_end', periodEnd)
    .single();

  if (existing) {
    return res.json({ success: false, message: 'Invoice already submitted for this pay period' });
  }

  // Get employee details
  const { data: employee } = await supabaseAdmin
    .from('employees')
    .select('name, email, hourly_wage')
    .eq('id', employeeId)
    .single();

  // Create invoice record
  const { data: invoice, error } = await supabaseAdmin
    .from('invoices')
    .insert({
      employee_id: employeeId,
      pay_period_start: periodStart,
      pay_period_end: periodEnd,
      total_hours: totalHours,
      total_wages: totalWages,
      total_commissions: totalCommissions,
      total_tips: totalTips,
      total_product_commissions: totalProductCommissions,
      cash_tips_received: totalCashTips,
      total_payable: totalPayable,
      email_sent: false
    })
    .select()
    .single();

  if (error) {
    return res.json({ success: false, message: 'Failed to create invoice' });
  }

  // Fetch payouts for the period
  const { data: emailPayouts } = await supabaseAdmin
    .from('payments')
    .select('payment_date, amount')
    .eq('employee_id', employeeId)
    .gte('payment_date', periodStart)
    .lte('payment_date', periodEnd);

  const payoutsByDate = {};
  let totalPayouts = 0;
  for (const p of (emailPayouts || [])) {
    payoutsByDate[p.payment_date] = (payoutsByDate[p.payment_date] || 0) + parseFloat(p.amount || 0);
    totalPayouts += parseFloat(p.amount || 0);
  }

  // Batched fetch + aggregation via the shared helper for the email/SMS detail
  // table. Note: this route trusts the client-supplied period totals in the
  // request body (inserted into the invoice above) and only recomputes the
  // per-day breakdown here. Payouts are merged in below (route-only concern).
  const { entries: aggregated } = await fetchInvoiceSummary(supabaseAdmin, {
    employeeId,
    periodStart,
    periodEnd,
    hourlyWage: employee?.hourly_wage || 0,
  });

  const detailedEntries = aggregated.map((e) => ({
    date: e.date,
    hours: e.hours,
    wages: e.wages,
    commissions: e.commissions,
    productCommissions: e.productCommissions,
    tips: e.tips,
    cashTips: e.cashTips,
    payouts: payoutsByDate[e.date] || 0,
  }));

  // Try to send email
  const employeeData = {
    name: employee?.name,
    email: employee?.email,
    hourlyWage: employee?.hourly_wage || 0
  };
  const summaryData = {
    totalHours,
    totalWages,
    totalCommissions,
    totalProductCommissions,
    totalTips,
    totalCashTips,
    totalPayouts,
    totalPayable
  };
  const emailResult = await sendInvoiceEmail(
    employeeData,
    periodStart,
    periodEnd,
    summaryData,
    detailedEntries
  );

  // Try to send MMS to Lea with entries table image
  const smsResult = await sendInvoiceSms(
    employee?.name,
    periodStart,
    periodEnd,
    totalPayable,
    detailedEntries,
    invoice.id,
  );

  // Log invoice details
  debug.log(`
╔════════════════════════════════════════════════════════════╗
║                    INVOICE SUBMITTED                       ║
╠════════════════════════════════════════════════════════════╣
║  Employee: ${employee?.name}
║  Period: ${periodStart} to ${periodEnd}
║
║  Hours: ${totalHours.toFixed(2)}
║  Wages: $${totalWages.toFixed(2)}
║  Commissions: $${totalCommissions.toFixed(2)}
║  Product Commissions: $${totalProductCommissions.toFixed(2)}
║  Tips: $${totalTips.toFixed(2)}
║  Cash Tips (already paid): $${totalCashTips.toFixed(2)}
║
║  TOTAL PAYABLE: $${totalPayable.toFixed(2)}
║
║  Email: ${emailResult.sent ? 'SENT' : 'NOT SENT - ' + emailResult.reason}
║  SMS:   ${smsResult.sent ? 'SENT to Lea' : 'NOT SENT - ' + smsResult.reason}
╚════════════════════════════════════════════════════════════╝
  `);

  // Mark email as sent if successful
  if (emailResult.sent) {
    await supabaseAdmin
      .from('invoices')
      .update({ email_sent: true })
      .eq('id', invoice.id);
  }

  res.json({
    success: true,
    message: emailResult.sent ? 'Invoice submitted and email sent!' : 'Invoice submitted (email not configured)',
    invoiceId: invoice.id,
    emailSent: emailResult.sent
  });
});

router.get('/api/invoice-preview/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const { periodStart, periodEnd } = req.query;

  const pin = req.headers['x-employee-pin'];
  const validPin = await verifyEmployeePin(employeeId, pin);
  if (!validPin) {
    return res.status(401).json({ success: false, message: 'Invalid PIN' });
  }

  const { data: employee, error: empError } = await supabaseAdmin
    .from('employees')
    .select('id, name, email, hourly_wage, pay_type')
    .eq('id', parseInt(employeeId))
    .single();

  if (empError || !employee) {
    return res.status(404).json({ success: false, message: 'Employee not found' });
  }

  // Get today's date in LA timezone to filter out future entries
  const todayLA = getLATodayString();

  // Use the earlier of periodEnd or today (to exclude future dates)
  const effectiveEndDate = periodEnd <= todayLA ? periodEnd : todayLA;

  // Batched fetch + aggregation via the shared helper. This route widens the
  // selected columns (start_time/end_time, client_name/procedure_name,
  // product_name/sale_amount) for its detailed UI, orders descending (most
  // recent first), and clamps to today's LA date to hide future entries.
  const { entries: aggregated, totals } = await fetchInvoiceSummary(supabaseAdmin, {
    employeeId: parseInt(employeeId),
    periodStart,
    periodEnd: effectiveEndDate,
    hourlyWage: employee.hourly_wage,
    order: { column: 'date', ascending: false },
    entryColumns: 'id, date, start_time, end_time, hours',
    clientColumns: 'time_entry_id, client_name, procedure_name, amount_earned, tip_amount, tip_received_cash',
    productColumns: 'time_entry_id, product_name, sale_amount, commission_amount',
  });

  const detailedEntries = aggregated.map((e) => ({
    id: e.id, // Include entry ID for delete functionality
    date: e.date,
    startTime: e.start_time,
    endTime: e.end_time,
    hours: e.hours,
    wages: e.wages,
    commissions: e.commissions,
    productCommissions: e.productCommissions,
    tips: e.tips,
    cashTips: e.cashTips,
    clients: e.clients,
    products: e.products,
  }));

  res.json({
    employee: {
      name: employee.name,
      email: employee.email,
      hourlyWage: employee.hourly_wage
    },
    periodStart,
    periodEnd,
    entries: detailedEntries,
    summary: {
      totalHours: totals.totalHours,
      totalWages: totals.totalWages,
      totalCommissions: totals.totalCommissions,
      totalProductCommissions: totals.totalProductCommissions,
      totalTips: totals.totalTips,
      totalCashTips: totals.totalCashTips,
      totalPayable: totals.totalPayable
    }
  });
});

router.get('/api/employee/payouts/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const { periodStart, periodEnd } = req.query;

  const pin = req.headers['x-employee-pin'];
  const validPin = await verifyEmployeePin(employeeId, pin);
  if (!validPin) {
    return res.status(401).json({ success: false, message: 'Invalid PIN' });
  }

  if (!periodStart || !periodEnd) {
    return res.status(400).json({ success: false, message: 'periodStart and periodEnd required' });
  }

  const { data, error } = await supabaseAdmin
    .from('payments')
    .select('payment_date, amount')
    .eq('employee_id', parseInt(employeeId))
    .gte('payment_date', periodStart)
    .lte('payment_date', periodEnd);

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

router.get('/api/admin/invoices', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { data: invoices, error } = await supabaseAdmin
    .from('invoices')
    .select(`
      *,
      employees (
        name
      )
    `)
    .order('submitted_at', { ascending: false });

  const transformedInvoices = (invoices || []).map(inv => ({
    ...inv,
    employee_name: inv.employees?.name
  }));

  res.json(transformedInvoices);
});

router.get('/api/admin/tax-filings', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { year, employee_id } = req.query;

  let query = supabaseAdmin
    .from('tax_filings')
    .select(
      `id, employee_id, tax_year, form_type, filing_status, filed_at,
       recipient_name, tin_last4, tin_type, federal_id_type,
       box_1_nonemployee_comp, box_4_federal_tax_withheld,
       address_city, address_state, address_zip,
       source, notes, created_at, updated_at,
       employees ( name, email )`,
    )
    .order('tax_year', { ascending: false })
    .order('recipient_name', { ascending: true });

  if (year) query = query.eq('tax_year', parseInt(year));
  if (employee_id) query = query.eq('employee_id', parseInt(employee_id));

  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

router.get('/api/admin/filings-1099', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { year } = req.query;

  let query = supabaseAdmin
    .from('filings_1099')
    .select(
      'id, tax_year, form, irs_submit_date, email_recipient_date, tin_type, tin_match, recipient_name, tin_last4, box1_nonemployee_comp, city, state, zip, email, created_at',
    )
    .order('tax_year', { ascending: false })
    .order('recipient_name', { ascending: true });

  if (year) query = query.eq('tax_year', parseInt(year));

  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

router.get('/api/admin/tax-filings/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { data, error } = await supabaseAdmin
    .from('tax_filings')
    .select('*')
    .eq('id', parseInt(req.params.id))
    .single();

  if (error) return res.status(404).json({ success: false, message: 'Not found' });
  res.json(data);
});

router.post('/api/admin/tax-filings', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const body = req.body;

  // Encrypt TIN if provided
  let tin_encrypted = null;
  let tin_last4 = body.tin_last4 || null;
  if (body.tin_raw) {
    tin_encrypted = await encryptValue(body.tin_raw);
    tin_last4 = body.tin_raw.replace(/\D/g, '').slice(-4) || null;
  }

  const { data, error } = await supabaseAdmin
    .from('tax_filings')
    .insert({
      employee_id: body.employee_id ? parseInt(body.employee_id) : null,
      tax_year: parseInt(body.tax_year),
      form_type: body.form_type || '1099-NEC',
      filing_status: body.filing_status || 'draft',
      filed_at: body.filed_at || null,
      payer_name: body.payer_name || 'LM Operations Inc',
      payer_ein: body.payer_ein || null,
      payer_state_no: body.payer_state_no || null,
      reference_id: body.reference_id || null,
      recipient_name: body.recipient_name,
      recipient_second_name: body.recipient_second_name || null,
      federal_id_type: body.federal_id_type ? parseInt(body.federal_id_type) : null,
      tin_last4,
      tin_encrypted,
      second_tin_notice: body.second_tin_notice || false,
      account_number: body.account_number || null,
      office_code: body.office_code || null,
      address_street: body.address_street || null,
      address_street2: body.address_street2 || null,
      address_city: body.address_city || null,
      address_state: body.address_state || null,
      address_zip: body.address_zip || null,
      address_province: body.address_province || null,
      address_country_code: body.address_country_code || 'US',
      recipient_email: body.recipient_email || null,
      box_1_nonemployee_comp: parseFloat(body.box_1_nonemployee_comp) || 0,
      box_2_direct_sales: body.box_2_direct_sales || false,
      box_3_golden_parachute: body.box_3_golden_parachute ? parseFloat(body.box_3_golden_parachute) : null,
      box_4_federal_tax_withheld: body.box_4_federal_tax_withheld ? parseFloat(body.box_4_federal_tax_withheld) : null,
      box_5_state_tax_withheld: body.box_5_state_tax_withheld ? parseFloat(body.box_5_state_tax_withheld) : null,
      box_6_state: body.box_6_state || null,
      box_7_state_income: body.box_7_state_income ? parseFloat(body.box_7_state_income) : null,
      box_5b_local_tax_withheld: body.box_5b_local_tax_withheld ? parseFloat(body.box_5b_local_tax_withheld) : null,
      box_6b_locality: body.box_6b_locality || null,
      box_6b_locality_no: body.box_6b_locality_no || null,
      box_7b_local_income: body.box_7b_local_income ? parseFloat(body.box_7b_local_income) : null,
      source: body.source || 'manual',
      notes: body.notes || null,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ success: false, message: error.message });
  res.json({ success: true, data });
});

router.put('/api/admin/tax-filings/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const body = req.body;
  const updates = { updated_at: new Date().toISOString() };

  const allowed = [
    'filing_status', 'filed_at', 'payer_name', 'payer_ein', 'payer_state_no', 'reference_id',
    'recipient_name', 'recipient_second_name', 'federal_id_type', 'second_tin_notice',
    'account_number', 'office_code', 'address_street', 'address_street2', 'address_city',
    'address_state', 'address_zip', 'address_province', 'address_country_code', 'recipient_email',
    'box_1_nonemployee_comp', 'box_2_direct_sales', 'box_3_golden_parachute',
    'box_4_federal_tax_withheld', 'box_5_state_tax_withheld', 'box_6_state', 'box_7_state_income',
    'box_5b_local_tax_withheld', 'box_6b_locality', 'box_6b_locality_no', 'box_7b_local_income',
    'source', 'notes',
  ];

  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  // Handle TIN re-encryption if raw value supplied
  if (body.tin_raw) {
    updates.tin_encrypted = await encryptValue(body.tin_raw);
    updates.tin_last4 = body.tin_raw.replace(/\D/g, '').slice(-4) || null;
  }

  const { data, error } = await supabaseAdmin
    .from('tax_filings')
    .update(updates)
    .eq('id', parseInt(req.params.id))
    .select()
    .single();

  if (error) return res.status(400).json({ success: false, message: error.message });
  res.json({ success: true, data });
});

router.delete('/api/admin/tax-filings/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { error } = await supabaseAdmin.from('tax_filings').delete().eq('id', parseInt(req.params.id));
  if (error) return res.status(400).json({ success: false, message: error.message });
  res.json({ success: true });
});

router.get('/api/admin/tax-filings/export/:year', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const year = parseInt(req.params.year);

  const { data, error } = await supabaseAdmin
    .from('tax_filings')
    .select('*')
    .eq('tax_year', year)
    .order('recipient_name', { ascending: true });

  if (error) return res.status(500).json({ success: false, message: error.message });

  const rows = data || [];
  const headers = [
    'Reference ID', "Recipient's Name", "Recipient's Second Name",
    'Federal ID Type', 'Federal ID Number', 'Second TIN Notice', 'Account Number', 'Office Code',
    'Street Address', 'Street Address 2', 'City', 'State', 'ZIP', 'Province', 'Country Code',
    'Email',
    'Box 1 Nonemployee Compensation', 'Box 2 Direct Sales Indicator',
    'Box 3 Other Income', 'Box 4 Federal Income Tax Withheld',
    'Box 5 State Tax Withheld', 'Box 6 State', "Payer's State No", 'Box 7 State Income',
    'Box 5b Local Tax Withheld', 'Box 6b Locality', 'Box 6b Locality No', 'Box 7b Local Income',
  ];

  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csvLines = [headers.join(',')];
  for (const r of rows) {
    csvLines.push([
      r.reference_id, r.recipient_name, r.recipient_second_name,
      r.federal_id_type, r.tin_last4 ? `***${r.tin_last4}` : '', r.second_tin_notice ? '1' : '', r.account_number, r.office_code,
      r.address_street, r.address_street2, r.address_city, r.address_state, r.address_zip, r.address_province, r.address_country_code || 'US',
      r.recipient_email,
      r.box_1_nonemployee_comp, r.box_2_direct_sales ? '1' : '',
      r.box_3_golden_parachute, r.box_4_federal_tax_withheld,
      r.box_5_state_tax_withheld, r.box_6_state, r.payer_state_no, r.box_7_state_income,
      r.box_5b_local_tax_withheld, r.box_6b_locality, r.box_6b_locality_no, r.box_7b_local_income,
    ].map(escape).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="1099-NEC-${year}.csv"`);
  res.send(csvLines.join('\r\n'));
});

router.get('/api/admin/payments', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  let query = supabaseAdmin
    .from('payments')
    .select('*')
    .order('payment_date', { ascending: false })
    .order('id', { ascending: false });

  if (req.query.employee_id) query = query.eq('employee_id', parseInt(req.query.employee_id));
  if (req.query.start_date) query = query.gte('payment_date', req.query.start_date);
  if (req.query.end_date) query = query.lte('payment_date', req.query.end_date);
  if (req.query.auto_imported === 'true') query = query.eq('auto_imported', true);
  if (req.query.limit) query = query.limit(parseInt(req.query.limit));

  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

router.get('/api/admin/payments/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { data, error } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('id', parseInt(req.params.id))
    .single();

  if (error) return res.status(404).json({ success: false, message: 'Not found' });
  res.json(data);
});

router.post('/api/admin/payments', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { employee_id, teammate_name, payment_date, amount, payment_method, source, notes } = req.body;
  if (!teammate_name || !payment_date || !amount) {
    return res.status(400).json({ success: false, message: 'teammate_name, payment_date, and amount are required' });
  }

  const { data, error } = await supabaseAdmin
    .from('payments')
    .insert({ employee_id: employee_id || null, teammate_name, payment_date, amount: parseFloat(amount), payment_method, source: source || null, notes })
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, payment: data });
});

router.put('/api/admin/payments/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { employee_id, teammate_name, payment_date, amount, payment_method, source, notes } = req.body;
  const updates = {};
  if (employee_id !== undefined) updates.employee_id = employee_id || null;
  if (teammate_name !== undefined) updates.teammate_name = teammate_name;
  if (payment_date !== undefined) updates.payment_date = payment_date;
  if (amount !== undefined) updates.amount = parseFloat(amount);
  if (payment_method !== undefined) updates.payment_method = payment_method;
  if (source !== undefined) updates.source = source || null;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabaseAdmin
    .from('payments')
    .update(updates)
    .eq('id', parseInt(req.params.id))
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, payment: data });
});

router.delete('/api/admin/payments/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { error } = await supabaseAdmin.from('payments').delete().eq('id', parseInt(req.params.id));
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
});

module.exports = { router, init };
