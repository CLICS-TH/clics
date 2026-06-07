require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Fail closed in production: the encrypted identity vault, signed guest tokens, RIMPL shared secret,
// and locked CORS all depend on these. Refuse to start without them rather than degrade silently.
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
if (IS_PROD) {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'INTERNAL_TOKEN', 'GUEST_TOKEN_SECRET', 'IDENTITY_ENC_KEY', 'ALLOWED_ORIGINS'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Refusing to start in production — missing env: ${missing.join(', ')}`);
}

const app = express();
app.set('trust proxy', 1); // behind Railway's proxy — required for correct per-IP rate limiting
app.use(helmet());
app.use(express.json({ limit: '1mb' })); // cap payloads (transcripts fit well under 1mb)
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
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limits: a general cap + stricter caps on the abuse-prone endpoints (auth + the costly guest AI).
const limit = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
app.use(limit(60_000, 300, 'Too many requests — slow down.'));            // general: 300/min/IP
app.use('/auth/login', limit(60_000, 10, 'Too many login attempts — wait a minute.'));
app.use('/auth/request-access', limit(60 * 60_000, 5, 'Too many access requests — try again later.'));
app.use('/guest', limit(60_000, 15, 'Guest limit reached — slow down.'));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', require('./routes/auth'));
app.use('/guest', require('./routes/guest')); // ephemeral guest mode (no auth, no persistence)
app.use('/ples/folders', require('./routes/folders')); // before /ples so "folders" isn't read as :id
app.use('/ples', require('./routes/ples'));
app.use('/admin', require('./routes/admin'));
app.use('/auditor', require('./routes/auditor'));
app.use('/admin', require('./routes/superadmin'));

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}

module.exports = app;
