'use strict';

// Route module: employees. Extracted verbatim from server.js (Wave 2.B split).
// Shared clients/helpers are injected via init(deps) and destructured into
// module-scoped vars with the same names the handlers use, so the route bodies
// are byte-identical to the original server.js implementation.

const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { encryptValue } = require('../lib/crypto');

let supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD;

function init(deps) {
  ({ supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD } = deps);
}

router.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  res.json({ success: verifyAdminPassword(password, ADMIN_PASSWORD) });
});

router.get('/api/admin/employees', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const employeeFields = [
    'id', 'name', 'pin', 'email', 'phone', 'hourly_wage', 'additional_pay_rate',
    'rate_notes', 'commission_rate', 'pay_type', 'designation', 'contractor_type',
    'status', 'created_at', 'review_token', 'review_completed_at', 'zelle_name'
  ].join(', ');
  const { data: employees, error } = await supabaseAdmin
    .from('employees')
    .select(employeeFields);

  res.json(employees || []);
});

router.post('/api/admin/employees', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const {
    name,
    pin,
    email,
    phone,
    hourlyWage,
    additionalPayRate,
    rateNotes,
    commissionRate,
    payType,
    designation,
    contractorType,
    startDate,
  } = req.body;

  // Check if PIN already exists
  const { data: existing } = await supabaseAdmin.from('employees').select('id').eq('pin', pin).single();

  if (existing) {
    return res.status(400).json({ success: false, message: 'PIN already exists' });
  }

  const onboardingToken = randomUUID();

  const { data: employee, error } = await supabaseAdmin
    .from('employees')
    .insert({
      name: name,
      pin: pin,
      email: email || null,
      phone: phone?.trim() || null,
      hourly_wage: hourlyWage || 0,
      additional_pay_rate: additionalPayRate ? parseFloat(additionalPayRate) : null,
      rate_notes: rateNotes?.trim() || null,
      commission_rate: commissionRate || 0,
      pay_type: payType || 'hourly',
      designation: designation?.trim() || null,
      contractor_type: contractorType || null,
      start_date: startDate || null,
      review_token: onboardingToken,
    })
    .select()
    .single();

  if (error) {
    res.status(400).json({ success: false, message: error.message });
  } else {
    res.json({ success: true, id: employee.id, onboardingToken });
  }
});

router.put('/api/admin/employees/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const { id } = req.params;
  const {
    name,
    pin,
    email,
    phone,
    hourlyWage,
    additionalPayRate,
    rateNotes,
    commissionRate,
    payType,
    designation,
    contractorType,
    status,
    zelleName,
  } = req.body;

  // Check if PIN already exists for another employee
  const { data: existing } = await supabaseAdmin
    .from('employees')
    .select('id')
    .eq('pin', pin)
    .neq('id', parseInt(id))
    .single();

  if (existing) {
    return res.status(400).json({ success: false, message: 'PIN already exists' });
  }

  const { error } = await supabaseAdmin
    .from('employees')
    .update({
      name: name,
      pin: pin,
      email: email || null,
      phone: phone?.trim() || null,
      hourly_wage: hourlyWage || 0,
      additional_pay_rate: additionalPayRate ? parseFloat(additionalPayRate) : null,
      rate_notes: rateNotes?.trim() || null,
      commission_rate: commissionRate || 0,
      pay_type: payType || 'hourly',
      designation: designation?.trim() || null,
      contractor_type: contractorType || null,
      status: status || 'active',
      zelle_name: zelleName?.trim() || null,
    })
    .eq('id', parseInt(id));

  if (error) {
    res.status(400).json({ success: false, message: error.message });
  } else {
    res.json({ success: true });
  }
});

router.put('/api/admin/employees/:id/pii', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const { id } = req.params;
  const allowed = [
    'first_name', 'last_name', 'middle_name', 'preferred_name', 'mobile_phone',
    'date_of_birth', 'address_street', 'address_city', 'address_state', 'address_zip',
    'tin_type', 'tin_last4', 'w9_entity_name', 'w9_tax_classification', 'w9_collected_at',
    'driver_license_number', 'driver_license_state', 'professional_licenses',
    'insurer_name', 'insurance_policy_number', 'insurance_expiration',
    'prof_liability_per_occurrence', 'prof_liability_aggregate',
    'bank_name', 'bank_account_owner_name', 'bank_account_type',
    'bank_routing_last4', 'bank_account_last4', 'payment_method', 'zelle_contact',
    'time_commitment_bucket', 'other_commitments',
    'attestation_checked', 'attestation_signature', 'attestation_date',
  ];
  const payload = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) payload[key] = req.body[key];
  }
  if (req.body.tin_raw) {
    payload.tin_encrypted = await encryptValue(req.body.tin_raw);
    payload.tin_last4 = req.body.tin_raw.replace(/\D/g, '').slice(-4);
  }
  if (req.body.bank_routing_raw) {
    payload.bank_routing_encrypted = await encryptValue(req.body.bank_routing_raw);
    payload.bank_routing_last4 = req.body.bank_routing_raw.replace(/\D/g, '').slice(-4);
  }
  if (req.body.bank_account_raw) {
    payload.bank_account_encrypted = await encryptValue(req.body.bank_account_raw);
    payload.bank_account_last4 = req.body.bank_account_raw.replace(/\D/g, '').slice(-4);
  }
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ success: false, message: 'No valid fields provided' });
  }
  payload.data_updated_at = new Date().toISOString();
  const { error } = await supabaseAdmin.from('employees').update(payload).eq('id', parseInt(id));
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
});

router.delete('/api/admin/employees/:id', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const { id } = req.params;

  // Get time entries for this employee
  const { data: timeEntries } = await supabaseAdmin
    .from('time_entries')
    .select('id')
    .eq('employee_id', parseInt(id));

  // Delete related records in batch (O(1) instead of O(n))
  const entryIds = (timeEntries || []).map(e => e.id);
  if (entryIds.length > 0) {
    await supabaseAdmin.from('product_sales').delete().in('time_entry_id', entryIds);
    await supabaseAdmin.from('client_entries').delete().in('time_entry_id', entryIds);
  }

  await supabaseAdmin.from('invoices').delete().eq('employee_id', parseInt(id));
  await supabaseAdmin.from('time_entries').delete().eq('employee_id', parseInt(id));
  await supabaseAdmin.from('employees').delete().eq('id', parseInt(id));

  res.json({ success: true });
});

module.exports = { router, init };
