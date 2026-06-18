const { Router } = require('express');
const { z } = require('zod');
const { callClaude } = require('../services/claude');
const { PIS7_EVALUATOR_PROMPT } = require('../lib/prompts');
const { parseJsonObject } = require('../lib/parse');
const { flattenForPrompt } = require('../lib/transcript');
const { deriveHintTokens } = require('../services/pii-filter');
const { WEIGHTS, MODEL_VERSION, PROMPT_VERSION, RUBRIC_VERSION } = require('../lib/versions');

const router = Router();

const EvalSchema = z.object({
  cle_id: z.string(),
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
  // On-prem patient identifier, scrubbed from the transcript before the cloud eval; never forwarded.
  patient_ref: z.string().optional(),
});

// The evaluator's d1..d7 drive CME credit and are persisted into smallint CHECK(0..5) columns
// downstream. Validate the model's parsed output HERE so a malformed/out-of-range/NaN score fails
// fast (502) instead of poisoning the composite or throwing a CHECK violation in persistEvaluation
// that the 6h reconcile sweep then retries forever (a paid call each time).
const DOMAIN_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const DomainScoresSchema = z.object(
  Object.fromEntries(DOMAIN_KEYS.map(k => [k, z.number().int().min(0).max(5)]))
).passthrough();

router.post('/', async (req, res) => {
  const parsed = EvalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { cle_id, transcript, patient_ref } = parsed.data;
  // PII-strip (incl. the known patient identifier) + defang injected role markers before the cloud model.
  const transcriptText = flattenForPrompt(transcript, deriveHintTokens(patient_ref));

  try {
    const { text, inputTokens, outputTokens } = await callClaude({
      systemPrompt: PIS7_EVALUATOR_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      // 2000, not 1000: calibration showed 1000 truncates rationales on ~46k-token transcripts → malformed evals.
      maxTokens: 2000,
    });

    let parsedScores;
    try {
      parsedScores = parseJsonObject(text);
    } catch {
      return res.status(502).json({ error: 'Evaluator returned invalid JSON' });
    }

    const checked = DomainScoresSchema.safeParse(parsedScores);
    if (!checked.success) {
      console.error('[RIMPL evaluate] out-of-range/missing domain scores:', JSON.stringify(parsedScores).slice(0, 300));
      return res.status(502).json({ error: 'Evaluator returned out-of-range or missing domain scores' });
    }
    const scores = checked.data;

    // ×20 gives 0-100 range: max = 5 × 1.0 × 20 = 100
    const composite = Object.entries(WEIGHTS).reduce(
      (acc, [key, w]) => acc + scores[key] * w, 0
    ) * 20;

    res.json({
      cle_id,
      d1: scores.d1, d2: scores.d2, d3: scores.d3, d4: scores.d4,
      d5: scores.d5, d6: scores.d6, d7: scores.d7,
      composite_score: Math.round(composite * 100) / 100,
      domain_rationale: scores.rationale ?? {},
      // Locked-version provenance (§10.2): recorded per evaluation for the reliability/stability check.
      model_version: MODEL_VERSION,
      prompt_version: PROMPT_VERSION,
      rubric_version: RUBRIC_VERSION,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  } catch (err) {
    console.error('[RIMPL evaluate] error:', err);
    res.status(500).json({ error: 'Evaluation service temporarily unavailable.' });
  }
});

module.exports = router;
