require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Guard all routes except /health with shared-secret check
app.use((req, res, next) => {
  const token = process.env.INTERNAL_TOKEN;
  if (token && req.headers['x-internal-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.use('/chat', require('./routes/chat'));
app.use('/evaluate', require('./routes/evaluate'));
app.use('/evaluate-criteria', require('./routes/evaluate-criteria'));

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, () => console.log(`RIMPL running on port ${PORT}`));
}

module.exports = app;
