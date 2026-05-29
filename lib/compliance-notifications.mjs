import { Resend } from 'resend';
import twilio from 'twilio';

const resend = new Resend(process.env.RESEND_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_PHONE = process.env.TWILIO_PHONE_NUMBER;
const FROM_EMAIL = 'paytrack@lemedspa.com';

// ─────────────────────────────────────────────
// MASTER KILL-SWITCH — contractor contact is OFF until explicit go-live.
// Per Mike (2026-05-29): NO contact to contractors (email OR SMS) until he
// gives the "go live" go-ahead. This gate fails safe — contact only happens
// when COMPLIANCE_CONTACT_ENABLED is explicitly the string "true". Any other
// value (unset, "false", "0", typo) blocks ALL outbound. To go live, set
// COMPLIANCE_CONTACT_ENABLED=true in the paytrack env (Render + launchd).
// ─────────────────────────────────────────────
const CONTACT_ENABLED = process.env.COMPLIANCE_CONTACT_ENABLED === 'true';

/**
 * Returns true if outbound contractor contact is allowed. When disabled,
 * logs the suppressed action and returns false so callers no-op gracefully
 * (no throw — a blocked reminder is not an error condition).
 * @param {string} fn - calling function name (for the suppression log)
 * @param {string} [recipient] - who the message would have gone to
 */
function contactAllowed(fn, recipient) {
  if (CONTACT_ENABLED) return true;
  console.log(
    `[compliance-notifications] SUPPRESSED ${fn} → ${recipient ?? 'unknown'} ` +
      `(COMPLIANCE_CONTACT_ENABLED is not "true" — contractor contact is OFF until go-live)`,
  );
  return false;
}

export async function sendCOIReminder({ to_email, to_phone, worker_name, expiry_date, upload_url }) {
  if (!to_email) throw new Error(`sendCOIReminder: to_email is required (worker: ${worker_name ?? 'unknown'})`);
  if (!contactAllowed('sendCOIReminder', to_email)) return;
  const firstName = (worker_name ?? '').split(' ')[0] || 'there';
  const expiryStr = expiry_date
    ? `expiring ${new Date(expiry_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
    : 'on file';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: `Hi ${firstName} — we still need your updated insurance certificate`,
      html: `
      <p>Hi ${firstName} 👋</p>
      <p>Your certificate of insurance is ${expiryStr}. Once your insurer sends you the updated certificate, just forward it to us and we'll take care of the rest.</p>
      <p><strong>Forward your COI email to:</strong><br>
      <a href="mailto:coi@lemedspa.app" style="font-size:1.1rem;color:#0066cc">coi@lemedspa.app</a></p>
      <p>Or if you have the file handy, upload it here:<br>
      <a href="${upload_url}">${upload_url}</a></p>
      <p>Questions? <a href="mailto:ops@lemedspa.com">ops@lemedspa.com</a></p>
    `,
    });
  } catch (err) {
    throw new Error(`sendCOIReminder: failed to send email to ${to_email} (${worker_name}): ${err.message}`);
  }

  if (to_phone) {
    try {
      await twilioClient.messages.create({
        from: FROM_PHONE,
        to: to_phone,
        body: `Le Med Spa: Hi ${firstName}! We still need your updated insurance cert. Forward your broker email to coi@lemedspa.app or upload here: ${upload_url}`,
      });
    } catch (err) {
      throw new Error(`sendCOIReminder: failed to send SMS to ${to_phone} (${worker_name}): ${err.message}`);
    }
  }
}

export async function sendCOIConfirmRequest({ to_email, to_phone, worker_name, confirm_url }) {
  if (!to_email) throw new Error(`sendCOIConfirmRequest: to_email is required (worker: ${worker_name ?? 'unknown'})`);
  if (!contactAllowed('sendCOIConfirmRequest', to_email)) return;
  const firstName = (worker_name ?? '').split(' ')[0] || 'there';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: `Got your insurance certificate ✓ — takes 30 sec to confirm`,
      html: `
      <p>Hi ${firstName} 👋</p>
      <p>We received your certificate and pulled out the key details. Takes about 30 seconds to confirm everything looks right.</p>
      <p><a href="${confirm_url}" style="display:inline-block;padding:10px 20px;background:#e8c46a;color:#111;font-weight:bold;text-decoration:none;border-radius:6px">Review & Confirm →</a></p>
    `,
    });
  } catch (err) {
    throw new Error(`sendCOIConfirmRequest: failed to send email to ${to_email} (${worker_name}): ${err.message}`);
  }

  if (to_phone) {
    try {
      await twilioClient.messages.create({
        from: FROM_PHONE,
        to: to_phone,
        body: `Le Med Spa: Got your insurance doc! Takes 30 sec to confirm the details — tap here: ${confirm_url}`,
      });
    } catch (err) {
      throw new Error(
        `sendCOIConfirmRequest: failed to send SMS to ${to_phone} (${worker_name}): ${err.message}`,
      );
    }
  }
}

export async function sendCOIApproved({ to_email, worker_name, insurer, expiry_date }) {
  if (!to_email) throw new Error(`sendCOIApproved: to_email is required (worker: ${worker_name ?? 'unknown'})`);
  if (!contactAllowed('sendCOIApproved', to_email)) return;
  const firstName = (worker_name ?? '').split(' ')[0] || 'there';
  const expiryStr = expiry_date
    ? new Date(expiry_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'the date on file';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: `Your insurance certificate is on file ✓`,
      html: `
      <p>Hi ${firstName} 👋</p>
      <p>All set! Your updated certificate from ${insurer} is on file, valid through ${expiryStr}. No further action needed.</p>
      <p>Thanks,<br>Le Med Spa Operations</p>
    `,
    });
  } catch (err) {
    throw new Error(`sendCOIApproved: failed to send email to ${to_email} (${worker_name}): ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// License verification notifications
// ─────────────────────────────────────────────

export async function sendLicenseValid({ to_email, worker_name, profession, expiry_date }) {
  if (!to_email) throw new Error(`sendLicenseValid: to_email is required (worker: ${worker_name ?? 'unknown'})`);
  if (!contactAllowed('sendLicenseValid', to_email)) return;
  const firstName = (worker_name ?? '').split(' ')[0] || 'there';
  const expiryStr = expiry_date
    ? new Date(expiry_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'on file';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: `Your ${profession} license is verified ✓`,
      html: `
      <p>Hi ${firstName} 👋</p>
      <p>Your ${profession} license is verified and active, valid through ${expiryStr}.</p>
      <p>Thanks,<br>Le Med Spa Operations</p>
    `,
    });
  } catch (err) {
    throw new Error(`sendLicenseValid: failed to send email to ${to_email} (${worker_name}): ${err.message}`);
  }
}

export async function sendLicenseRenewalDue({ to_email, to_phone, worker_name, profession, expiry_date, state = 'California' }) {
  if (!to_email) throw new Error(`sendLicenseRenewalDue: to_email is required (worker: ${worker_name ?? 'unknown'})`);
  if (!contactAllowed('sendLicenseRenewalDue', to_email)) return;
  const firstName = (worker_name ?? '').split(' ')[0] || 'there';
  const expiryStr = expiry_date
    ? new Date(expiry_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : 'soon';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: `Time to renew your ${profession} license`,
      html: `
      <p>Hi ${firstName} 👋</p>
      <p>Your ${state} ${profession} license is expiring ${expiryStr}. Please renew it with your state board and let us know once it's updated.</p>
      <p>Reply here or reach out to <a href="mailto:ops@lemedspa.com">ops@lemedspa.com</a> when you've renewed.</p>
      <p>Thanks,<br>Le Med Spa Operations</p>
    `,
    });
  } catch (err) {
    throw new Error(`sendLicenseRenewalDue: failed to send email to ${to_email} (${worker_name}): ${err.message}`);
  }

  if (to_phone) {
    try {
      await twilioClient.messages.create({
        from: FROM_PHONE,
        to: to_phone,
        body: `Le Med Spa: Hi ${firstName}! Your ${profession} license expires ${expiryStr}. Please renew with your state board. Let us know at ops@lemedspa.com when done!`,
      });
    } catch (err) {
      console.error(`sendLicenseRenewalDue: SMS failed to ${to_phone}:`, err.message);
    }
  }
}

export async function sendLicenseInvalid({ to_email, worker_name, profession }) {
  if (!to_email) throw new Error(`sendLicenseInvalid: to_email is required (worker: ${worker_name ?? 'unknown'})`);
  if (!contactAllowed('sendLicenseInvalid', to_email)) return;
  const firstName = (worker_name ?? '').split(' ')[0] || 'there';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: `Question about your ${profession} license`,
      html: `
      <p>Hi ${firstName} 👋</p>
      <p>We're having trouble verifying your ${profession} license in the state database. This may be a lag in state records, or your license may need renewal.</p>
      <p>Please reach out to <a href="mailto:ops@lemedspa.com">ops@lemedspa.com</a> and we'll get it sorted out.</p>
      <p>Thanks,<br>Le Med Spa Operations</p>
    `,
    });
  } catch (err) {
    throw new Error(`sendLicenseInvalid: failed to send email to ${to_email} (${worker_name}): ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// E-signature notifications
// ─────────────────────────────────────────────

export async function sendESignRequest({ to_email, to_phone, worker_name, document_type, esign_url }) {
  if (!to_email) throw new Error(`sendESignRequest: to_email is required (worker: ${worker_name ?? 'unknown'})`);
  if (!contactAllowed('sendESignRequest', to_email)) return;
  const firstName = (worker_name ?? '').split(' ')[0] || 'there';
  const docLabel = document_type === 'w9' ? 'W9' : 'Service Contract';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: `Sign your ${docLabel} — takes 2 minutes`,
      html: `
      <p>Hi ${firstName} 👋</p>
      <p>We need your signature on our ${docLabel}. It's quick — just review and sign below.</p>
      <p><a href="${esign_url}" style="display:inline-block;padding:10px 20px;background:#e8c46a;color:#111;font-weight:bold;text-decoration:none;border-radius:6px">Sign Now →</a></p>
    `,
    });
  } catch (err) {
    throw new Error(`sendESignRequest: failed to send email to ${to_email} (${worker_name}): ${err.message}`);
  }

  if (to_phone) {
    try {
      await twilioClient.messages.create({
        from: FROM_PHONE,
        to: to_phone,
        body: `Le Med Spa: Hi ${firstName}! Quick task: sign your ${docLabel} (2 min). Tap here: ${esign_url}`,
      });
    } catch (err) {
      console.error(`sendESignRequest: SMS failed to ${to_phone}:`, err.message);
    }
  }
}

export async function sendESignComplete({ to_email, worker_name, document_type }) {
  if (!to_email) throw new Error(`sendESignComplete: to_email is required (worker: ${worker_name ?? 'unknown'})`);
  if (!contactAllowed('sendESignComplete', to_email)) return;
  const firstName = (worker_name ?? '').split(' ')[0] || 'there';
  const docLabel = document_type === 'w9' ? 'W9' : 'Service Contract';

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: `${docLabel} signed ✓`,
      html: `
      <p>Hi ${firstName} 👋</p>
      <p>Thanks for signing! Your ${docLabel} is on file and we're all set.</p>
      <p>Thanks,<br>Le Med Spa Operations</p>
    `,
    });
  } catch (err) {
    throw new Error(`sendESignComplete: failed to send email to ${to_email} (${worker_name}): ${err.message}`);
  }
}
