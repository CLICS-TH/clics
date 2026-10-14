require('dotenv').config();
const express = require('express');
const { internalAuth } = require('./lib/internal-auth');

const app = express();
// 2mb, not express.json()'s 100kb default: /chat resends the WHOLE history every turn and /evaluate
// sends the whole transcript, so a long PLE would be refused at the door with a bare 413 before any
// route — or any de-identification — ran. Sized above the transcript cap with headroom.
app.use(express.json({ limit: process.env.RIMPL_BODY_LIMIT || '2mb' }));

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

// Guard all routes except /health with the shared-secret check.
// Only local dev (no token set, not prod) is allowed to skip it — see lib/internal-auth.js.
app.use(internalAuth);

app.use('/chat', require('./routes/chat'));
app.use('/evaluate', require('./routes/evaluate'));
app.use('/evaluate-criteria', require('./routes/evaluate-criteria'));
app.use('/audit-discuss', require('./routes/audit-discuss'));
// Masked copy of a stored transcript for a human reader (the auditor). No AI call.
app.use('/deidentify', require('./routes/deidentify'));

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, () => console.log(`RIMPL running on port ${PORT}`));
}

module.exports = app;
