const { Router } = require('express');
const { z } = require('zod');
const { callClaude } = require('../services/claude');
const { PIS7_EVALUATOR_PROMPT } = require('../lib/prompts');
const { parseJsonObject } = require('../lib/parse');
const { stripHistoryPii } = require('../services/pii-filter');

const router = Router();

const WEIGHTS = { d1: 0.15, d2: 0.20, d3: 0.15, d4: 0.15, d5: 0.15, d6: 0.10, d7: 0.10 };

const EvalSchema = z.object({
  ple_id: z.string(),
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
});

router.post('/', async (req, res) => {
  const parsed = EvalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ple_id, transcript } = parsed.data;
  // Defense-in-depth: strip PII before the transcript reaches the cloud model (mirrors /chat).
  const transcriptText = stripHistoryPii(transcript)
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  try {
    const { text, inputTokens, outputTokens } = await callClaude({
      systemPrompt: PIS7_EVALUATOR_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      maxTokens: 1000,
    });

    let scores;
    try {
      scores = parseJsonObject(text);
    } catch {
      return res.status(502).json({ error: 'Evaluator returned invalid JSON' });
    }

    // ×20 gives 0-100 range: max = 5 × 1.0 × 20 = 100
    const composite = Object.entries(WEIGHTS).reduce(
      (acc, [key, w]) => acc + (scores[key] ?? 0) * w, 0
    ) * 20;

    res.json({
      ple_id,
      d1: scores.d1, d2: scores.d2, d3: scores.d3, d4: scores.d4,
      d5: scores.d5, d6: scores.d6, d7: scores.d7,
      composite_score: Math.round(composite * 100) / 100,
      domain_rationale: scores.rationale ?? {},
      model_version: 'CCME_LLM_v8.0',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  } catch (err) {
    console.error('[RIMPL evaluate] error:', err);
    res.status(500).json({ error: 'Evaluation service temporarily unavailable.' });
  }
});

module.exports = router;
