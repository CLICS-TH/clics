const { Router } = require('express');
const router = Router();
router.post('/', (_req, res) => res.status(501).json({ error: 'Not implemented yet' }));
module.exports = router;
