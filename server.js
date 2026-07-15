// Sentry must initialize before other instrumentation. Gated on SENTRY_DSN —
// no-ops gracefully if unset (e.g. local dev), same pattern as lm-mobile.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
    release: process.env.npm_package_version || '1.0.0',
  });
}

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const crypto = require('crypto');
const compression = require('compression');

const {
  getPayPeriod,
  formatDateForDB,
  getPayPeriodByOffset,
  getPayPeriodLabel
} = require('./lib/pay-periods');
const {
  validateOnboarding,
  extractLast4SSN,
  extractLast4Routing,
  extractLast4Account,
  CLINICAL_TITLES
} = require('./lib/onboarding-validation');
const { encryptValue } = require('./lib/crypto');
const { buildHealth } = require('./lib/health');
const { fetchInvoiceSummary, aggregateEntries } = require('./lib/invoice-summary');
const { randomUUID } = require('crypto');
const debug = require('./lib/debug');
const { router: complianceRouter, init: initCompliance } = require('./routes/compliance');
const { router: plaidRouter, init: initPlaid } = require('./routes/plaid');
const { router: employeesRouter, init: initEmployees } = require('./routes/employees');
const { router: timeEntriesRouter, init: initTimeEntries } = require('./routes/time-entries');
const { router: invoicesRouter, init: initInvoices } = require('./routes/invoices');
const { router: onboardingRouter, init: initOnboarding } = require('./routes/onboarding');
const { router: adminRouter, init: initAdmin } = require('./routes/admin');

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

// Trust the single reverse proxy in front of us (Render's load balancer) so
// req.ip reflects the real client IP from X-Forwarded-For instead of the proxy
// IP. Without this, every request shares the proxy's IP and the rate limiter
// buckets all clients together. Trust exactly 1 hop — never `true`, which would
// trust spoofed X-Forwarded-For headers.
app.set('trust proxy', 1);

// Middleware
// Compression: gzip static assets and API responses (60-70% payload reduction)
app.use(compression({
  filter: (req, res) => {
    // Don't compress responses with this request header
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  },
  level: 6, // balanced compression level (1-9, 6 is default)
}));

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

// Cache control headers for static assets
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d', // 1 day cache for static assets
  etag: true,  // Enable ETags for cache validation
}));

// Cache control for API responses.
// All /api/ responses are per-employee dynamic data (time entries, pay periods,
// invoices, payouts, PII/banking, signed URLs). Caching them client-side risks
// (1) stale data after an edit looking like a failed save and (2) `public` shared
// caches storing one user's payroll/PII and serving it to another. So we never
// cache API responses. Payload size is already reduced by gzip compression above;
// static assets still get ETag/maxAge caching via express.static.
app.use('/api/', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Rate limiting for admin routes to prevent brute-force password attacks
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window (admin pages make many API calls)
  // Rate-limit by normalized client IP. We deliberately do NOT key on the
  // submitted admin password — doing so would give an attacker a fresh bucket
  // per password guess, defeating the brute-force protection this limiter
  // exists to provide. ipKeyGenerator buckets IPv6 by /64 prefix so it can't be
  // bypassed by varying low-order bits (ERR_ERL_KEY_GEN_IPV6).
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  skip: (req) => {
    return !req.path.startsWith('/api/admin')
      && !req.path.startsWith('/api/compliance')
      && !req.path.startsWith('/api/plaid');
  },
  message: { success: false, message: 'Too many admin requests, please try again later' },
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

initCompliance(supabaseAdmin, process.env.ADMIN_PASSWORD, verifyAdminPassword);
app.use('/api/compliance', complianceRouter);

// Plaid is optional — warn if not configured
if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  console.warn('Warning: PLAID_CLIENT_ID or PLAID_SECRET not set — Bank Integration will be disabled');
}
if (!process.env.RENDER_SERVICE_ID) {
  console.warn('Warning: RENDER_SERVICE_ID not set — Plaid cursor/token will not persist after sync');
}
initPlaid(supabaseAdmin, process.env.ADMIN_PASSWORD, verifyAdminPassword);
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

// Health check endpoint
app.get('/api/health', async (req, res) => {
  // Lightweight liveness + dependency check. Monitoring uses this to tell
  // "app process alive" from "page renders" and to catch Supabase-layer outages
  // (the 502 class of failure) before users do. ?deep=0 skips the DB probe.
  // Logic lives in lib/health.js (unit-tested in test/health.test.js).
  const { health, httpStatus } = await buildHealth({
    deep: req.query.deep !== '0',
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    // Cheap connectivity probe — HEAD-style count; lib/health caps it at 3s.
    probe: () => supabase.from('employees').select('id', { count: 'exact', head: true }),
  });
  res.status(httpStatus).json(health);
});

// Bare /health alias (no /api prefix) for platform/uptime checks that hit root paths.
app.get('/health', (req, res) => res.redirect(307, '/api/health' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));

// Invoice table image for MMS — fetched by Twilio when delivering the MMS

// Initialize database tables
async function initDatabase() {
  debug.log('Initializing Supabase database...');

  // Create employees table
  const { error: empError } = await supabaseAdmin.rpc('create_employees_table_if_not_exists');
  if (empError && !empError.message.includes('already exists')) {
    // Table might already exist, that's fine
    debug.log('Employees table check:', empError?.message || 'OK');
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
      debug.log('Created sample employee with PIN: 1234');
    }
  }

  debug.log('Database initialization complete');
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

  const titleTy = 28;
  const titleAttrs = 'font-size="13" fill="#222" font-weight="bold" text-anchor="middle"';
  const titleContent = `${escapeXml(employeeName)} — ${periodStart} to ${periodEnd}`;
  svg += `<text x="${W / 2}" y="${titleTy}" ${titleAttrs} font-family="sans-serif">${titleContent}</text>\n`;

  const hy = TITLE_H;
  const headAttrs = 'font-size="10" fill="#333" font-weight="bold"';
  svg += `<rect x="${MARGIN}" y="${hy}" width="${TW}" height="${HEAD_H}" fill="#e8e8e8"/>\n`;
  for (let i = 0; i < cols.length; i++) {
    const tx = i === 0 ? xs[i] + 4 : xs[i + 1] - 4;
    const anchor = i === 0 ? 'start' : 'end';
    svg += `<text x="${tx}" y="${ty(hy, HEAD_H)}" ${headAttrs} text-anchor="${anchor}"`;
    svg += ` font-family="sans-serif">${cols[i].label}</text>\n`;
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
      const fill = red ? '#cc0000' : '#222';
      const weight = bold ? 'bold' : 'normal';
      const rowAttrs = `font-size="10" fill="${fill}" font-weight="${weight}"`;
      svg += `<text x="${tx}" y="${ty(ry, ROW_H)}" ${rowAttrs} text-anchor="${anchor}"`;
      svg += ` font-family="sans-serif">${escapeXml(vals[i])}</text>\n`;
    }
    svg += `<line x1="${MARGIN}" y1="${ry + ROW_H}" x2="${MARGIN + TW}" y2="${ry + ROW_H}"`;
    svg += ` stroke="#e0e0e0" stroke-width="0.5"/>\n`;
    ry += ROW_H;
  }

  svg += `<rect x="${MARGIN}" y="${ry}" width="${TW}" height="${FOOT_H}" fill="#d4edda"/>\n`;
  const footAttrs = 'fill="#155724" font-weight="bold" font-family="sans-serif"';
  svg += `<text x="${MARGIN + 4}" y="${ty(ry, FOOT_H)}" font-size="11" ${footAttrs}>TOTAL PAYABLE</text>\n`;
  const totalStr = summary.totalPayable.toFixed(2);
  svg += `<text x="${MARGIN + TW - 4}" y="${ty(ry, FOOT_H)}" font-size="12" ${footAttrs}`;
  svg += ` text-anchor="end">$${totalStr}</text>\n`;

  const borderH = HEAD_H + rows.length * ROW_H + FOOT_H;
  svg += `<rect x="${MARGIN}" y="${TITLE_H}" width="${TW}" height="${borderH}"`;
  svg += ` fill="none" stroke="#aaa" stroke-width="1"/>\n`;

  for (let i = 1; i < cols.length; i++) {
    const xi = xs[i].toFixed(1);
    svg += `<line x1="${xi}" y1="${TITLE_H}" x2="${xi}" y2="${ry + FOOT_H}"`;
    svg += ` stroke="#ddd" stroke-width="0.5"/>\n`;
  }

  svg += '</svg>';
  return svg;
}

async function sendInvoiceSms(employeeName, periodStart, periodEnd, totalPayable, entries, invoiceId) {
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!SID || !TOKEN) {
    debug.log('[InvoiceSMS] Twilio not configured — skipping SMS');
    return { sent: false, reason: 'Twilio not configured' };
  }

  const BASE_URL = 'https://paytrack.lemedspa.app';
  const mediaUrl = `${BASE_URL}/api/invoice-media/${invoiceId}`;
  const totalStr = totalPayable.toFixed(2);
  const body = `Invoice submitted: ${employeeName} (${periodStart}–${periodEnd})\n` +
    `Total payable: $${totalStr}`;

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
      debug.log(`[InvoiceSMS] MMS sent to Lea, SID: ${result.sid}`);
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
    debug.log('[Email] No RESEND_API_KEY configured - email not sent');
    return { sent: false, reason: 'No API key configured' };
  }

  const tdStyle = 'border: 1px solid #ddd; padding: 8px;';
  const tdRight = 'border: 1px solid #ddd; padding: 8px; text-align: right;';

  // Build daily entries detail table
  let entriesTableRows = '';
  if (entries && entries.length > 0) {
    entries.forEach(entry => {
      const dayTotal = entry.wages + entry.commissions + entry.productCommissions +
        entry.tips - entry.cashTips - (entry.payouts || 0);
      const cashTipsStr = entry.cashTips > 0 ? '-$' + entry.cashTips.toFixed(2) : '-';
      const payoutsStr = (entry.payouts || 0) > 0 ? '-$' + entry.payouts.toFixed(2) : '-';
      entriesTableRows += `
        <tr>
          <td style="${tdStyle}">${entry.date}</td>
          <td style="${tdRight}">${formatHoursEmailDisplay(entry.hours)}</td>
          <td style="${tdRight}">$${entry.wages.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.commissions.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.productCommissions.toFixed(2)}</td>
          <td style="${tdRight}">$${entry.tips.toFixed(2)}</td>
          <td style="${tdRight}; color: #cc0000;">${cashTipsStr}</td>
          <td style="${tdRight}; color: #cc0000;">${payoutsStr}</td>
          <td style="${tdRight}; font-weight: 600;">$${dayTotal.toFixed(2)}</td>
        </tr>
      `;
    });
  }

  const tableStyle = 'border-collapse: collapse; width: 100%; margin-bottom: 20px; font-size: 12px;';
  const entriesTable = entries && entries.length > 0 ? `
    <h3 style="margin-top: 32px; margin-bottom: 8px; font-size: 14px; color: #333;">Daily Entry Detail</h3>
    <table style="${tableStyle}">
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

  const cellStyle = 'border: 1px solid #ddd; padding: 10px;';
  const cellRightStyle = cellStyle + ' text-align: right;';
  const cellRedStyle = cellStyle + ' color: #cc0000;';
  const cellRedRightStyle = cellRightStyle + ' color: #cc0000;';
  const hoursLabel = formatHoursEmailDisplay(summary.totalHours);
  const hourlyWageStr = employee.hourlyWage;
  const timeWorkedLabel = `Time/Hours Worked (${hoursLabel} @ $${hourlyWageStr}/hr)`;
  const payoutsRow = summary.totalPayouts > 0 ? `
      <tr>
        <td style="${cellRedStyle}">Less: Payouts Already Made</td>
        <td style="${cellRedRightStyle}">-$${summary.totalPayouts.toFixed(2)}</td>
      </tr>` : '';

  const emailBody = `
    <h2>LeMed Spa - Pay Period Invoice</h2>
    <p><strong>Employee:</strong> ${employee.name}</p>
    <p><strong>Pay Period:</strong> ${periodStart} to ${periodEnd}</p>

    <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
      <tr style="background: #f5f5f5;">
        <th style="${cellStyle} text-align: left;">Description</th>
        <th style="${cellRightStyle}">Amount</th>
      </tr>
      <tr>
        <td style="${cellStyle}">${timeWorkedLabel}</td>
        <td style="${cellRightStyle}">$${summary.totalWages.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="${cellStyle}">Service Commissions</td>
        <td style="${cellRightStyle}">$${summary.totalCommissions.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="${cellStyle}">Sales Commissions</td>
        <td style="${cellRightStyle}">$${summary.totalProductCommissions.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="${cellStyle}">Tips</td>
        <td style="${cellRightStyle}">$${summary.totalTips.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="${cellRedStyle}">Less: Cash Tips Already Received</td>
        <td style="${cellRedRightStyle}">-$${summary.totalCashTips.toFixed(2)}</td>
      </tr>
      ${payoutsRow}
      <tr style="background: #e8f5e9;">
        <td style="${cellStyle}"><strong>TOTAL PAYABLE</strong></td>
        <td style="${cellRightStyle}"><strong>$${summary.totalPayable.toFixed(2)}</strong></td>
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
      debug.log('[Email] Invoice sent successfully:', result.id);
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

// Change PIN — rate-limited because it accepts employeeId+currentPin and would
// otherwise allow unthrottled brute-force of a known employee's 4-digit PIN.

// Check for conflicting entries

// Delete a specific time entry (for override)

// Submit time entry with client entries and product sales

// Get time entries for an employee with client entries

// Get pay period summary

// Submit invoice

// Helper to get today's date in LA timezone
function getLATodayString() {
  const now = new Date();
  const laDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return `${laDate.getFullYear()}-${String(laDate.getMonth() + 1).padStart(2, '0')}-${String(laDate.getDate()).padStart(2, '0')}`;
}

// Get invoice details for email preview

// Get payouts for an employee for a pay period (employee-facing)

// ============ ADMIN ROUTES ============

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Shared dependencies injected into the extracted route modules. Each module
// destructures these into module-scoped vars with the same names its handlers
// use, so the moved route bodies are byte-identical to the pre-split versions.
// Routers are mounted at '/' (no prefix) — the full '/api/...' paths live inside
// each router.METHOD call, so route strings are unchanged. These mounts must
// come BEFORE the Sentry/multer error handlers below.
const routeDeps = {
  supabase,
  supabaseAdmin,
  verifyAdminPassword,
  ADMIN_PASSWORD,
  verifyEmployeePin,
  getLATodayString,
  pinRateLimit,
  upload,
  buildInvoiceImageSvg,
  sendInvoiceEmail,
  sendInvoiceSms,
  LEA_PHONE,
};
initEmployees(routeDeps);
initTimeEntries(routeDeps);
initInvoices(routeDeps);
initOnboarding(routeDeps);
initAdmin(routeDeps);
app.use(employeesRouter);
app.use(timeEntriesRouter);
app.use(invoicesRouter);
app.use(onboardingRouter);
app.use(adminRouter);

// Verify admin password

// Get all employees (includes onboarding status)

// Add new employee — auto-generates review_token

// Update employee

// Admin direct PII edit — no review token required

// Delete employee

// Get all time entries (admin view)

// Delete time entry (admin)

// Get all invoices (admin)

// Serve admin page

// ============ ONBOARDING ROUTES ============

// Admin: get PII/compliance details for an employee (masked — no *_encrypted columns)

// Admin: generate a new review token for an existing employee

// Admin: send onboarding link via SMS or email

// Public: prefill data for review form (returns all available employee data for pre-population)

// Public: upload a file during onboarding (driver license or insurance certificate)

// Multer error handler (file too large, wrong type)
// Sentry Express error handler — captures unhandled route errors to Sentry
// before they reach the custom handlers below. No-op if SENTRY_DSN is unset.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only PDF')) {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
});

// Public: serve review page (validates token — link is always reusable)

// Public: submit review form (updates employees table directly)

// ============ TAX FILINGS ROUTES ============

// List tax filings — optionally filtered by year

// 1099-NEC contractor filings (from filings_1099 table — populated by populate-1099.mjs)

// Get a single tax filing by id

// Create a tax filing

// Update a tax filing (e.g., change status to 'filed', update compensation amounts)

// Delete a tax filing

// Export tax filings for a year as Avalara/Track1099-compatible CSV
// Matches the 1099-NEC CSV template columns used by LeMed

// ============ EMPLOYEE DOCUMENTS ROUTES ============

// GET /api/admin/storage/signed-url?path=... — generate a 1-hour signed URL for any storage path

// GET /api/admin/employees/:id/documents — list docs with signed download URLs
// Bulk compliance check — returns all docs (no signed URLs) for list view


// POST /api/admin/employees/:id/documents — upload a new doc

// PATCH /api/admin/employee-documents/:docId — update expiry/license without re-uploading

// DELETE /api/admin/employee-documents/:docId — remove a doc

// ============ Compliance Items API ============



// ============ Payments API ============






// Start server
// Global crash handlers — capture to Sentry + log before the process dies, so a
// stray rejection doesn't take paytrack down silently. uncaughtException exits so
// Fly restarts a clean process (a corrupted-state process is worse than a restart).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err);
    // Actually wait for the event to deliver (flush returns a promise), then
    // exit for a clean Fly restart. 2s cap so a slow Sentry can't hang the exit.
    Sentry.flush(2000).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

async function start() {
  await initDatabase();

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
