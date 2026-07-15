'use strict';

// Route module: onboarding. Extracted verbatim from server.js (Wave 2.B split).
// Shared clients/helpers are injected via init(deps) and destructured into
// module-scoped vars with the same names the handlers use, so the route bodies
// are byte-identical to the original server.js implementation.

const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const path = require('path');
const debug = require('../lib/debug');
const { encryptValue } = require('../lib/crypto');
const { validateOnboarding, extractLast4SSN, extractLast4Routing, extractLast4Account, CLINICAL_TITLES } = require('../lib/onboarding-validation');

let supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD, upload;

function init(deps) {
  ({ supabaseAdmin, verifyAdminPassword, ADMIN_PASSWORD, upload } = deps);
}

// Deferred multer middleware: `upload` is injected via init() after these routes
// are registered, so we build the .single('file') handler per-request instead of
// passing it positionally (which would capture an undefined `upload`).
function uploadSingle(field) {
  return (req, res, next) => upload.single(field)(req, res, next);
}

router.get('/api/admin/employees/:id/onboarding', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { id } = req.params;

  const { data, error } = await supabaseAdmin
    .from('employees')
    .select(
      `first_name, last_name, middle_name, preferred_name, mobile_phone,
       date_of_birth, address_street, address_city, address_state, address_zip,
       tin_type, tin_last4, tin_encrypted,
       w9_entity_name, w9_tax_classification, w9_collected_at,
       driver_license_number, driver_license_state, driver_license_upload_path,
       professional_licenses,
       insurer_name, insurance_policy_number, insurance_expiration, insurance_upload_path,
       prof_liability_per_occurrence, prof_liability_aggregate,
       bank_name, bank_account_owner_name, bank_account_type,
       bank_routing_last4, bank_account_last4, bank_routing_encrypted, bank_account_encrypted,
       payment_method, zelle_contact,
       time_commitment_bucket, other_commitments,
       attestation_checked, attestation_signature, attestation_date,
       ic_agreement_signed, ic_agreement_signed_at,
       review_submitted_at, review_completed_at`,
    )
    .eq('id', parseInt(id))
    .single();

  if (error) {
    return res.status(404).json({ success: false, message: 'Employee not found' });
  }

  // Mask encrypted values — return hint strings, not ciphertext
  const masked = { ...data };
  if (masked.tin_encrypted) {
    masked.tin_masked = masked.tin_last4 ? `***-**-${masked.tin_last4}` : 'on file';
  }
  delete masked.tin_encrypted;
  if (masked.bank_routing_encrypted) {
    masked.bank_routing_masked = masked.bank_routing_last4 ? `*****${masked.bank_routing_last4}` : 'on file';
  }
  delete masked.bank_routing_encrypted;
  if (masked.bank_account_encrypted) {
    masked.bank_account_masked = masked.bank_account_last4 ? `****${masked.bank_account_last4}` : 'on file';
  }
  delete masked.bank_account_encrypted;

  res.json({ success: true, data: masked });
});

router.post('/api/admin/employees/:id/onboarding-token', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { id } = req.params;
  const newToken = randomUUID();

  const { error } = await supabaseAdmin
    .from('employees')
    .update({ review_token: newToken })
    .eq('id', parseInt(id));

  if (error) {
    return res.status(500).json({ success: false, message: error.message });
  }

  res.json({ success: true, onboardingToken: newToken });
});

router.post('/api/admin/employees/:id/send-link', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { id } = req.params;
  const { type } = req.body; // 'sms' or 'email'

  if (!['sms', 'email'].includes(type)) {
    return res.status(400).json({ success: false, message: 'type must be sms or email' });
  }

  const { data: employee, error } = await supabaseAdmin
    .from('employees')
    .select('id, name, email, phone, review_token')
    .eq('id', parseInt(id))
    .single();

  if (error || !employee) {
    return res.status(404).json({ success: false, message: 'Employee not found' });
  }

  if (!employee.review_token) {
    return res.status(400).json({ success: false, message: 'No review token — generate one first' });
  }

  const firstName = (employee.name || '').split(' ')[0];
  const onboardingUrl = `${req.protocol}://${req.get('host')}/onboarding/${employee.review_token}`;

  if (type === 'sms') {
    if (!employee.phone) {
      return res.status(400).json({ success: false, message: 'No phone number on file' });
    }

    const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    if (!TWILIO_SID || !TWILIO_TOKEN) {
      return res.status(500).json({ success: false, message: 'Twilio not configured' });
    }

    const smsBody = [
      `Hi ${firstName}, this is LeMed Spa. At initial onboarding and periodically,`,
      `we may need you to provide or confirm tax, license, insurance, and payment info.`,
      `Complete the form here: ${onboardingUrl}`,
      `Questions? Text Mike at 310.621.8356 - Thanks!`
    ].join(' ');

    // Normalize phone to E.164
    let toPhone = employee.phone.replace(/\D/g, '');
    if (toPhone.length === 10) toPhone = '1' + toPhone;
    if (!toPhone.startsWith('+')) toPhone = '+' + toPhone;

    try {
      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
          },
          body: new URLSearchParams({
            From: '+12134442242',
            To: toPhone,
            Body: smsBody,
          }),
        },
      );

      const result = await twilioRes.json();

      if (twilioRes.ok) {
        debug.log(`[SendLink] SMS sent to ${toPhone} for employee ${id}, SID: ${result.sid}`);
        return res.json({ success: true, message: `Text sent to ${employee.phone}` });
      } else {
        console.error('[SendLink] Twilio error:', result);
        return res.status(500).json({ success: false, message: result.message || 'SMS failed' });
      }
    } catch (err) {
      console.error('[SendLink] SMS error:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to send SMS' });
    }
  }

  if (type === 'email') {
    if (!employee.email) {
      return res.status(400).json({ success: false, message: 'No email on file' });
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
      return res.status(500).json({ success: false, message: 'Resend not configured' });
    }

    const containerStyle = "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #333; line-height: 1.7;";
    const emailHtml = `
      <div style="${containerStyle}">
        <div style="border-bottom: 2px solid #c9a84c; padding-bottom: 16px; margin-bottom: 24px;">
          <h1 style="font-size: 20px; color: #222; margin: 0;">LeMed Spa</h1>
        </div>
        <p>Hi ${firstName},</p>
        <p>Please take a moment to review and confirm your information on file with LeMed Spa — contact info, tax details, insurance, and payment preferences. The link below is reusable and can be used anytime to make updates.</p>
        <p style="margin: 20px 0;">
          <a href="${onboardingUrl}" style="color: #c9a84c; font-weight: 600;">Review My Team Member Info</a>
        </p>
        <p>If you have any questions, please let Lea know or just reply here.</p>
        <p style="margin-top: 28px; margin-bottom: 4px;"><em>Regards,</em></p>
        <p style="margin: 0;">
          <strong>Accounts</strong> | <strong>Operations</strong><br>
          <a href="mailto:accounts@lemedspa.com" style="color: #c9a84c;">accounts@lemedspa.com</a> | <a href="mailto:ops@lemedspa.com" style="color: #c9a84c;">ops@lemedspa.com</a>
        </p>
      </div>
    `;

    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'LeMed Spa <ops@lemedspa.com>',
          to: [employee.email],
          cc: ['lea@lemedspa.com'],
          subject: `LeMed Spa — Please Review Your Team Info`,
          html: emailHtml,
        }),
      });

      const result = await emailRes.json();

      if (emailRes.ok) {
        debug.log(`[SendLink] Email sent to ${employee.email} for employee ${id}, ID: ${result.id}`);
        return res.json({ success: true, message: `Email sent to ${employee.email}` });
      } else {
        console.error('[SendLink] Resend error:', result);
        return res.status(500).json({ success: false, message: result.message || 'Email failed' });
      }
    } catch (err) {
      console.error('[SendLink] Email error:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to send email' });
    }
  }
});

router.get('/api/onboarding/:token/prefill', async (req, res) => {
  const { token } = req.params;

  const { data: employee, error } = await supabaseAdmin
    .from('employees')
    .select(
      `id, name, email, phone, designation, contractor_type, pay_type,
       hourly_wage, additional_pay_rate, rate_notes, start_date,
       first_name, last_name, middle_name, preferred_name, mobile_phone,
       date_of_birth, address_street, address_city, address_state, address_zip,
       tin_type, tin_last4,
       w9_entity_name, w9_tax_classification,
       driver_license_number, driver_license_state, driver_license_upload_path,
       professional_licenses,
       insurer_name, insurance_policy_number, insurance_expiration, insurance_upload_path,
       prof_liability_per_occurrence, prof_liability_aggregate,
       bank_name, bank_account_owner_name, bank_account_type,
       bank_routing_last4, bank_account_last4,
       payment_method, zelle_contact,
       time_commitment_bucket, other_commitments,
       attestation_checked, attestation_signature, attestation_date,
       review_completed_at`,
    )
    .eq('review_token', token)
    .single();

  if (error || !employee) {
    return res.status(404).json({ success: false, message: 'Invalid link' });
  }

  // Split name into first/last for pre-fill if not already stored
  const nameParts = (employee.name || '').trim().split(/\s+/);
  const prefill = {
    ...employee,
    first_name: employee.first_name || nameParts[0] || '',
    last_name: employee.last_name || nameParts.slice(1).join(' ') || '',
  };

  res.json({ success: true, prefill });
});

router.post(
  '/api/onboarding/:token/upload',
  uploadSingle('file'),
  async (req, res) => {
    const { token } = req.params;
    const { fileType } = req.body; // 'driver_license' or 'insurance'

    // Validate token
    const { data: employee, error: empError } = await supabaseAdmin
      .from('employees')
      .select('id')
      .eq('review_token', token)
      .single();

    if (empError || !employee) {
      return res.status(404).json({ success: false, message: 'Invalid link' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    if (!fileType || (!['driver_license', 'insurance'].includes(fileType) && !fileType.startsWith('license_'))) {
      return res.status(400).json({ success: false, message: 'Invalid fileType' });
    }

    const ext = req.file.mimetype === 'application/pdf' ? 'pdf' : req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const storagePath = `employee-${employee.id}/${fileType}-${Date.now()}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('onboarding-documents')
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error('[Upload] Storage error:', uploadError);
      return res.status(500).json({ success: false, message: 'File upload failed. Please try again.' });
    }

    res.json({ success: true, path: storagePath });
  },
);

router.get('/onboarding/:token', async (req, res) => {
  const { token } = req.params;

  const { data: employee, error } = await supabaseAdmin
    .from('employees')
    .select('id')
    .eq('review_token', token)
    .single();

  if (error || !employee) {
    return res.status(404).send(`
      <!DOCTYPE html><html><head><title>Invalid Link</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:sans-serif;text-align:center;padding:60px 20px;background:#0a0a0a;color:#ccc;}
      h2{color:#c9a84c;}</style></head>
      <body><h2>Invalid Link</h2>
      <p>This link is invalid. Please contact your administrator.</p></body></html>
    `);
  }

  res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

router.post('/api/onboarding/:token', async (req, res) => {
  const { token } = req.params;

  // Verify token and get designation for validation
  const { data: employee, error: empError } = await supabaseAdmin
    .from('employees')
    .select('id, name, designation')
    .eq('review_token', token)
    .single();

  if (empError || !employee) {
    return res.status(404).json({ success: false, message: 'Invalid or expired link' });
  }

  const requireLicenseInsurance = CLINICAL_TITLES.has(employee.designation || '');

  // Validate all fields
  const form = req.body;
  const errors = validateOnboarding(form, { requireLicenseInsurance });

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  // Extract masked values
  const tin_last4 = form.tin_raw ? extractLast4SSN(form.tin_raw) : null;
  const bank_routing_last4 = form.bank_routing_raw ? extractLast4Routing(form.bank_routing_raw) : null;
  const bank_account_last4 = form.bank_account_raw ? extractLast4Account(form.bank_account_raw) : null;

  // Encrypt sensitive fields
  const [tin_encrypted, bank_routing_encrypted, bank_account_encrypted] = await Promise.all([
    encryptValue(form.tin_raw || null),
    form.payment_method === 'ach' ? encryptValue(form.bank_routing_raw || null) : Promise.resolve(null),
    form.payment_method === 'ach' ? encryptValue(form.bank_account_raw || null) : Promise.resolve(null),
  ]);

  // Parse professional_licenses — may arrive as JSON string from FormData
  let professionalLicenses = form.professional_licenses;
  if (typeof professionalLicenses === 'string') {
    try {
      professionalLicenses = JSON.parse(professionalLicenses);
    } catch {
      professionalLicenses = [];
    }
  }

  const now = new Date().toISOString();

  const updatePayload = {
    first_name: form.first_name.trim(),
    last_name: form.last_name.trim(),
    middle_name: form.middle_name?.trim() || null,
    preferred_name: form.preferred_name?.trim() || null,
    mobile_phone: form.mobile_phone?.trim() || null,
    date_of_birth: form.date_of_birth || null,
    address_street: form.address_street?.trim() || null,
    address_city: form.address_city?.trim() || null,
    address_state: form.address_state || null,
    address_zip: form.address_zip?.trim() || null,
    tin_last4,
    tin_type: form.tin_type || null,
    tin_encrypted,
    w9_entity_name: form.w9_entity_name?.trim() || null,
    w9_tax_classification: form.w9_tax_classification || null,
    w9_collected_at: now,
    driver_license_number: form.driver_license_number?.trim() || null,
    driver_license_state: form.driver_license_state || null,
    driver_license_upload_path: form.driver_license_upload_path || null,
    professional_licenses: Array.isArray(professionalLicenses) ? professionalLicenses : [],
    insurer_name: form.insurer_name?.trim() || null,
    insurance_policy_number: form.insurance_policy_number?.trim() || null,
    insurance_expiration: form.insurance_expiration || null,
    insurance_upload_path: form.insurance_upload_path || null,
    prof_liability_per_occurrence: form.prof_liability_per_occurrence
      ? parseFloat(form.prof_liability_per_occurrence)
      : null,
    prof_liability_aggregate: form.prof_liability_aggregate
      ? parseFloat(form.prof_liability_aggregate)
      : null,
    bank_name: form.bank_name?.trim() || null,
    bank_account_owner_name: form.bank_account_owner_name?.trim() || null,
    bank_account_type: form.payment_method === 'ach' ? (form.bank_account_type || null) : null,
    bank_routing_last4: form.payment_method === 'ach' ? bank_routing_last4 : null,
    bank_account_last4: form.payment_method === 'ach' ? bank_account_last4 : null,
    bank_routing_encrypted,
    bank_account_encrypted,
    payment_method: form.payment_method || null,
    zelle_contact: form.zelle_contact?.trim() || null,
    time_commitment_bucket: form.time_commitment_bucket || null,
    other_commitments: form.other_commitments?.trim() || null,
    attestation_checked: true,
    attestation_signature: form.attestation_signature.trim(),
    attestation_date: form.attestation_date,
    ic_agreement_signed: true,
    ic_agreement_signed_at: now,
    review_completed_at: now,
    review_submitted_at: now,
    data_updated_at: now,
  };

  const { error: updateError } = await supabaseAdmin
    .from('employees')
    .update(updatePayload)
    .eq('id', employee.id);

  if (updateError) {
    console.error('[Review] Update error:', updateError);
    return res.status(500).json({ success: false, message: 'Failed to save. Please try again.' });
  }

  // Mirror uploaded files into employee_documents so the admin Documents tab can find them
  const docRecords = [];
  if (form.driver_license_upload_path) {
    docRecords.push({
      employee_id: employee.id,
      document_type: 'driver_license',
      file_path: form.driver_license_upload_path,
      file_name: form.driver_license_upload_path.split('/').pop(),
      uploaded_at: now,
    });
  }
  if (form.insurance_upload_path) {
    docRecords.push({
      employee_id: employee.id,
      document_type: 'insurance',
      file_path: form.insurance_upload_path,
      file_name: form.insurance_upload_path.split('/').pop(),
      uploaded_at: now,
      expiration_date: form.insurance_expiration || null,
    });
  }
  if (docRecords.length) {
    // Check which paths already exist to avoid duplicates on resubmit
    const paths = docRecords.map((d) => d.file_path);
    const { data: existing } = await supabaseAdmin
      .from('employee_documents')
      .select('file_path')
      .eq('employee_id', employee.id)
      .in('file_path', paths);
    const existingPaths = new Set((existing || []).map((r) => r.file_path));
    const toInsert = docRecords.filter((d) => !existingPaths.has(d.file_path));
    if (toInsert.length) {
      const { error: docError } = await supabaseAdmin.from('employee_documents').insert(toInsert);
      if (docError) console.error('[Review] employee_documents insert error:', docError);
    }
  }

  debug.log(`[Review] Submitted for employee ${employee.id} (${employee.name})`);

  res.json({ success: true, message: 'Info confirmed. Thank you!' });
});

router.get('/api/admin/employee-documents/all', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { data, error } = await supabaseAdmin
    .from('employee_documents')
    .select('employee_id, document_type, expiration_date');

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

router.get('/api/admin/employees/:id/documents', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { data, error } = await supabaseAdmin
    .from('employee_documents')
    .select('id, document_type, file_path, file_name, notes, uploaded_at, expiration_date, license_number')
    .eq('employee_id', parseInt(req.params.id))
    .order('uploaded_at', { ascending: false });

  if (error) return res.status(500).json({ success: false, message: error.message });

  // Generate signed URLs (1 hour)
  const docs = await Promise.all(
    (data || []).map(async (doc) => {
      const { data: signed } = await supabaseAdmin.storage
        .from('onboarding-documents')
        .createSignedUrl(doc.file_path, 3600);
      return { ...doc, url: signed?.signedUrl || null };
    }),
  );

  res.json(docs);
});

router.post(
  '/api/admin/employees/:id/documents',
  uploadSingle('file'),
  async (req, res) => {
    const password = req.headers['x-admin-password'];
    if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const employeeId = parseInt(req.params.id);
    const { document_type, notes, expiration_date, license_number } = req.body;

    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    if (!document_type) return res.status(400).json({ success: false, message: 'document_type required' });

    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const storagePath = `employee-${employeeId}/${document_type}-${Date.now()}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('onboarding-documents')
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (uploadError) return res.status(500).json({ success: false, message: 'File upload failed' });

    const { data, error } = await supabaseAdmin
      .from('employee_documents')
      .insert({
        employee_id: employeeId,
        document_type,
        file_path: storagePath,
        file_name: req.file.originalname,
        notes: notes || null,
        expiration_date: expiration_date || null,
        license_number: license_number || null,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, doc: data });
  },
);

router.patch('/api/admin/employee-documents/:docId', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { expiration_date, license_number, notes } = req.body;
  const updates = {};
  if (expiration_date !== undefined) updates.expiration_date = expiration_date || null;
  if (license_number !== undefined) updates.license_number = license_number || null;
  if (notes !== undefined) updates.notes = notes || null;

  if (!Object.keys(updates).length)
    return res.status(400).json({ success: false, message: 'Nothing to update' });

  const { data, error } = await supabaseAdmin
    .from('employee_documents')
    .update(updates)
    .eq('id', parseInt(req.params.docId))
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, doc: data });
});

router.delete('/api/admin/employee-documents/:docId', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  // Fetch path before deleting
  const { data: doc } = await supabaseAdmin
    .from('employee_documents')
    .select('file_path')
    .eq('id', parseInt(req.params.docId))
    .single();

  if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

  // Remove from storage
  await supabaseAdmin.storage.from('onboarding-documents').remove([doc.file_path]);

  // Remove DB row
  const { error } = await supabaseAdmin
    .from('employee_documents')
    .delete()
    .eq('id', parseInt(req.params.docId));

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
});

router.get('/api/admin/employees/:id/compliance-items', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const { data, error } = await supabaseAdmin
    .from('employee_compliance_items')
    .select('*')
    .eq('employee_id', parseInt(req.params.id));
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

router.put('/api/admin/employees/:id/compliance-items/:key', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const { comment, is_cleared } = req.body;
  const employeeId = parseInt(req.params.id);
  const itemKey = req.params.key;
  const record = {
    employee_id: employeeId,
    item_key: itemKey,
    comment: comment || null,
    is_cleared: !!is_cleared,
    cleared_at: is_cleared ? new Date().toISOString() : null,
  };
  const { error } = await supabaseAdmin
    .from('employee_compliance_items')
    .upsert(record, { onConflict: 'employee_id,item_key' });
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
});

module.exports = { router, init };
