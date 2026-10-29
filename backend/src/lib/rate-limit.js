const rateLimit = require('express-rate-limit');

const limit = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });

module.exports = { limit };
