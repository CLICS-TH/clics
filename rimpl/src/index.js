require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/chat', require('./routes/chat'));
app.use('/evaluate', require('./routes/evaluate'));
app.use('/evaluate-criteria', require('./routes/evaluate-criteria'));

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  app.listen(PORT, () => console.log(`RIMPL running on port ${PORT}`));
}

module.exports = app;
