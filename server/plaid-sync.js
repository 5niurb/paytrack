'use strict';

const { syncTransactions } = require('./plaid-client');

// Build a Map from match-key (lowercase) → employee_id.
// Uses zelle_name if set and non-empty, otherwise full name.
// Keys shorter than 5 characters are skipped to prevent false-positive matches.
function buildMatchMap(employees) {
  const map = new Map();
  for (const emp of employees) {
    const zelleKey = (emp.zelle_name || '').trim();
    const key = (zelleKey || emp.name || '').trim().toLowerCase();
    if (key && key.length >= 5) map.set(key, emp.id);
  }
  return map;
}

// Match a transaction description against the map.
// Returns employee_id or null.
function matchTransaction(description, map) {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const [key, empId] of map) {
    if (lower.includes(key)) return empId;
  }
  return null;
}

// Detect payment method from transaction description.
// Returns 'zelle', 'ach', or null (not a payment we care about).
function detectPaymentMethod(description) {
  if (!description) return null;
  const lower = description.toLowerCase();
  if (lower.includes('zelle')) return 'zelle';
  if (
    lower.includes('ach') ||
    lower.includes('direct dep') ||
    lower.includes('payroll') ||
    lower.includes('direct deposit') ||
    lower.includes('basic online payroll payment')
  )
    return 'ach';
  return null;
}

// Hardcoded overrides: transaction descriptions that map to a specific employee name.
// Used for bank-specific payroll formats that don't include the employee name.
const HARDCODED_MATCHES = [
  // Chase "Basic Online Payroll Payment" to account ending 8792 = Jodi Kay
  { pattern: /basic online payroll payment.{0,40}8792/i, name: 'Jodi Kay' },
];

// Classify an array of Plaid transactions into matched + unmatched.
// Only processes debit (outgoing) ACH and Zelle transactions — all others are skipped.
// matchMap maps lowercase name key → { id, name } (employee record).
function classifyTransactions(transactions, matchMap) {
  const matched = [];
  const unmatched = [];

  for (const tx of transactions) {
    // Plaid returns debits as positive amounts (money leaving the account).
    // Skip credits (negative) and zero-value transactions.
    if (tx.amount <= 0) continue;

    const method = detectPaymentMethod(tx.name);
    if (!method) continue; // skip non-ACH/Zelle transactions

    // Check hardcoded rules first
    const hardcoded = HARDCODED_MATCHES.find((rule) => rule.pattern.test(tx.name));
    if (hardcoded) {
      matched.push({
        employee_name: hardcoded.name,
        employee_id: null, // resolved by caller
        plaid_transaction_id: tx.transaction_id,
        transaction_date: tx.date,
        amount: tx.amount,
        description: tx.name,
        payment_method: method,
      });
      continue;
    }

    const empId = matchTransaction(tx.name, matchMap);
    if (empId !== null) {
      const emp = [...matchMap.entries()].find(([, id]) => id === empId);
      matched.push({
        employee_id: empId,
        employee_name: null, // resolved by caller from employee list
        plaid_transaction_id: tx.transaction_id,
        transaction_date: tx.date,
        amount: tx.amount,
        description: tx.name,
        payment_method: method,
      });
    } else {
      unmatched.push({
        plaid_transaction_id: tx.transaction_id,
        transaction_date: tx.date,
        amount: tx.amount,
        description: tx.name,
        payment_method: method,
      });
    }
  }

  return { matched, unmatched };
}

// Load a value from app_settings, fallback to env var.
async function loadSetting(supabase, key, envFallback) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  return (data && data.value) || process.env[envFallback] || null;
}

// Persist a value to app_settings and process.env.
async function saveSetting(supabase, key, value, envKey) {
  if (envKey) process.env[envKey] = value;
  await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

// Full sync: fetch from Plaid, match, upsert to DB, advance cursor.
// Returns { matchedCount, pendingCount, newCursor, errors }
async function runSync(supabase) {
  const accessToken = await loadSetting(supabase, 'plaid_access_token', 'PLAID_ACCESS_TOKEN');
  const cursor = await loadSetting(supabase, 'plaid_cursor', 'PLAID_CURSOR');

  if (!accessToken) {
    throw new Error('Bank account not connected. Set PLAID_ACCESS_TOKEN via Link flow.');
  }

  const { data: employees, error: empError } = await supabase
    .from('employees')
    .select('id, name, zelle_name')
    .eq('status', 'active');

  if (empError) throw new Error('Failed to load employees: ' + empError.message);

  // Build a map of id → name for quick lookup
  const employeeById = new Map(employees.map((e) => [e.id, e.name]));

  const matchMap = buildMatchMap(employees);

  if (matchMap.size === 0) {
    console.warn('Warning: no active employees with valid match keys — all transactions will be pending');
  }

  // IMPORTANT: If syncTransactions throws mid-pagination, use the last persisted
  // cursor on retry — not the original cursor passed in.
  const { added, nextCursor } = await syncTransactions(accessToken, cursor);
  const { matched, unmatched } = classifyTransactions(added, matchMap);
  const errors = [];

  for (const tx of matched) {
    // Resolve employee_id for hardcoded matches (employee_id is null when matched by name only)
    let empId = tx.employee_id;
    let empName = tx.employee_name;
    if (!empId && empName) {
      // Find by name (case-insensitive)
      const found = employees.find((e) => e.name.toLowerCase() === empName.toLowerCase());
      if (found) {
        empId = found.id;
      }
    } else if (empId && !empName) {
      empName = employeeById.get(empId) || null;
    }

    const { error } = await supabase.from('payments').upsert(
      {
        employee_id: empId,
        teammate_name: empName,
        payment_date: tx.transaction_date,
        amount: tx.amount,
        notes: tx.description,
        payment_method: tx.payment_method,
        source: 'plaid',
        auto_imported: true,
        plaid_transaction_id: tx.plaid_transaction_id,
      },
      { onConflict: 'plaid_transaction_id', ignoreDuplicates: true },
    );
    if (error && !error.message.includes('duplicate')) {
      errors.push(`Failed to upsert payment for tx ${tx.plaid_transaction_id}: ${error.message}`);
    }
  }

  for (const tx of unmatched) {
    const { error } = await supabase.from('plaid_pending').upsert(
      {
        plaid_transaction_id: tx.plaid_transaction_id,
        transaction_date: tx.transaction_date,
        amount: tx.amount,
        description: tx.description,
        payment_method: tx.payment_method,
      },
      { onConflict: 'plaid_transaction_id', ignoreDuplicates: true },
    );
    if (error && !error.message.includes('duplicate')) {
      errors.push(`Failed to upsert pending tx ${tx.plaid_transaction_id}: ${error.message}`);
    }
  }

  // Advance cursor — persisted to Supabase (durable across deploys)
  if (nextCursor && nextCursor !== cursor) {
    await saveSetting(supabase, 'plaid_cursor', nextCursor, 'PLAID_CURSOR');
  }

  return {
    matchedCount: matched.length,
    pendingCount: unmatched.length,
    newCursor: nextCursor,
    errors,
  };
}

module.exports = { buildMatchMap, matchTransaction, detectPaymentMethod, classifyTransactions, runSync, loadSetting, saveSetting };
