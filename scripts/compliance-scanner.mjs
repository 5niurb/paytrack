import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Manual .env parse — dotenv not in dependencies (matches pattern from other paytrack scripts)
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  env.split('\n').forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
} catch {
  // .env not present — rely on environment (Render, launchd EnvironmentVariables)
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);
const BASE_URL = 'https://paytrack.lemedspa.app';
const TOKEN_TTL_DAYS = 7;

function tokenExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + TOKEN_TTL_DAYS);
  return d;
}

async function sendCOIReminders() {
  const thirtyDaysOut = new Date();
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysOutStr = thirtyDaysOut.toISOString().split('T')[0];

  // Employees with COI expiring within 30 days (lower-bounded by today) OR no COI on file
  const { data: employees, error } = await supabase
    .from('employees')
    .select('id, name, email, phone, coi_expiry')
    .or(`and(coi_expiry.gte.${today},coi_expiry.lte.${thirtyDaysOutStr}),coi_expiry.is.null`);

  if (error) throw error;
  if (!employees?.length) {
    console.log('  No employees with expiring/missing COI.');
    return;
  }

  const { sendCOIReminder } = await import('../lib/compliance-notifications.mjs');

  for (const emp of employees) {
    // Skip if a reminder was already sent in the last 24 hours (unused token)
    const { data: existing } = await supabase
      .from('compliance_requests')
      .select('id')
      .eq('employee_id', emp.id)
      .eq('document_type', 'coi')
      .is('used_at', null)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (existing?.length) {
      console.log(`  Skipping ${emp.name} — reminder already sent today`);
      continue;
    }

    const token = randomUUID();
    const expires_at = tokenExpiresAt();

    const { error: insertErr } = await supabase.from('compliance_requests').insert({
      employee_id: emp.id,
      type: 'upload',
      document_type: 'coi',
      token,
      expires_at,
    });

    if (insertErr) {
      console.error(`  Failed to create token for ${emp.name}:`, insertErr.message);
      continue;
    }

    try {
      await sendCOIReminder({
        to_email: emp.email,
        to_phone: emp.phone,
        worker_name: emp.name,
        expiry_date: emp.coi_expiry,
        upload_url: `${BASE_URL}/compliance.html?token=${token}`,
      });
      console.log(`  COI reminder sent → ${emp.name} (${emp.email})`);
    } catch (e) {
      console.error(`  COI reminder FAILED for ${emp.name}:`, e.message);
    }
  }
}

async function run() {
  console.log(`[compliance-scanner] ${new Date().toISOString()}`);
  console.log('Checking COI renewals…');
  await sendCOIReminders();
  console.log('Done.');
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Scanner error:', e);
    process.exit(1);
  });
