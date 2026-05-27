/**
 * Nightly compliance scanner
 * Runs daily 11:30 PM PT via launchd
 * Orchestrates all three compliance workflows:
 * 1. COI expiry reminders
 * 2. Professional license verification (BreEZe)
 * 3. W9/Contract e-signature requests
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

/**
 * Run full compliance scan for all active employees
 * @param {SupabaseClient} supabase - Supabase client (server-side)
 * @returns {Promise<{checked: number, reminders_triggered: number, errors: string[]}>}
 */
export async function runComplianceScan(supabase) {
  const errors = [];
  let checked = 0;
  let reminders_triggered = 0;

  try {
    // Fetch all active employees
    const { data: employees, error: empErr } = await supabase
      .from('employees')
      .select('id, name, email, phone, coi_expiry, professional_license, professional_title, license_number, w9_signed, contract_signed')
      .not('created_at', 'is', null); // only onboarded employees

    if (empErr) {
      errors.push(`Failed to fetch employees: ${empErr.message}`);
      return { checked, reminders_triggered, errors };
    }

    const notifier = await import('./compliance-notifications.mjs');
    const breezeClient = await import('./breeze-client.mjs');

    // Process each employee in parallel (batches of 10 to avoid rate limits)
    const batchSize = 10;
    for (let i = 0; i < employees.length; i += batchSize) {
      const batch = employees.slice(i, i + batchSize);

      const promises = batch.map(async (emp) => {
        try {
          checked++;

          // 1. Check COI expiry
          if (emp.coi_expiry) {
            const today = new Date();
            const expiry = new Date(emp.coi_expiry);
            const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

            // Remind if expiring within 30 days
            if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
              await notifier.sendCOIReminder({
                to_email: emp.email,
                to_phone: emp.phone,
                worker_name: emp.name,
                expiry_date: emp.coi_expiry,
                upload_url: `${process.env.RENDER_EXTERNAL_URL || 'https://paytrack.lemedspa.app'}/compliance.html`,
              });
              reminders_triggered++;
            }
          }

          // 2. Check professional license (auto-verify)
          if (emp.professional_license && emp.professional_title) {
            try {
              const result = await breezeClient.queryLicense(emp.professional_title, {
                licenseNumber: emp.license_number,
              });

              // Store result
              await supabase
                .from('compliance_documents')
                .upsert({
                  employee_id: emp.id,
                  document_type: 'license',
                  license_status: result.status,
                  license_verified_at: new Date().toISOString(),
                  license_profession: result.profession,
                  status: result.status === 'valid' ? 'approved' : 'pending',
                }, {
                  onConflict: 'employee_id,document_type',
                });

              // Notify if expiring or invalid
              if (result.status === 'valid') {
                // Only notify on first successful verification
                const { data: doc } = await supabase
                  .from('compliance_documents')
                  .select('created_at')
                  .eq('employee_id', emp.id)
                  .eq('document_type', 'license')
                  .maybeSingle();

                if (doc && new Date(doc.created_at) < new Date(new Date().getTime() - 24*60*60*1000)) {
                  // Already notified within 24 hours, skip
                } else {
                  await notifier.sendLicenseValid({
                    to_email: emp.email,
                    worker_name: emp.name,
                    profession: result.profession,
                    expiry_date: result.expiryDate,
                  });
                  reminders_triggered++;
                }
              } else if (result.status === 'expired') {
                await notifier.sendLicenseRenewalDue({
                  to_email: emp.email,
                  to_phone: emp.phone,
                  worker_name: emp.name,
                  profession: result.profession,
                  expiry_date: result.expiryDate,
                  state: 'California',
                });
                reminders_triggered++;
              } else {
                // invalid or not_found
                await notifier.sendLicenseInvalid({
                  to_email: emp.email,
                  worker_name: emp.name,
                  profession: result.profession,
                });
                reminders_triggered++;
              }
            } catch (licenseErr) {
              console.warn(`License check failed for ${emp.id}: ${licenseErr.message}`);
            }
          }

          // 3. Check W9/Contract status
          if (!emp.w9_signed) {
            const { data: req } = await supabase
              .from('compliance_requests')
              .select('created_at, used_at')
              .eq('employee_id', emp.id)
              .eq('document_type', 'w9')
              .eq('type', 'esign')
              .order('created_at', { ascending: false })
              .maybeSingle();

            // Only re-trigger if no active request in last 7 days
            const sevenDaysAgo = new Date(new Date().getTime() - 7*24*60*60*1000);
            if (!req || new Date(req.created_at) < sevenDaysAgo) {
              // Would trigger esign-request here, but requires admin password
              // For now, just note it
              console.log(`W9 not signed for employee ${emp.id}, would trigger esign-request`);
            }
          }

          if (!emp.contract_signed) {
            const { data: req } = await supabase
              .from('compliance_requests')
              .select('created_at, used_at')
              .eq('employee_id', emp.id)
              .eq('document_type', 'contract')
              .eq('type', 'esign')
              .order('created_at', { ascending: false })
              .maybeSingle();

            // Only re-trigger if no active request in last 7 days
            const sevenDaysAgo = new Date(new Date().getTime() - 7*24*60*60*1000);
            if (!req || new Date(req.created_at) < sevenDaysAgo) {
              console.log(`Contract not signed for employee ${emp.id}, would trigger esign-request`);
            }
          }
        } catch (err) {
          errors.push(`Error processing employee ${emp.id}: ${err.message}`);
          console.error(`Error processing employee ${emp.id}:`, err);
        }
      });

      await Promise.allSettled(promises);
    }

    // Update last_compliance_scan timestamp on all employees
    await supabase
      .from('employees')
      .update({ last_compliance_scan: new Date().toISOString() })
      .not('created_at', 'is', null);

    return { checked, reminders_triggered, errors };
  } catch (err) {
    errors.push(`Scan failed: ${err.message}`);
    return { checked, reminders_triggered, errors };
  }
}

// Export for direct invocation (e.g., via CLI)
export default runComplianceScan;
