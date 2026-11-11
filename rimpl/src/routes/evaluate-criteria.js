const { Router } = require('express');
const { z } = require('zod');
const { callAI } = require('../services/ai');
const { CRITERIA_CLASSIFIER_PROMPT } = require('../lib/prompts');
const { parseJsonObject } = require('../lib/parse');
const { flattenForPrompt, seedWithChiefComplaint } = require('../lib/transcript');
const { deriveHintTokens, makeRegistry } = require('../services/pii-filter');
const { MAX_TURN_CHARS } = require('../lib/turn-limits');
const { CRITERIA_DECODING } = require('../lib/decoding');
const { requestSignal } = require('../lib/request-signal');
const { sendAiError, logAiError } = require('../lib/ai-errors');

const router = Router();
const CRITERIA_KEYS = ['c4', 'c5', 'c6', 'c7'];

const Schema = z.object({
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
  // On-prem patient identifier, scrubbed from the transcript before the cloud call; never forwarded.
  // nullish: the backend sends `?? null` when none was recorded — null must pass schema validation.
  patient_ref: z.string().nullish(),
  // Seeds the token registry first and is NEVER sent to the model (lib/transcript.js
  // seedWithChiefComplaint), so the pii_map below numbers tokens exactly as /chat, /evaluate and the
  // auditor's view do. The map then also holds the chief complaint's own entries, which is what makes
  // it the reverse of those tokens.
  chief_complaint: z.string().max(MAX_TURN_CHARS).nullish(),
});

router.post('/', async (req, res) => {
  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // PII-strip (incl. the known patient identifier) + defang injected role markers before the cloud model.
  // The shared registry also yields the token→raw reverse map (pii_map) for the on-prem reversible
  // store — built on-prem from the de-id input, so it carries no info the cloud model ever saw.
  // Inside the try: a de-identification failure answers 500 (fail closed) instead of escaping as an
  // unhandled rejection that would exit the process.
  const registry = makeRegistry();
  // This call is synchronous on the physician's /end: if the backend's deadline hangs up first, the
  // queued or in-flight classifier call is released rather than left to finish for nobody.
  const signal = requestSignal(req, res);

  try {
    const hints = deriveHintTokens(parsed.data.patient_ref);
    seedWithChiefComplaint(registry, parsed.data.chief_complaint, hints);
    const transcriptText = flattenForPrompt(parsed.data.transcript, hints, registry);
    const { text, inputTokens, outputTokens, provider, model } = await callAI({
      purpose: 'criteria',
      systemPrompt: CRITERIA_CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      maxTokens: CRITERIA_DECODING.maxTokens,   // 200: one small JSON object (lib/decoding.js)
      temperature: CRITERIA_DECODING.temperature,   // null: not sent, the provider default
      signal,
    });

    let result;
    try {
      result = parseJsonObject(text);
    } catch {
      return res.status(502).json({ error: 'Classifier returned invalid JSON' });
    }
    // parseJsonObject answers {} for prose or a reply cut off before its closing brace, and `!!undefined`
    // would turn that into every criterion false: a silent tier-2 fail. Only a verdict that names all four
    // criteria as booleans is one.
    if (!CRITERIA_KEYS.every((k) => typeof result?.[k] === 'boolean')) {
      return res.status(502).json({ error: 'Classifier returned invalid JSON' });
    }

    // pii_map: the on-prem reversible token→raw map. Backend encrypts + persists it; NEVER stored
    // plaintext, never returned to a client, never sent to the cloud.
    // c7 (context/evidence integration) and on_topic are additive — see CRITERIA_CLASSIFIER_PROMPT.
    // The backend's tier-2 gate reads c4..c6 today and starts reading c7 with the CREC PLE-gate
    // change; returning it early is harmless and means the two can ship independently.
    res.json({ c4: result.c4, c5: result.c5, c6: result.c6, c7: result.c7,
      on_topic: result.on_topic !== false,
      pii_map: registry.entries(), input_tokens: inputTokens, output_tokens: outputTokens, provider, model });
  } catch (err) {
    logAiError('[RIMPL evaluate-criteria]', err);
    // 503 queue_full (+ Retry-After) / 499 client gone / 413 transcript_too_large / else this 500.
    sendAiError(res, err, 'Criteria evaluation service temporarily unavailable.');
  }
});

module.exports = router;
