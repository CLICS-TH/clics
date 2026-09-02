const { Router } = require('express');
const { z } = require('zod');
const { callAI } = require('../services/ai');
const { CRITERIA_CLASSIFIER_PROMPT } = require('../lib/prompts');
const { parseJsonObject } = require('../lib/parse');
const { flattenForPrompt } = require('../lib/transcript');
const { deriveHintTokens, makeRegistry } = require('../services/pii-filter');
const { requestSignal } = require('../lib/request-signal');
const { sendAiError, logAiError } = require('../lib/ai-errors');

const router = Router();

const Schema = z.object({
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
  // On-prem patient identifier, scrubbed from the transcript before the cloud call; never forwarded.
  // nullish: the backend sends `?? null` when none was recorded — null must pass schema validation.
  patient_ref: z.string().nullish(),
});

router.post('/', async (req, res) => {
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // PII-strip (incl. the known patient identifier) + defang injected role markers before the cloud model.
  // The shared registry also yields the token→raw reverse map (pii_map) for the on-prem reversible
  // store — built on-prem from the de-id input, so it carries no info the cloud model ever saw.
  const registry = makeRegistry();
  const transcriptText = flattenForPrompt(parsed.data.transcript, deriveHintTokens(parsed.data.patient_ref), registry);
  // This call is synchronous on the physician's /end: if the backend's deadline hangs up first, the
  // queued or in-flight classifier call is released rather than left to finish for nobody.
  const signal = requestSignal(req, res);

  try {
    const { text, inputTokens, outputTokens, provider, model } = await callAI({
      purpose: 'criteria',
      systemPrompt: CRITERIA_CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      maxTokens: 200,
      signal,
    });

    let result;
    try {
      result = parseJsonObject(text);
    } catch {
      return res.status(502).json({ error: 'Classifier returned invalid JSON' });
    }

    // pii_map: the on-prem reversible token→raw map. Backend encrypts + persists it; NEVER stored
    // plaintext, never returned to a client, never sent to the cloud.
    // c7 (context/evidence integration) and on_topic are additive — see CRITERIA_CLASSIFIER_PROMPT.
    // The backend's tier-2 gate reads c4..c6 today and starts reading c7 with the CREC PLE-gate
    // change; returning it early is harmless and means the two can ship independently.
    res.json({ c4: !!result.c4, c5: !!result.c5, c6: !!result.c6, c7: !!result.c7,
      on_topic: result.on_topic !== false,
      pii_map: registry.entries(), input_tokens: inputTokens, output_tokens: outputTokens, provider, model });
  } catch (err) {
    logAiError('[RIMPL evaluate-criteria]', err);
    // 503 queue_full (+ Retry-After) / 499 client gone / 413 transcript_too_large / else this 500.
    sendAiError(res, err, 'Criteria evaluation service temporarily unavailable.');
  }
});

module.exports = router;
