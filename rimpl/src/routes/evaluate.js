const { Router } = require('express');
const { z } = require('zod');
const { callAI } = require('../services/ai');
const { PIS7_EVALUATOR_PROMPT } = require('../lib/prompts');
const { parseJsonObject } = require('../lib/parse');
const { flattenForPrompt } = require('../lib/transcript');
const { deriveHintTokens } = require('../services/pii-filter');
const { WEIGHTS, modelVersion, PROMPT_VERSION, RUBRIC_VERSION } = require('../lib/versions');

const router = Router();

const EvalSchema = z.object({
  cle_id: z.string(),
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
  // On-prem patient identifier, scrubbed from the transcript before the cloud eval; never forwarded.
  // nullish: the backend sends `?? null` when none was recorded — null must pass schema validation.
  patient_ref: z.string().nullish(),
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
    const { text, inputTokens, outputTokens, stopReason, provider, model } = await callAI({
      purpose: 'evaluate',
      systemPrompt: PIS7_EVALUATOR_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      // 4096, not 2000/3000: a 130k-token transcript (CLE-052, 2026-08-17) truncated the model's
      // JSON mid-rationale at BOTH 2000 and 3000 — the response never reached the closing `}`, so
      // parseJsonObject's "no match" fallback silently returned {} instead of surfacing a parse
      // error, and Zod flagged it as out-of-range/missing domain scores. Same failure mode as the
      // earlier 1000→2000 bump (calibration: 1000 truncates on ~46k-token transcripts), recurring
      // twice at larger sizes — the evidence-threshold rule (quote a physician utterance for any
      // 4-5) makes rationale length scale with how much of the transcript is genuinely quotable,
      // not just token count, and two undersized guesses in a row means give real headroom instead
      // of incrementing again. max_tokens is a ceiling, not a spend — an unused allowance costs $0.
      maxTokens: 4096,
    });

    // stopReason 'max_tokens' = genuinely truncated (needs a bigger ceiling); 'end_turn' = the model
    // finished on its own without ever producing the expected JSON (a compliance/content problem,
    // not a length problem — raising maxTokens further would not fix this one).
    const diag = () => `stopReason=${stopReason} outputTokens=${outputTokens} textLen=${text.length} ` +
      `text=${JSON.stringify(text.length > 1500 ? text.slice(0, 800) + ' …[snip]… ' + text.slice(-700) : text)}`;

    let parsedScores;
    try {
      parsedScores = parseJsonObject(text);
    } catch {
      console.error(`[RIMPL evaluate] invalid JSON — ${diag()}`);
      return res.status(502).json({ error: 'Evaluator returned invalid JSON' });
    }

    const checked = DomainScoresSchema.safeParse(parsedScores);
    if (!checked.success) {
      // {} here means the regex found no {...} at all in `text` (parseJsonObject's no-match
      // fallback) — could be truncation (stopReason=max_tokens) or the model never attempting
      // JSON at all (stopReason=end_turn) — diag() tells them apart.
      console.error(`[RIMPL evaluate] out-of-range/missing domain scores: ${JSON.stringify(parsedScores).slice(0, 300)} — ${diag()}`);
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
      // Stamped from the model that ACTUALLY produced this score, not a module constant — under a
      // hybrid or a shadow run the two diverge, and §10.2 requires the row to name the real system.
      model_version: modelVersion(model),
      prompt_version: PROMPT_VERSION,
      rubric_version: RUBRIC_VERSION,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      provider,
    });
  } catch (err) {
    console.error('[RIMPL evaluate] error:', err);
    res.status(500).json({ error: 'Evaluation service temporarily unavailable.' });
  }
});

module.exports = router;
