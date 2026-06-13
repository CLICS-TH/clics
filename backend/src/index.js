require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Fail closed in production: the encrypted identity vault, signed guest tokens, RIMPL shared secret,
// and locked CORS all depend on these. Refuse to start without them rather than degrade silently.
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
if (IS_PROD) {
  // RIMPL_URL + SITE_URL both silently fall back to localhost (rimpl-client.js / auth.js), so a
  // missing one leaves /health green while every chat turn and every invite link is broken — fail fast.
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'INTERNAL_TOKEN', 'GUEST_TOKEN_SECRET', 'IDENTITY_ENC_KEY', 'ALLOWED_ORIGINS', 'RIMPL_URL', 'SITE_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Refusing to start in production — missing env: ${missing.join(', ')}`);
}

const app = express();
app.set('trust proxy', 1); // behind Railway's proxy — required for correct per-IP rate limiting
app.use(helmet());
// CORS BEFORE the body parser: a malformed JSON body throws inside express.json, and that 400 must
// still carry CORS headers (set below) so the browser can read it instead of a bare network error.
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : null;
  const origin = req.headers.origin;
  if (!allowed) {
    res.header('Access-Control-Allow-Origin', '*'); // dev only; prod requires ALLOWED_ORIGINS (boot-check above)
  } else if (origin && allowed.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Expose-Headers', 'X-Total-Count'); // let the browser READ the pagination total cross-origin
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' })); // cap payloads (transcripts fit well under 1mb); after CORS

// Rate limits: a general cap + stricter caps on the abuse-prone endpoints (auth + the costly guest AI).
const limit = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
app.use(limit(60_000, 300, 'Too many requests — slow down.'));            // general: 300/min/IP
app.use('/auth/login', limit(60_000, 10, 'Too many login attempts — wait a minute.'));
// (request-access + signup/* limiters removed with those flows — the routes are 404 stubs now;
// Supabase's own otp/email rate limits remain the per-email guard — see docs/AUTH-SETUP.md.)
app.use('/auth/forgot-password', limit(60 * 60_000, 5, 'Too many reset requests — try again later.'));
app.use('/auth/invite', limit(60_000, 12, 'Too many invite attempts — slow down.'));
// /start mints a free, unauthenticated session (each grants paid Claude turns), so cap session
// creation harder than messaging — the in-memory aggregate ceiling (lib/guest.js) is the global bound.
app.use('/guest/start', limit(60_000, 6, 'Too many guest sessions — slow down.'));
app.use('/guest', limit(60_000, 15, 'Guest limit reached — slow down.'));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', require('./routes/auth'));
app.use('/guest', require('./routes/guest')); // ephemeral guest mode (no auth, no persistence)
app.use('/ples/folders', require('./routes/folders')); // before /ples so "folders" isn't read as :id
app.use('/ples', require('./routes/ples'));
// ORDER LOAD-BEARING: admin.js must mount before superadmin.js — superadmin.js opens with a
// router-level requireRole('superadmin') that 403s and ENDS every admin-role request, and
// admin.js's GET /users intentionally shadows the same path (dual-role, council-scoped).
app.use('/admin', require('./routes/admin'));
app.use('/auditor', require('./routes/auditor'));
app.use('/admin', require('./routes/superadmin'));

// JSON 404 + terminal error handler — keep every response JSON (a malformed body or an unmatched
// route used to return Express's default HTML, which the cross-origin clients can't parse).
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature to treat this as an error handler
app.use((err, req, res, _next) => {
  const status = err.type === 'entity.parse.failed' || err.status === 400 ? 400 : 500;
  if (status === 500) console.error('[error]', err.message);
  res.status(status).json({ error: status === 400 ? 'Invalid request body' : (IS_PROD ? 'Internal server error' : err.message) });
});

// Scheduled reconcile sweep (soak finding F1): sessions stranded at cle_pass with no AI evaluation
// silently lose credit, and recovery was manual-only. Re-run the sweep every RECONCILE_INTERVAL_MS
// (default 6h; 0/negative disables). First run lands one interval after boot, and a sweep still in
// flight makes the next tick skip rather than overlap.
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || `${6 * 60 * 60_000}`, 10);
if (process.env.NODE_ENV !== 'test' && RECONCILE_INTERVAL_MS > 0) {
  const { reconcileEvaluations } = require('./services/reconcile');
  let sweeping = false;
  setInterval(async () => {
    if (sweeping) return console.log('[reconcile] previous sweep still in flight — skipping this run');
    sweeping = true;
    try {
      const { stuck, recovered, repaired, failed } = await reconcileEvaluations();
      console.log(`[reconcile] swept ${stuck} cle_pass session(s): recovered=${recovered} repaired=${repaired} failed=${failed}`);
    } catch (err) {
      console.error(`[reconcile] sweep failed: ${err.message}`);
    } finally {
      sweeping = false;
    }
  }, RECONCILE_INTERVAL_MS).unref(); // unref: the timer alone must not keep a script that imports `app` alive
}

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  const server = app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
  // Graceful shutdown: on a Railway redeploy, drain in-flight requests (a chat turn can run up to
  // ~100s and the Anthropic cost is already incurred) instead of killing them mid-write. Hard-exit
  // after a grace window so a stuck connection can't block the deploy forever.
  const shutdown = (sig) => {
    console.log(`${sig} received — draining connections`);
    server.close(() => { console.log('drained — exiting'); process.exit(0); });
    setTimeout(() => { console.error('drain timed out — forcing exit'); process.exit(1); }, 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
