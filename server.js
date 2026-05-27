const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const { getPayPeriod, formatDateForDB, getPayPeriodByOffset, getPayPeriodLabel } = require('./lib/pay-periods');
const { validateOnboarding, extractLast4SSN, extractLast4Routing, extractLast4Account, CLINICAL_TITLES } = require('./lib/onboarding-validation');
const { encryptValue } = require('./lib/crypto');
const { randomUUID } = require('crypto');
const { router: complianceRouter, init: initCompliance } = require('./routes/compliance');
const { router: plaidRouter, init: initPlaid } = require('./routes/plaid');

// Timing-safe password comparison to prevent timing attacks
const verifyAdminPassword = (provided, expected) => {
  if (!provided || !expected) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  try {
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
};

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// CORS: restrict to known origins (lemedspa.app, api.lemedspa.app, localhost for dev)
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'https://paytrack.lemedspa.app',
      'https://lemedspa.app',
      'https://api.lemedspa.app',
      'http://localhost:3000',
      'http://localhost:5173',
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-password'],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting for admin routes to prevent brute-force password attacks
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  keyGenerator: (req) => req.headers['x-admin-password'] || req.headers.password || req.ip,
  skip: (req) => !req.path.startsWith('/api/admin') && !req.path.startsWith('/api/compliance') && !req.path.startsWith('/api/plaid'),
  message: 'Too many admin requests, please try again later',
});
app.use(adminLimiter);

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required');
  console.error('Please set these in your Render environment variables');
  process.exit(1);
}

// Admin password — required for all admin routes
if (!process.env.ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is required');
  console.error('Set it in Render environment variables and local .env');
  process.exit(1);
}

// Encryption key — required for onboarding PII storage
if (!process.env.PAYTRACK_ENCRYPTION_KEY) {
  console.error('ERROR: PAYTRACK_ENCRYPTION_KEY environment variable is required');
  console.error('Generate one with: node scripts/generate-encryption-key.mjs');
  console.error('Then set it in Render environment variables and local .env');
  process.exit(1);
}
// Validate key length at startup (fail fast — don't wait for first onboarding submission)
{
  const keyBuf = Buffer.from(process.env.PAYTRACK_ENCRYPTION_KEY, 'base64');
  if (keyBuf.length !== 32) {
    console.error(
      `ERROR: PAYTRACK_ENCRYPTION_KEY must decode to 32 bytes (got ${keyBuf.length}). ` +
        'Regenerate with: node scripts/generate-encryption-key.mjs',
    );
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Service-role client for storage uploads and compliance routes (bypasses RLS)
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : supabase; // fallback to anon if not set (dev only)

initCompliance(supabaseAdmin, process.env.ADMIN_PASSWORD);
app.use('/api/compliance', complianceRouter);

// Plaid is optional — warn if not configured
if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  console.warn('Warning: PLAID_CLIENT_ID or PLAID_SECRET not set — Bank Integration will be disabled');
}
if (!process.env.RENDER_SERVICE_ID) {
  console.warn('Warning: RENDER_SERVICE_ID not set — Plaid cursor/token will not persist after sync');
}
initPlaid(supabaseAdmin, process.env.ADMIN_PASSWORD);
app.use('/api/admin/plaid', plaidRouter);

// Multer: memory storage — files buffered in memory, then pushed to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png']);
    if (allowed.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPG, and PNG files are accepted'));
    }
  },
});

// Keep-alive ping to prevent Render spin down
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
function setupKeepAlive() {
  if (process.env.NODE_ENV === 'production') {
    setInterval(async () => {
      try {
        const response = await fetch(`${SELF_URL}/api/health`);
        console.log(`[Keep-alive] Ping at ${new Date().toISOString()}: ${response.ok ? 'OK' : 'Failed'}`);
      } catch (err) {
        console.log(`[Keep-alive] Ping failed: ${err.message}`);
      }
    }, 14 * 60 * 1000); // Every 14 minutes
    console.log('[Keep-alive] Scheduled ping every 14 minutes');
  }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Invoice table image for MMS — fetched by Twilio when delivering the MMS
app.get('/api/invoice-media/:invoiceId', async (req, res) => {
  // Require admin authentication before exposing employee PII and financial data
  const password = req.headers['x-admin-password'] || req.headers.password;
  if (!password || !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(adminPassword || ''))) {
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
    .select(
      'employee_id, pay_period_start, pay_period_end, total_payable, total_hours, total_wages, total_commissions, total_product_commissions, total_tips, cash_tips_received',
    )
    .eq('id', invoiceId)
    .single();
  if (!inv) return res.status(404).send('Not found');

  const { data: emp } = await supabaseAdmin
    .from('employees')
    .select('name, hourly_wage')
    .eq('id', inv.employee_id)
    .single();

  const { data: timeEntries } = await supabaseAdmin
    .from('time_entries')
    .select('id, date, hours')
    .eq('employee_id', inv.employee_id)
    .gte('date', inv.pay_period_start)
    .lte('date', inv.pay_period_end)
    .order('date', { ascending: true });

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

  const entries = [];
  for (const entry of timeEntries || []) {
    const { data: clients } = await supabaseAdmin
      .from('client_entries')
      .select('amount_earned, tip_amount, tip_received_cash')
      .eq('time_entry_id', entry.id);
    const { data: sales } = await supabaseAdmin
      .from('product_sales')
      .select('commission_amount')
      .eq('time_entry_id', entry.id);

    let dayCommissions = 0,
      dayTips = 0,
      dayCashTips = 0,
      dayProductCommissions = 0;
    for (const c of clients || []) {
      dayCommissions += c.amount_earned || 0;
      dayTips += c.tip_amount || 0;
      if (c.tip_received_cash) dayCashTips += c.tip_amount || 0;
    }
    for (const s of sales || []) dayProductCommissions += s.commission_amount || 0;

    entries.push({
      date: entry.date,
      hours: entry.hours,
      wages: entry.hours * (emp?.hourly_wage || 0),
      commissions: dayCommissions,
      productCommissions: dayProductCommissions,
      tips: dayTips,
      cashTips: dayCashTips,
      payouts: payoutsByDate[entry.date] || 0,
    });
  }

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

// Initialize database tables
async function initDatabase() {
  console.log('Initializing Supabase database...');

  // Create employees table
  const { error: empError } = await supabaseAdmin.rpc('create_employees_table_if_not_exists');
  if (empError && !empError.message.includes('already exists')) {
    // Table might already exist, that's fine
    console.log('Employees table check:', empError?.message || 'OK');
  }

  // Check if we have any employees
  const { data: employees, error: countError } = await supabaseAdmin
    .from('employees')
    .select('id')
    .limit(1);

  if (!countError && (!employees || employees.length === 0)) {
    // Insert sample employee
    const { error: insertError } = await supabaseAdmin
      .from('employees')
      .insert({
        name: 'Sample Employee',
        pin: '1234',
        hourly_wage: 15.00,
        pay_type: 'hourly'
      });

    if (!insertError) {
      console.log('Created sample employee with PIN: 1234');
    }
  }

  console.log('Database initialization complete');
}

// Pay period helpers imported from ./lib/pay-periods.js

function formatHoursEmailDisplay(decimalHours) {
  const h = Math.floor(decimalHours);
  const m = Math.round((decimalHours - h) * 60);
  return `${h}:${String(m).padStart(2, '0')} / ${decimalHours.toFixed(2)}`;
}

function formatHoursShort(decimalHours) {
  const h = Math.floor(decimalHours);
  const m = Math.round((decimalHours - h) * 60);
  return `${h}h${m > 0 ? String(m).padStart(2, '0') + 'm' : ''}`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Phone number for Lea (invoice review SMS recipient)
const LEA_PHONE = process.env.LEA_PHONE_NUMBER || '+13105033934';

function buildInvoiceImageSvg(employeeName, periodStart, periodEnd, summary, entries) {
  const W = 760;
  const MARGIN = 14;
  const TW = W - MARGIN * 2;

  const cols = [
    { label: 'Date', w: 0.118 },
    { label: 'Hours', w: 0.098 },
    { label: 'Wages', w: 0.108 },
    { label: 'Svc Comm', w: 0.112 },
    { label: 'Sales Comm', w: 0.112 },
    { label: 'Tips', w: 0.09 },
    { label: '-Cash Tips', w: 0.108 },
    { label: '-Payouts', w: 0.098 },
    { label: 'Day Total', w: 0.156 },
  ];

  const ROW_H = 28;
  const HEAD_H = 36;
  const TITLE_H = 44;
  const FOOT_H = 38;
  const rows = entries || [];
  const totalH = TITLE_H + HEAD_H + rows.length * ROW_H + FOOT_H + MARGIN;

  const xs = [];
  let cx = MARGIN;
  for (const c of cols) {
    xs.push(cx);
    cx += c.w * TW;
  }
  xs.push(cx);

  const ty = (rowY, h) => rowY + h * 0.67;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}">
<rect width="${W}" height="${totalH}" fill="white"/>
`;

  svg += `<text x="${W / 2}" y="28" font-size="13" fill="#222" font-weight="bold" text-anchor="middle" font-family="sans-serif">${escapeXml(employeeName)} — ${periodStart} to ${periodEnd}</text>\n`;

  const hy = TITLE_H;
  svg += `<rect x="${MARGIN}" y="${hy}" width="${TW}" height="${HEAD_H}" fill="#e8e8e8"/>\n`;
  for (let i = 0; i < cols.length; i++) {
    const tx = i === 0 ? xs[i] + 4 : xs[i + 1] - 4;
    const anchor = i === 0 ? 'start' : 'end';
    svg += `<text x="${tx}" y="${ty(hy, HEAD_H)}" font-size="10" fill="#333" font-weight="bold" text-anchor="${anchor}" font-family="sans-serif">${cols[i].label}</text>\n`;
  }

  let ry = TITLE_H + HEAD_H;
  for (let r = 0; r < rows.length; r++) {
    const e = rows[r];
    const dayTotal =
      e.wages + e.commissions + e.productCommissions + e.tips - e.cashTips - (e.payouts || 0);
    const bg = r % 2 === 0 ? '#ffffff' : '#f7f7f7';
    const vals = [
      e.date,
      formatHoursShort(e.hours),
      '$' + e.wages.toFixed(2),
      '$' + e.commissions.toFixed(2),
      '$' + e.productCommissions.toFixed(2),
      '$' + e.tips.toFixed(2),
      e.cashTips > 0 ? '-$' + e.cashTips.toFixed(2) : '-',
      (e.payouts || 0) > 0 ? '-$' + e.payouts.toFixed(2) : '-',
      '$' + dayTotal.toFixed(2),
    ];

    svg += `<rect x="${MARGIN}" y="${ry}" width="${TW}" height="${ROW_H}" fill="${bg}"/>\n`;
    for (let i = 0; i < cols.length; i++) {
      const tx = i === 0 ? xs[i] + 4 : xs[i + 1] - 4;
      const anchor = i === 0 ? 'start' : 'end';
      const red = (i === 6 || i === 7) && vals[i] !== '-';
      const bold = i === 8;
      svg += `<text x="${tx}" y="${ty(ry, ROW_H)}" font-size="10" fill="${red ? '#cc0000' : '#222'}" font-weight="${bold ? 'bold' : 'normal'}" text-anchor="${anchor}" font-family="sans-serif">${escapeXml(vals[i])}</text>\n`;
    }
    svg += `<line x1="${MARGIN}" y1="${ry + ROW_H}" x2="${MARGIN + TW}" y2="${ry + ROW_H}" stroke="#e0e0e0" stroke-width="0.5"/>\n`;
    ry += ROW_H;
  }

  svg += `<rect x="${MARGIN}" y="${ry}" width="${TW}" height="${FOOT_H}" fill="#d4edda"/>\n`;
  svg += `<text x="${MARGIN + 4}" y="${ty(ry, FOOT_H)}" font-size="11" fill="#155724" font-weight="bold" font-family="sans-serif">TOTAL PAYABLE</text>\n`;
  svg += `<text x="${MARGIN + TW - 4}" y="${ty(ry, FOOT_H)}" font-size="12" fill="#155724" font-weight="bold" text-anchor="end" font-family="sans-serif">$${summary.totalPayable.toFixed(2)}</text>\n`;

  svg += `<rect x="${MARGIN}" y="${TITLE_H}" width="${TW}" height="${HEAD_H + rows.length * ROW_H + FOOT_H}" fill="none" stroke="#aaa" stroke-width="1"/>\n`;

  for (let i = 1; i < cols.length; i++) {
    svg += `<line x1="${xs[i].toFixed(1)}" y1="${TITLE_H}" x2="${xs[i].toFixed(1)}" y2="${ry + FOOT_H}" stroke="#ddd" stroke-width="0.5"/>\n`;
  }

  svg += '</svg>';
  return svg;
}

async function sendInvoiceSms(employeeName, periodStart, periodEnd, totalPayable, entries, invoiceId) {
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!SID || !TOKEN) {
    console.log('[InvoiceSMS] Twilio not configured — skipping SMS');
    return { sent: false, reason: 'Twilio not configured' };
  }

  const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://paytrack.lemedspa.app';
  const mediaUrl = `${BASE_URL}/api/invoice-media/${invoiceId}`;
  const body = `Invoice submitted: ${employeeName} (${periodStart}–${periodEnd})\nTotal payable: $${totalPayable.toFixed(2)}`;

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
      },
      body: new URLSearchParams({ From: '+12134442242', To: LEA_PHONE, Body: body, MediaUrl0: mediaUrl }),
    });
    const result = await res.json();
    if (res.ok) {
      console.log(`[InvoiceSMS] MMS sent to Lea, SID: ${result.sid}`);
      return { sent: true };
    }
    console.error('[InvoiceSMS] Twilio error:', result);
    return { sent: false, reason: result.message };
  } catch (err) {
    console.error('[InvoiceSMS] Error:', err.message);
    return { sent: false, reason: err.message };
  }
}

// Simple email sending function (using fetch to external email API)
async function sendInvoiceEmail(employee, periodStart, periodEnd, summary, entries) {
  // Check if Resend API key is configured
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    console.log('[Email] No RESEND_API_KEY configured - email not sent');
    return { sent: false, reason: 'No API key configured' };
  }

  const tdStyle = 'border: 1px solid #ddd; padding: 8px;';
  const tdRight = 'border: 1px solid #ddd; padding: 8px; text-align: right;';

  // Build daily entries detail table
  let entriesTableRows = '';
  if (entries && entries.length > 0) {
    entries.forEach(entry => {
      const dayTotal = entry.wages + entry.commissions + entry.productCommissions + entry.tips - entry.cashTips - (entry.payouts || 0);
      entriesTableRows += `
        <tr>
          <td style="${tdStyle}">${entry.date}</td>
          <td style="${tdRight}">${formatHoursEmailDisplay(entry.hours)}</td>
          <td style="${tdRight}">$${entry.wages.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.commissions.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.productCommissions.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.tips.toFixed(2)}</td>
          <td style="${tdRight}; color: #cc0000;">${entry.cashTips > 0 ? '-$' + entry.cashTips.toFixed(2) : '-'}</td>
          <td style="${tdRight}; color: #cc0000;">${(entry.payouts || 0) > 0 ? '-$' + entry.payouts.toFixed(2) : '-'}</td>
          <td style="${tdRight}; font-weight: 600;">$${dayTotal.toFixed(2)}</td>
        </tr>
      `;
    });
  }

  const entriesTable = entries && entries.length > 0 ? `
    <h3 style="margin-top: 32px; margin-bottom: 8px; font-size: 14px; color: #333;">Daily Entry Detail</h3>
    <table style="border-collapse: collapse; width: 100%; margin-bottom: 20px; font-size: 12px;">
      <thead>
        <tr style="background: #f5f5f5;">
          <th style="${tdStyle} text-align: left;">Date</th>
          <th style="${tdRight} text-align: right;">Time/Hours Worked</th>
          <th style="${tdRight} text-align: right;">Wages</th>
          <th style="${tdRight} text-align: right;">Svc Comm</th>
          <th style="${tdRight} text-align: right;">Sales Comm</th>
          <th style="${tdRight} text-align: right;">Tips</th>
          <th style="${tdRight} text-align: right;">Cash Tips</th>
          <th style="${tdRight} text-align: right;">Payouts</th>
          <th style="${tdRight} text-align: right;">Day Total</th>
        </tr>
      </thead>
      <tbody>${entriesTableRows}</tbody>
    </table>
  ` : '';

  const emailBody = `
    <h2>LeMed Spa - Pay Period Invoice</h2>
    <p><strong>Employee:</strong> ${employee.name}</p>
    <p><strong>Pay Period:</strong> ${periodStart} to ${periodEnd}</p>

    <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
      <tr style="background: #f5f5f5;">
        <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Description</th>
        <th style="border: 1px solid #ddd; padding: 10px; text-align: right;">Amount</th>
      </tr>
      <tr>
        <td style="border: 1px solid #ddd; padding: 10px;">Time/Hours Worked (${formatHoursEmailDisplay(summary.totalHours)} @ $${employee.hourlyWage}/hr)</td>
        <td style="border: 1px solid #ddd; padding: 10px; text-align: right;">$${summary.totalWages.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="border: 1px solid #ddd; padding: 10px;">Service Commissions</td>
        <td style="border: 1px solid #ddd; padding: 10px; text-align: right;">$${summary.totalCommissions.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="border: 1px solid #ddd; padding: 10px;">Sales Commissions</td>
        <td style="border: 1px solid #ddd; padding: 10px; text-align: right;">$${summary.totalProductCommissions.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="border: 1px solid #ddd; padding: 10px;">Tips</td>
        <td style="border: 1px solid #ddd; padding: 10px; text-align: right;">$${summary.totalTips.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="border: 1px solid #ddd; padding: 10px; color: #cc0000;">Less: Cash Tips Already Received</td>
        <td style="border: 1px solid #ddd; padding: 10px; text-align: right; color: #cc0000;">-$${summary.totalCashTips.toFixed(2)}</td>
      </tr>
      ${summary.totalPayouts > 0 ? `
      <tr>
        <td style="border: 1px solid #ddd; padding: 10px; color: #cc0000;">Less: Payouts Already Made</td>
        <td style="border: 1px solid #ddd; padding: 10px; text-align: right; color: #cc0000;">-$${summary.totalPayouts.toFixed(2)}</td>
      </tr>` : ''}
      <tr style="background: #e8f5e9;">
        <td style="border: 1px solid #ddd; padding: 10px;"><strong>TOTAL PAYABLE</strong></td>
        <td style="border: 1px solid #ddd; padding: 10px; text-align: right;"><strong>$${summary.totalPayable.toFixed(2)}</strong></td>
      </tr>
    </table>

    ${entriesTable}

    <p style="color: #666; font-size: 12px;">Submitted via LM PayTrack</p>
  `;

  const recipients = ['lea@lemedspa.com', 'ops@lemedspa.com'];
  const cc = employee.email ? [employee.email] : [];

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'LM PayTrack <paytrack@lemedspa.com>',
        to: recipients,
        cc: cc,
        subject: `Pay Period Invoice - ${employee.name} - ${periodStart} to ${periodEnd}`,
        html: emailBody,
      }),
    });

    const result = await response.json();

    if (response.ok) {
      console.log('[Email] Invoice sent successfully:', result.id);
      return { sent: true, id: result.id };
    } else {
      console.error('[Email] Failed to send:', result);
      return { sent: false, reason: result.message || 'API error' };
    }
  } catch (error) {
    console.error('[Email] Error sending invoice:', error.message);
    return { sent: false, reason: error.message };
  }
}

// ============ API ROUTES ============

// Verify that the PIN in x-employee-pin header matches the given employeeId.
// Returns true if valid, false otherwise.
async function verifyEmployeePin(employeeId, pin) {
  if (!pin || !employeeId) return false;
  const { data } = await supabaseAdmin
    .from('employees')
    .select('id')
    .eq('id', parseInt(employeeId))
    .eq('pin', pin)
    .single();
  return !!data;
}

// Rate limiter for PIN verification — 10 attempts per 15 minutes per IP
const pinRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// Verify employee PIN
app.post('/api/verify-pin', pinRateLimit, async (req, res) => {
  const { pin } = req.body;

  const { data: employee, error } = await supabaseAdmin
    .from('employees')
    .select('id, name, email, hourly_wage, commission_rate, pay_type')
    .eq('pin', pin)
    .single();

  if (error || !employee) {
    res.json({ success: false, message: 'Invalid PIN' });
  } else {
    res.json({ success: true, employee });
  }
});

// Change PIN
app.post('/api/change-pin', async (req, res) => {
  const { employeeId, currentPin, newPin } = req.body;

  // Verify current PIN
  const { data: employee, error: verifyError } = await supabaseAdmin
    .from('employees')
    .select('id')
    .eq('id', employeeId)
    .eq('pin', currentPin)
    .single();

  if (verifyError || !employee) {
    return res.json({ success: false, message: 'Current PIN is incorrect' });
  }

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

// Check for conflicting entries
app.post('/api/check-conflict', async (req, res) => {
  const { employeeId, date } = req.body;

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

// Delete a specific time entry (for override)
app.delete('/api/time-entry/:id', async (req, res) => {
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

// Submit time entry with client entries and product sales
app.post('/api/time-entry', async (req, res) => {
  const { employeeId, date, startTime, endTime, breakMinutes, hours, description, clients, productSales } = req.body;
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
      hours: hours,
      description: description || ''
    })
    .select()
    .single();

  if (error) {
    return res.status(400).json({ success: false, message: error.message });
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

// Get time entries for an employee with client entries
app.get('/api/time-entries/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const pin = req.headers['x-employee-pin'];

  if (!(await verifyEmployeePin(employeeId, pin))) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { data: entries, error } = await supabaseAdmin
    .from('time_entries')
    .select('id, date, start_time, end_time, break_minutes, hours, description, created_at')
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

// Get pay period summary
app.get('/api/pay-period/:employeeId', async (req, res) => {
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

  // Get time entries for this period
  const { data: entries } = await supabaseAdmin
    .from('time_entries')
    .select('id, date, hours')
    .eq('employee_id', parseInt(employeeId))
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });

  let totalHours = 0;
  let totalCommissions = 0;
  let totalTips = 0;
  let totalCashTips = 0;
  let totalProductCommissions = 0;

  for (const entry of (entries || [])) {
    totalHours += entry.hours;

    // Get client entries
    const { data: clients } = await supabaseAdmin
      .from('client_entries')
      .select('amount_earned, tip_amount, tip_received_cash')
      .eq('time_entry_id', entry.id);

    for (const c of (clients || [])) {
      totalCommissions += c.amount_earned || 0;
      totalTips += c.tip_amount || 0;
      if (c.tip_received_cash) {
        totalCashTips += c.tip_amount || 0;
      }
    }

    // Get product sales
    const { data: sales } = await supabaseAdmin
      .from('product_sales')
      .select('commission_amount')
      .eq('time_entry_id', entry.id);

    for (const s of (sales || [])) {
      totalProductCommissions += s.commission_amount || 0;
    }
  }

  const hourlyWage = employee?.hourly_wage || 0;
  const totalWages = totalHours * hourlyWage;

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
    totalHours,
    totalWages,
    totalCommissions,
    totalTips,
    totalCashTips,
    totalProductCommissions,
    totalPayable: totalWages + totalCommissions + totalTips + totalProductCommissions - totalCashTips,
    hourlyWage,
    entries: entries || [],
    invoiceSubmitted: !!existingInvoice,
    invoiceDate: existingInvoice?.submitted_at
  });
});

// Submit invoice
app.post('/api/submit-invoice', async (req, res) => {
  const { employeeId, periodStart, periodEnd, totalHours, totalWages, totalCommissions, totalTips, totalCashTips, totalProductCommissions, totalPayable } = req.body;

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

  // Re-fetch entries for the email detail table
  const { data: emailEntries } = await supabaseAdmin
    .from('time_entries')
    .select('id, date, hours')
    .eq('employee_id', employeeId)
    .gte('date', periodStart)
    .lte('date', periodEnd)
    .order('date', { ascending: true });

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

  const detailedEntries = [];
  for (const entry of (emailEntries || [])) {
    const { data: clients } = await supabaseAdmin
      .from('client_entries')
      .select('amount_earned, tip_amount, tip_received_cash')
      .eq('time_entry_id', entry.id);

    const { data: sales } = await supabaseAdmin
      .from('product_sales')
      .select('commission_amount')
      .eq('time_entry_id', entry.id);

    let dayCommissions = 0;
    let dayTips = 0;
    let dayCashTips = 0;
    for (const c of (clients || [])) {
      dayCommissions += c.amount_earned || 0;
      dayTips += c.tip_amount || 0;
      if (c.tip_received_cash) dayCashTips += c.tip_amount || 0;
    }
    let dayProductCommissions = 0;
    for (const s of (sales || [])) {
      dayProductCommissions += s.commission_amount || 0;
    }
    const dayPayouts = payoutsByDate[entry.date] || 0;
    const dayWages = entry.hours * (employee?.hourly_wage || 0);

    detailedEntries.push({
      date: entry.date,
      hours: entry.hours,
      wages: dayWages,
      commissions: dayCommissions,
      productCommissions: dayProductCommissions,
      tips: dayTips,
      cashTips: dayCashTips,
      payouts: dayPayouts,
    });
  }

  // Try to send email
  const emailResult = await sendInvoiceEmail(
    { name: employee?.name, email: employee?.email, hourlyWage: employee?.hourly_wage || 0 },
    periodStart,
    periodEnd,
    { totalHours, totalWages, totalCommissions, totalProductCommissions, totalTips, totalCashTips, totalPayouts, totalPayable },
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
  console.log(`
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

// Helper to get today's date in LA timezone
function getLATodayString() {
  const now = new Date();
  const laDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return `${laDate.getFullYear()}-${String(laDate.getMonth() + 1).padStart(2, '0')}-${String(laDate.getDate()).padStart(2, '0')}`;
}

// Get invoice details for email preview
app.get('/api/invoice-preview/:employeeId', async (req, res) => {
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

  // Get all entries for the period with details (only up to today in LA time)
  const { data: entries } = await supabaseAdmin
    .from('time_entries')
    .select('id, date, start_time, end_time, hours')
    .eq('employee_id', parseInt(employeeId))
    .gte('date', periodStart)
    .lte('date', effectiveEndDate)
    .order('date', { ascending: false }); // Descending order (most recent first)

  const detailedEntries = [];
  let totalHours = 0;
  let totalCommissions = 0;
  let totalTips = 0;
  let totalCashTips = 0;
  let totalProductCommissions = 0;

  for (const entry of (entries || [])) {
    const { data: clients } = await supabaseAdmin
      .from('client_entries')
      .select('client_name, procedure_name, amount_earned, tip_amount, tip_received_cash')
      .eq('time_entry_id', entry.id);

    const { data: products } = await supabaseAdmin
      .from('product_sales')
      .select('product_name, sale_amount, commission_amount')
      .eq('time_entry_id', entry.id);

    let dayCommissions = 0;
    let dayTips = 0;
    let dayCashTips = 0;
    let dayProductCommissions = 0;

    for (const c of (clients || [])) {
      dayCommissions += c.amount_earned || 0;
      dayTips += c.tip_amount || 0;
      if (c.tip_received_cash) dayCashTips += c.tip_amount || 0;
    }

    for (const p of (products || [])) {
      dayProductCommissions += p.commission_amount || 0;
    }

    totalHours += entry.hours;
    totalCommissions += dayCommissions;
    totalTips += dayTips;
    totalCashTips += dayCashTips;
    totalProductCommissions += dayProductCommissions;

    detailedEntries.push({
      id: entry.id, // Include entry ID for delete functionality
      date: entry.date,
      startTime: entry.start_time,
      endTime: entry.end_time,
      hours: entry.hours,
      wages: entry.hours * employee.hourly_wage,
      commissions: dayCommissions,
      productCommissions: dayProductCommissions,
      tips: dayTips,
      cashTips: dayCashTips,
      clients: clients || [],
      products: products || []
    });
  }

  const totalWages = totalHours * employee.hourly_wage;

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
      totalHours,
      totalWages,
      totalCommissions,
      totalProductCommissions,
      totalTips,
      totalCashTips,
      totalPayable: totalWages + totalCommissions + totalTips + totalProductCommissions - totalCashTips
    }
  });
});

// Get payouts for an employee for a pay period (employee-facing)
app.get('/api/employee/payouts/:employeeId', async (req, res) => {
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

// ============ ADMIN ROUTES ============

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Verify admin password
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  res.json({ success: verifyAdminPassword(password, ADMIN_PASSWORD) });
});

// Get all employees (includes onboarding status)
app.get('/api/admin/employees', async (req, res) => {
  const password = req.headers['x-admin-password'];
  if (!verifyAdminPassword(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { data: employees, error } = await supabaseAdmin
    .from('employees')
    .select(
      'id, name, pin, email, phone, hourly_wage, additional_pay_rate, rate_notes, commission_rate, pay_type, designation, contractor_type, status, created_at, review_token, review_completed_at, zelle_name',
    );

  res.json(employees || []);
});

// Add new employee — auto-generates review_token
app.post('/api/admin/employees', async (req, res) => {
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

// Update employee
app.put('/api/admin/employees/:id', async (req, res) => {
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

// Admin direct PII edit — no review token required
app.put('/api/admin/employees/:id/pii', async (req, res) => {
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
    payload.tin_encrypted = encryptValue(req.body.tin_raw);
    payload.tin_last4 = req.body.tin_raw.replace(/\D/g, '').slice(-4);
  }
  if (req.body.bank_routing_raw) {
    payload.bank_routing_encrypted = encryptValue(req.body.bank_routing_raw);
    payload.bank_routing_last4 = req.body.bank_routing_raw.replace(/\D/g, '').slice(-4);
  }
  if (req.body.bank_account_raw) {
    payload.bank_account_encrypted = encryptValue(req.body.bank_account_raw);
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

// Delete employee
app.delete('/api/admin/employees/:id', async (req, res) => {
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

  // Delete related records
  for (const entry of (timeEntries || [])) {
    await supabaseAdmin.from('product_sales').delete().eq('time_entry_id', entry.id);
    await supabaseAdmin.from('client_entries').delete().eq('time_entry_id', entry.id);
  }

  await supabaseAdmin.from('invoices').delete().eq('employee_id', parseInt(id));
  await supabaseAdmin.from('time_entries').delete().eq('employee_id', parseInt(id));
  await supabaseAdmin.from('employees').delete().eq('id', parseInt(id));

  res.json({ success: true });
});

// Get all time entries (admin view)
app.get('/api/admin/time-entries', async (req, res) => {
  const password = req.headers['x-admin-password'] || req.headers.password;
  if (password !== ADMIN_PASSWORD) {
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

  // Transform and get client entries and product sales for each time entry
  const transformedEntries = [];
  for (const entry of (entries || [])) {
    const { data: clients } = await supabaseAdmin
      .from('client_entries')
      .select('id, client_name, procedure_name, notes, amount_earned, tip_amount, tip_received_cash')
      .eq('time_entry_id', entry.id);

    const { data: productSales } = await supabaseAdmin
      .from('product_sales')
      .select('id, product_name, sale_amount, commission_amount, notes')
      .eq('time_entry_id', entry.id);

    transformedEntries.push({
      id: entry.id,
      date: entry.date,
      start_time: entry.start_time,
      end_time: entry.end_time,
      break_minutes: entry.break_minutes,
      hours: entry.hours,
      description: entry.description,
      created_at: entry.created_at,
      employee_id: entry.employee_id,
      employee_name: entry.employees?.name,
      hourly_wage: entry.employees?.hourly_wage,
      commission_rate: entry.employees?.commission_rate,
      pay_type: entry.employees?.pay_type,
      clients: clients || [],
      productSales: productSales || []
    });
  }

  res.json(transformedEntries);
});

// Delete time entry (admin)
app.delete('/api/admin/time-entries/:id', async (req, res) => {
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

// Get all invoices (admin)
app.get('/api/admin/invoices', async (req, res) => {
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

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============ ONBOARDING ROUTES ============

// Admin: get PII/compliance details for an employee (masked — no *_encrypted columns)
app.get('/api/admin/employees/:id/onboarding', async (req, res) => {
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

// Admin: generate a new review token for an existing employee
app.post('/api/admin/employees/:id/onboarding-token', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) {
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

// Admin: send onboarding link via SMS or email
app.post('/api/admin/employees/:id/send-link', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) {
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

    const smsBody = `Hi ${firstName}, this is LeMed Spa. At initial onboarding and periodically thereafter, we may need you to provide or confirm certain tax, license, insurance, and payment information, by completing the form linked here: ${onboardingUrl} Questions? Reply to this email/text or text Mike at 310.621.8356 - Thanks!`;

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
        console.log(`[SendLink] SMS sent to ${toPhone} for employee ${id}, SID: ${result.sid}`);
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

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #333; line-height: 1.7;">
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
        console.log(`[SendLink] Email sent to ${employee.email} for employee ${id}, ID: ${result.id}`);
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

// Public: prefill data for review form (returns all available employee data for pre-population)
app.get('/api/onboarding/:token/prefill', async (req, res) => {
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

// Public: upload a file during onboarding (driver license or insurance certificate)
app.post(
  '/api/onboarding/:token/upload',
  upload.single('file'),
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

// Multer error handler (file too large, wrong type)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only PDF')) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
});

// Public: serve review page (validates token — link is always reusable)
app.get('/onboarding/:token', async (req, res) => {
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

// Public: submit review form (updates employees table directly)
app.post('/api/onboarding/:token', async (req, res) => {
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

  console.log(`[Review] Submitted for employee ${employee.id} (${employee.name})`);

  res.json({ success: true, message: 'Info confirmed. Thank you!' });
});

// ============ TAX FILINGS ROUTES ============

// List tax filings — optionally filtered by year
app.get('/api/admin/tax-filings', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// 1099-NEC contractor filings (from filings_1099 table — populated by populate-1099.mjs)
app.get('/api/admin/filings-1099', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// Get a single tax filing by id
app.get('/api/admin/tax-filings/:id', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { data, error } = await supabaseAdmin
    .from('tax_filings')
    .select('*')
    .eq('id', parseInt(req.params.id))
    .single();

  if (error) return res.status(404).json({ success: false, message: 'Not found' });
  res.json(data);
});

// Create a tax filing
app.post('/api/admin/tax-filings', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// Update a tax filing (e.g., change status to 'filed', update compensation amounts)
app.put('/api/admin/tax-filings/:id', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// Delete a tax filing
app.delete('/api/admin/tax-filings/:id', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { error } = await supabaseAdmin.from('tax_filings').delete().eq('id', parseInt(req.params.id));
  if (error) return res.status(400).json({ success: false, message: error.message });
  res.json({ success: true });
});

// Export tax filings for a year as Avalara/Track1099-compatible CSV
// Matches the 1099-NEC CSV template columns used by LeMed
app.get('/api/admin/tax-filings/export/:year', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// ============ EMPLOYEE DOCUMENTS ROUTES ============

// GET /api/admin/storage/signed-url?path=... — generate a 1-hour signed URL for any storage path
app.get('/api/admin/storage/signed-url', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// GET /api/admin/employees/:id/documents — list docs with signed download URLs
// Bulk compliance check — returns all docs (no signed URLs) for list view
app.get('/api/admin/employee-documents/all', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { data, error } = await supabaseAdmin
    .from('employee_documents')
    .select('employee_id, document_type, expiration_date');

  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

app.get('/api/admin/employees/:id/documents', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// POST /api/admin/employees/:id/documents — upload a new doc
app.post(
  '/api/admin/employees/:id/documents',
  upload.single('file'),
  async (req, res) => {
    const { password } = req.headers;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// PATCH /api/admin/employee-documents/:docId — update expiry/license without re-uploading
app.patch('/api/admin/employee-documents/:docId', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// DELETE /api/admin/employee-documents/:docId — remove a doc
app.delete('/api/admin/employee-documents/:docId', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

// ============ Compliance Items API ============

app.get('/api/admin/employees/:id/compliance-items', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const { data, error } = await supabaseAdmin
    .from('employee_compliance_items')
    .select('*')
    .eq('employee_id', parseInt(req.params.id));
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

app.put('/api/admin/employees/:id/compliance-items/:key', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });
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

// ============ Payments API ============

app.get('/api/admin/payments', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

app.get('/api/admin/payments/:id', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { data, error } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('id', parseInt(req.params.id))
    .single();

  if (error) return res.status(404).json({ success: false, message: 'Not found' });
  res.json(data);
});

app.post('/api/admin/payments', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

app.put('/api/admin/payments/:id', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

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

app.delete('/api/admin/payments/:id', async (req, res) => {
  const { password } = req.headers;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { error } = await supabaseAdmin.from('payments').delete().eq('id', parseInt(req.params.id));
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true });
});

// Start server
async function start() {
  await initDatabase();
  setupKeepAlive();

  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    LM PAYTRACK                             ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                  ║
║                                                            ║
║  Employee App:  http://localhost:${PORT}                      ║
║  Admin Panel:   http://localhost:${PORT}/admin                ║
║                                                            ║
║  Using Supabase PostgreSQL for data persistence            ║
║  Admin Password: Set via ADMIN_PASSWORD env var            ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);
