const { Router } = require('express');
const { z } = require('zod');
const { callClaude } = require('../services/claude');
const { CRITERIA_CLASSIFIER_PROMPT } = require('../lib/prompts');
const { parseJsonObject } = require('../lib/parse');
const { stripHistoryPii } = require('../services/pii-filter');

const router = Router();

const Schema = z.object({
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
});

router.post('/', async (req, res) => {
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Defense-in-depth: strip PII before the transcript reaches the cloud model (mirrors /chat).
  const transcriptText = stripHistoryPii(parsed.data.transcript)
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  try {
    const { text } = await callClaude({
      systemPrompt: CRITERIA_CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      maxTokens: 200,
    });

    let result;
    try {
      result = parseJsonObject(text);
    } catch {
      return res.status(502).json({ error: 'Classifier returned invalid JSON' });
    }

    res.json({ c4: !!result.c4, c5: !!result.c5, c6: !!result.c6 });
  } catch (err) {
    console.error('[RIMPL evaluate-criteria] error:', err);
    res.status(500).json({ error: 'Criteria evaluation service temporarily unavailable.' });
  }
});

module.exports = router;
