const express = require('express');
const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ieti-agents-deepseek-proxy' });
});

module.exports = router;
