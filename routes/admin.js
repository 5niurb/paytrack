'use strict';

// Route module: admin. Extracted verbatim from server.js (Wave 2.B split).
// Shared clients/helpers are injected via init(deps) and destructured into
// module-scoped vars with the same names the handlers use, so the route bodies
// are byte-identical to the original server.js implementation.

const express = require('express');
const router = express.Router();
const path = require('path');

let supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD;

function init(deps) {
  ({ supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD } = deps);
}

router.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

router.get('/api/admin/storage/signed-url', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ success: false, message: 'path is required' });

  const { data, error } = await supabaseAdmin.storage
    .from('onboarding-documents')
    .createSignedUrl(filePath, 3600);

  if (error || !data?.signedUrl) {
    console.error('[Storage] signed URL error:', error);
    return res.status(500).json({ success: false, message: 'Could not generate link' });
  }

  res.json({ success: true, url: data.signedUrl });
});

module.exports = { router, init };
