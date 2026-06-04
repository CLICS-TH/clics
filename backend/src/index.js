require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : null;
  const origin = req.headers.origin;
  if (!allowed) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', require('./routes/auth'));
app.use('/ples', require('./routes/ples'));
app.use('/admin', require('./routes/admin'));
app.use('/auditor', require('./routes/auditor'));
app.use('/admin', require('./routes/superadmin'));

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}

module.exports = app;
