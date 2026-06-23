require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
// Deep readiness (mounted before the token gate so monitors reach /health/deep unauthenticated).
app.use('/health', require('./routes/health'));

// In production the shared-secret MUST be configured — otherwise the middleware
// would be callable unauthenticated. Fail closed at boot rather than silently open.
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
if (IS_PROD && !INTERNAL_TOKEN) {
  throw new Error('INTERNAL_TOKEN is required in production (RIMPL refuses to start unauthenticated)');
}

// Guard all routes except /health with shared-secret check.
// Only local dev (no token set, not prod) is allowed to skip the check.
app.use((req, res, next) => {
  if (!INTERNAL_TOKEN) return next();
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.use('/chat', require('./routes/chat'));
app.use('/evaluate', require('./routes/evaluate'));
app.use('/evaluate-criteria', require('./routes/evaluate-criteria'));
app.use('/audit-discuss', require('./routes/audit-discuss'));

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, () => console.log(`RIMPL running on port ${PORT}`));
}

module.exports = app;
