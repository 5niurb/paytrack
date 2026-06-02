'use strict';

const express = require('express');
const router = express.Router();

let supabase;
let adminPassword;
let verifyAdminPassword;

function init(supabaseClient, adminPwd, verifyFn) {
  supabase = supabaseClient;
  adminPassword = adminPwd;
  verifyAdminPassword = verifyFn;
}

function authCheck(req, res) {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword || !verifyAdminPassword(password, adminPassword)) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  return true;
}

// POST /api/admin/plaid/link-token
router.post('/link-token', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const { createLinkToken, isConfigured } = require('../server/plaid-client');
    if (!isConfigured()) {
      return res.status(400).json({ success: false, message: 'Plaid credentials not configured' });
    }
    // Production OAuth (Chase etc.) requires a redirect_uri whitelisted in Plaid dashboard
    const env = process.env.PLAID_ENV || 'sandbox';
    const redirectUri = env === 'production' ? 'https://paytrack.lemedspa.app/admin' : null;
    const linkToken = await createLinkToken('paytrack-admin', redirectUri);
    res.json({ success: true, linkToken });
  } catch (e) {
    console.error('[plaid] link-token error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/admin/plaid/exchange-token
router.post('/exchange-token', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { publicToken } = req.body;
  if (!publicToken) {
    return res.status(400).json({ success: false, message: 'publicToken is required' });
  }
  try {
    const { exchangePublicToken } = require('../server/plaid-client');
    const { updateRenderEnvVar } = require('../server/render-api');
    const { saveSetting } = require('../server/plaid-sync');
    const { accessToken } = await exchangePublicToken(publicToken);
    // Persist to DB (durable across deploys) and env
    await saveSetting(supabase, 'plaid_access_token', accessToken, 'PLAID_ACCESS_TOKEN');
    await saveSetting(supabase, 'plaid_cursor', '', 'PLAID_CURSOR');
    // Also push to Render env (best-effort)
    await updateRenderEnvVar('PLAID_ACCESS_TOKEN', accessToken).catch(() => {});
    await updateRenderEnvVar('PLAID_CURSOR', '').catch(() => {});
    res.json({ success: true });
  } catch (e) {
    console.error('[plaid] exchange-token error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/admin/plaid/sync
router.post('/sync', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const { runSync } = require('../server/plaid-sync');
    const result = await runSync(supabase);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[plaid] sync error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/admin/plaid/pending
router.get('/pending', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { data, error } = await supabase
    .from('plaid_pending')
    .select('*')
    .order('transaction_date', { ascending: false });

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, data });
});

// POST /api/admin/plaid/pending/:id/assign
router.post('/pending/:id/assign', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.params;
  const { employeeId } = req.body;
  if (!employeeId) {
    return res.status(400).json({ success: false, message: 'employeeId is required' });
  }

  const { data: pending, error: fetchErr } = await supabase
    .from('plaid_pending')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !pending) {
    return res.status(404).json({ success: false, message: 'Pending transaction not found' });
  }

  const { comments } = req.body;

  const { data: employee } = await supabase
    .from('employees')
    .select('name')
    .eq('id', parseInt(employeeId))
    .single();

  const { error: insertErr } = await supabase.from('payments').insert({
    employee_id: parseInt(employeeId),
    teammate_name: employee ? employee.name : null,
    payment_date: pending.transaction_date,
    amount: pending.amount,
    notes: pending.description,
    payment_method: pending.payment_method || 'ach',
    comments: comments || null,
    source: 'plaid',
    auto_imported: false,
    plaid_transaction_id: pending.plaid_transaction_id,
  });

  if (insertErr) {
    return res.status(400).json({ success: false, message: insertErr.message });
  }

  await supabase.from('plaid_pending').delete().eq('id', id);
  res.json({ success: true });
});

// POST /api/admin/plaid/payments/:id/verify
router.post('/payments/:id/verify', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.params;
  const { error } = await supabase
    .from('payments')
    .update({ auto_imported: false })
    .eq('id', id)
    .eq('auto_imported', true);

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
});

// DELETE /api/admin/plaid/payments/:id/reverse
router.delete('/payments/:id/reverse', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.params;

  const { data: payment, error: fetchErr } = await supabase
    .from('payments')
    .select('*')
    .eq('id', id)
    .eq('auto_imported', true)
    .single();

  if (fetchErr || !payment) {
    return res.status(404).json({ success: false, message: 'Auto-imported payment not found' });
  }

  const { error: pendingErr } = await supabase.from('plaid_pending').upsert(
    {
      plaid_transaction_id: payment.plaid_transaction_id,
      transaction_date: payment.payment_date,
      amount: payment.amount,
      description: payment.notes,
    },
    { onConflict: 'plaid_transaction_id' },
  );

  if (pendingErr) {
    return res.status(500).json({ success: false, message: pendingErr.message });
  }

  await supabase.from('payments').delete().eq('id', id);
  res.json({ success: true });
});

// DELETE /api/admin/plaid/pending/:id
router.delete('/pending/:id', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.params;
  const { error } = await supabase.from('plaid_pending').delete().eq('id', id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
});

// DELETE /api/admin/plaid/payments/:id
// Deletes a manually-assigned (non-auto-imported) payment record.
router.delete('/payments/:id', async (req, res) => {
  if (!authCheck(req, res)) return;
  const { id } = req.params;

  const { data: payment, error: fetchErr } = await supabase
    .from('payments')
    .select('id, auto_imported')
    .eq('id', id)
    .single();

  if (fetchErr || !payment) {
    return res.status(404).json({ success: false, message: 'Payment not found' });
  }

  const { error } = await supabase.from('payments').delete().eq('id', id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
});

// DELETE /api/admin/plaid/reset
// Wipes all Plaid-imported payments and pending transactions, resets cursor.
router.delete('/reset', async (req, res) => {
  if (!authCheck(req, res)) return;
  try {
    const { saveSetting } = require('../server/plaid-sync');
    await supabase.from('payments').delete().not('plaid_transaction_id', 'is', null);
    await supabase.from('plaid_pending').delete().not('plaid_transaction_id', 'is', null);
    await saveSetting(supabase, 'plaid_cursor', '', 'PLAID_CURSOR');
    const { updateRenderEnvVar } = require('../server/render-api');
    await updateRenderEnvVar('PLAID_CURSOR', '').catch(() => {});
    res.json({ success: true });
  } catch (e) {
    console.error('[plaid] reset error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = { router, init };
