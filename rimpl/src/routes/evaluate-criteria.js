const { Router } = require('express');
const { z } = require('zod');
const { callClaude } = require('../services/claude');
const { CRITERIA_CLASSIFIER_PROMPT } = require('../lib/prompts');
const { parseJsonObject } = require('../lib/parse');
const { flattenForPrompt } = require('../lib/transcript');
const { deriveHintTokens } = require('../services/pii-filter');

const router = Router();

const Schema = z.object({
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
  // On-prem patient identifier, scrubbed from the transcript before the cloud call; never forwarded.
  patient_ref: z.string().optional(),
});

router.post('/', async (req, res) => {
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // PII-strip (incl. the known patient identifier) + defang injected role markers before the cloud model.
  const transcriptText = flattenForPrompt(parsed.data.transcript, deriveHintTokens(parsed.data.patient_ref));

  try {
    const { text, inputTokens, outputTokens } = await callClaude({
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

    res.json({ c4: !!result.c4, c5: !!result.c5, c6: !!result.c6, input_tokens: inputTokens, output_tokens: outputTokens });
  } catch (err) {
    console.error('[RIMPL evaluate-criteria] error:', err);
    res.status(500).json({ error: 'Criteria evaluation service temporarily unavailable.' });
  }
});

module.exports = router;
