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
const {
  buildInvoiceImageSvg,
  sendInvoiceEmail,
  sendInvoiceSms,
  LEA_PHONE,
} = require('./lib/invoice-presentation');
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

// Invoice presentation helpers (SVG image table, Resend email, Twilio MMS) live
// in lib/invoice-presentation.js. Imported at the top of this file.

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
