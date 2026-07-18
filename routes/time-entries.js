'use strict';

// Route module: time-entries. Extracted verbatim from server.js (Wave 2.B split).
// Shared clients/helpers are injected via init(deps) and destructured into
// module-scoped vars with the same names the handlers use, so the route bodies
// are byte-identical to the original server.js implementation.

const express = require('express');
const router = express.Router();
const { isEmployeeLocked, recordAttempt } = require('../lib/pin-lockout');

let supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD, verifyEmployeePin, pinRateLimit;

function init(deps) {
  ({ supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD, verifyEmployeePin, pinRateLimit } = deps);
}

// Deferred middleware: pinRateLimit is injected via init() after these routes
// are registered, so we can't pass it positionally (it would be undefined at
// registration time). This thin wrapper resolves it per-request.
function pinLimit(req, res, next) {
  return pinRateLimit(req, res, next);
}

// Per-account lockout helpers (lib/pin-lockout, migration 011). These wrap the
// store calls in try/catch so a lockout-layer failure (e.g. table not yet
// migrated) degrades to the pre-lockout behavior instead of breaking login.
// The per-IP rate limiter above stays as the first line of defense.
async function accountLocked(employeeId) {
  try {
    return await isEmployeeLocked(supabaseAdmin, employeeId);
  } catch (err) {
    console.error('[PinLockout] lock check failed:', err.message);
    return false;
  }
}

async function noteAttempt(employeeId, success) {
  try {
    await recordAttempt(supabaseAdmin, employeeId, success);
  } catch (err) {
    console.error('[PinLockout] record failed:', err.message);
  }
}

router.post('/api/verify-pin', pinLimit, async (req, res) => {
  const { pin } = req.body;

  // Select only the fields the client actually uses to render the app:
  // id (subsequent authenticated calls), name (header), pay_type (which
  // sections to show), hourly_wage (client-side earnings preview). Do not
  // return email/commission_rate at login — they're unused by the client.
  const { data: employee, error } = await supabaseAdmin
    .from('employees')
    .select('id, name, pay_type, hourly_wage')
    .eq('pin', pin)
    .single();

  if (error || !employee) {
    // No matched account to attribute this failure to (the request carries only
    // the PIN), so per-account tracking can't apply here — the per-IP limiter
    // is the throttle for unattributed guessing.
    res.json({ success: false, message: 'Invalid PIN' });
  } else if (await accountLocked(employee.id)) {
    // Locked account: respond EXACTLY like a wrong PIN. A distinct "locked"
    // message here would act as an oracle confirming the guessed PIN is
    // correct, defeating the lockout's purpose.
    res.json({ success: false, message: 'Invalid PIN' });
  } else {
    await noteAttempt(employee.id, true); // clear any stale failure counter
    res.json({ success: true, employee });
  }
});

router.post('/api/change-pin', pinLimit, async (req, res) => {
  const { employeeId, currentPin, newPin } = req.body;

  // Per-account lockout: this route names its target employee, so repeated
  // wrong-currentPin attempts against that account lock it for 15 minutes
  // (5 consecutive failures), independent of source IP. Generic message —
  // same shape the per-IP limiter uses.
  if (await accountLocked(employeeId)) {
    return res
      .status(429)
      .json({ success: false, message: 'Too many attempts. Please try again later.' });
  }

  // Verify current PIN
  const { data: employee, error: verifyError } = await supabaseAdmin
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('pin', currentPin)
    .single();

  if (verifyError || !employee) {
    await noteAttempt(employeeId, false);
    return res.json({ success: false, message: 'Current PIN is incorrect' });
  }

  await noteAttempt(employeeId, true);

  // Check if new PIN is already used
  const { data: existing } = await supabaseAdmin
    .from('employees')
    .select('id')
    .eq('pin', newPin)
    .neq('id', employeeId)
    .single();

  if (existing) {
    return res.json({ success: false, message: 'PIN already in use by another employee' });
  }

  const { error: updateError } = await supabaseAdmin
    .from('employees')
    .update({ pin: newPin })
    .eq('id', employeeId);

  if (updateError) {
    res.json({ success: false, message: 'Failed to change PIN' });
  } else {
    res.json({ success: true, message: 'PIN changed successfully' });
  }
});

router.post('/api/check-conflict', async (req, res) => {
  const { employeeId, date } = req.body;
  const pin = req.headers['x-employee-pin'];

  // Require the employee's PIN — otherwise an unauthenticated caller could probe
  // whether any employee worked on any date and read their start/end/hours.
  if (!(await verifyEmployeePin(employeeId, pin))) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { data: existing } = await supabaseAdmin
    .from('time_entries')
    .select('id, start_time, end_time, hours')
    .eq('employee_id', employeeId)
    .eq('date', date)
    .single();

  if (existing) {
    res.json({
      hasConflict: true,
      existingEntry: existing
    });
  } else {
    res.json({ hasConflict: false });
  }
});

router.delete('/api/time-entry/:id', async (req, res) => {
  const { id } = req.params;
  const { employeeId } = req.body;
  const pin = req.headers['x-employee-pin'];

  if (!(await verifyEmployeePin(employeeId, pin))) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  // Verify ownership
  const { data: entry } = await supabaseAdmin
    .from('time_entries')
    .select('id')
    .eq('id', parseInt(id))
    .eq('employee_id', employeeId)
    .single();

  if (!entry) {
    return res.status(403).json({ success: false, message: 'Not authorized' });
  }

  // Delete related records
  await supabaseAdmin.from('product_sales').delete().eq('time_entry_id', parseInt(id));
  await supabaseAdmin.from('client_entries').delete().eq('time_entry_id', parseInt(id));
  await supabaseAdmin.from('time_entries').delete().eq('id', parseInt(id));

  res.json({ success: true });
});

router.post('/api/time-entry', async (req, res) => {
  const { employeeId, date, startTime, endTime, breakMinutes, staffTreatmentMinutes, hours, description, clients, productSales } = req.body;
  const pin = req.headers['x-employee-pin'];

  if (!(await verifyEmployeePin(employeeId, pin))) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { data: timeEntry, error } = await supabaseAdmin
    .from('time_entries')
    .insert({
      employee_id: employeeId,
      date: date,
      start_time: startTime || null,
      end_time: endTime || null,
      break_minutes: breakMinutes || 0,
      staff_treatment_minutes: staffTreatmentMinutes || 0,
      hours: hours,
      description: description || ''
    })
    .select()
    .single();

  if (error) {
    // Log full detail server-side; return a generic message so we don't leak
    // table/column/constraint names from the raw Supabase error to the client.
    console.error('Failed to insert time entry:', error);
    return res.status(400).json({ success: false, message: 'Failed to save time entry' });
  }

  const timeEntryId = timeEntry.id;

  // Insert client entries if provided
  if (clients && clients.length > 0) {
    const clientData = clients.map(client => ({
      time_entry_id: timeEntryId,
      client_name: client.clientName,
      procedure_name: client.procedure || '',
      notes: client.notes || '',
      amount_earned: client.amountEarned || 0,
      tip_amount: client.tipAmount || 0,
      tip_received_cash: client.tipReceivedCash ? true : false
    }));

    await supabaseAdmin.from('client_entries').insert(clientData);
  }

  // Insert product sales if provided
  if (productSales && productSales.length > 0) {
    const salesData = productSales.map(sale => ({
      time_entry_id: timeEntryId,
      product_name: sale.productName,
      sale_amount: sale.saleAmount || 0,
      commission_amount: sale.commissionAmount || 0,
      notes: sale.notes || ''
    }));

    await supabaseAdmin.from('product_sales').insert(salesData);
  }

  res.json({ success: true, id: timeEntryId });
});

router.get('/api/time-entries/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const pin = req.headers['x-employee-pin'];

  if (!(await verifyEmployeePin(employeeId, pin))) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { data: entries, error } = await supabaseAdmin
    .from('time_entries')
    .select('id, date, start_time, end_time, break_minutes, staff_treatment_minutes, hours, description, created_at')
    .eq('employee_id', parseInt(employeeId))
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    return res.json([]);
  }

  // Get client entries and product sales for each time entry
  for (const entry of entries) {
    const { data: clients } = await supabaseAdmin
      .from('client_entries')
      .select('id, client_name, procedure_name, notes, amount_earned, tip_amount, tip_received_cash')
      .eq('time_entry_id', entry.id);

    const { data: productSales } = await supabaseAdmin
      .from('product_sales')
      .select('id, product_name, sale_amount, commission_amount, notes')
      .eq('time_entry_id', entry.id);

    entry.clients = clients || [];
    entry.productSales = productSales || [];
  }

  res.json(entries);
});

router.get('/api/admin/time-entries', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { startDate, endDate, employeeId } = req.query;

  let query = supabaseAdmin
    .from('time_entries')
    .select(`
      id,
      date,
      start_time,
      end_time,
      break_minutes,
      staff_treatment_minutes,
      hours,
      description,
      created_at,
      employee_id,
      employees (
        id,
        name,
        hourly_wage,
        commission_rate,
        pay_type
      )
    `)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });

  if (startDate && endDate) {
    query = query.gte('date', startDate).lte('date', endDate);
  }

  if (employeeId) {
    query = query.eq('employee_id', parseInt(employeeId));
  }

  const { data: entries, error } = await query;

  if (error) {
    return res.json([]);
  }

  // Batch query all client_entries and product_sales for O(1) lookup
  const entryIds = (entries || []).map(e => e.id);
  const { data: allClients } = entryIds.length > 0
    ? await supabaseAdmin
        .from('client_entries')
        .select('id, time_entry_id, client_name, procedure_name, notes, amount_earned, tip_amount, tip_received_cash')
        .in('time_entry_id', entryIds)
    : { data: [] };

  const { data: allProductSales } = entryIds.length > 0
    ? await supabaseAdmin
        .from('product_sales')
        .select('id, time_entry_id, product_name, sale_amount, commission_amount, notes')
        .in('time_entry_id', entryIds)
    : { data: [] };

  // Group by time_entry_id for O(1) lookup
  const clientsByEntry = {};
  const productsByEntry = {};
  (allClients || []).forEach(c => {
    if (!clientsByEntry[c.time_entry_id]) clientsByEntry[c.time_entry_id] = [];
    clientsByEntry[c.time_entry_id].push(c);
  });
  (allProductSales || []).forEach(p => {
    if (!productsByEntry[p.time_entry_id]) productsByEntry[p.time_entry_id] = [];
    productsByEntry[p.time_entry_id].push(p);
  });

  // Transform entries with O(1) lookups
  const transformedEntries = [];
  for (const entry of (entries || [])) {
    const clients = clientsByEntry[entry.id] || [];
    const productSales = productsByEntry[entry.id] || [];

    transformedEntries.push({
      id: entry.id,
      date: entry.date,
      start_time: entry.start_time,
      end_time: entry.end_time,
      break_minutes: entry.break_minutes,
      staff_treatment_minutes: entry.staff_treatment_minutes,
      hours: entry.hours,
      description: entry.description,
      created_at: entry.created_at,
      employee_id: entry.employee_id,
      employee_name: entry.employees?.name,
      hourly_wage: entry.employees?.hourly_wage,
      commission_rate: entry.employees?.commission_rate,
      pay_type: entry.employees?.pay_type,
      clients: clients,
      productSales: productSales
    });
  }

  res.json(transformedEntries);
});

router.delete('/api/admin/time-entries/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { id } = req.params;

  await supabaseAdmin.from('product_sales').delete().eq('time_entry_id', parseInt(id));
  await supabaseAdmin.from('client_entries').delete().eq('time_entry_id', parseInt(id));
  await supabaseAdmin.from('time_entries').delete().eq('id', parseInt(id));

  res.json({ success: true });
});

module.exports = { router, init };
