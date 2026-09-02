const { Router } = require('express');
const { z } = require('zod');
const { callAI } = require('../services/ai');
const { PIS7_EVALUATOR_PROMPT } = require('../lib/prompts');
const { scoreFromText } = require('../lib/pis7');
const { flattenForPrompt } = require('../lib/transcript');
const { buildProvenance } = require('../lib/provenance');
const { deriveHintTokens } = require('../services/pii-filter');
const { modelVersion, PROMPT_VERSION, RUBRIC_VERSION } = require('../lib/versions');
const { fireShadowEvaluation } = require('../services/shadow');
const { requestSignal } = require('../lib/request-signal');
const { sendAiError, logAiError, isQueueFull } = require('../lib/ai-errors');

const router = Router();

// The evaluator's decoding parameters, in ONE place. §10.2 requires them frozen and recorded, and
// the only way the recorded value cannot drift from the value sent is for both to read this.
// temperature 0: the scoring instrument must be reproducible, and a sampled score is not.
const EVAL_DECODING = { temperature: 0, maxTokens: 4096 };

const EvalSchema = z.object({
  ple_id: z.string(),
  transcript: z.array(z.object({ role: z.string(), content: z.string() })),
  // On-prem patient identifier, scrubbed from the transcript before the cloud eval; never forwarded.
  // nullish: the backend sends `?? null` when none was recorded — null must pass schema validation.
  patient_ref: z.string().nullish(),
  // The DECLARED weights checksum from the Model Lock Record, forwarded by the backend from
  // app_settings. Absent = the evaluator is not locked yet, which the score then says on its face.
  weights_sha256: z.string().trim().max(128).nullish(),
  // Opt OUT of the shadow evaluation. Default true (shadow runs when SHADOW_EVAL_PROVIDER is set).
  // scripts/calibration/calibrate.js sets this false: --mode rescore re-scores the REAL cohort
  // through this route, which would otherwise overwrite the pilot's accumulated shadow rows with
  // rows from a calibration run — destroying the very corpus the harness exists to measure.
  shadow: z.boolean().default(true),
});

router.post('/', async (req, res) => {
  const parsed = EvalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ple_id, transcript, patient_ref, shadow, weights_sha256 } = parsed.data;
  // PII-strip (incl. the known patient identifier) + defang injected role markers before the cloud model.
  const transcriptText = flattenForPrompt(transcript, deriveHintTokens(patient_ref));
  // Fires if the backend hangs up (its evaluation deadline): the queued or in-flight scoring call is
  // released, so the backend's retry does not stack a duplicate behind a call nobody will read.
  const signal = requestSignal(req, res);

  try {
    const { text, inputTokens, outputTokens, stopReason, provider, model } = await callAI({
      purpose: 'evaluate',
      systemPrompt: PIS7_EVALUATOR_PROMPT,
      messages: [{ role: 'user', content: `TRANSCRIPT:\n${transcriptText}` }],
      signal,
      // 4096, not 2000/3000: a 130k-token transcript (PLE-052, 2026-08-17) truncated the model's
      // JSON mid-rationale at BOTH 2000 and 3000 — the response never reached the closing `}`, so
      // parseJsonObject's "no match" fallback silently returned {} instead of surfacing a parse
      // error, and Zod flagged it as out-of-range/missing domain scores. Same failure mode as the
      // earlier 1000→2000 bump (calibration: 1000 truncates on ~46k-token transcripts), recurring
      // twice at larger sizes — the evidence-threshold rule (quote a physician utterance for any
      // 4-5) makes rationale length scale with how much of the transcript is genuinely quotable,
      // not just token count, and two undersized guesses in a row means give real headroom instead
      // of incrementing again. max_tokens is a ceiling, not a spend — an unused allowance costs $0.
      maxTokens: EVAL_DECODING.maxTokens,
      temperature: EVAL_DECODING.temperature,
    });

    // stopReason 'max_tokens' = genuinely truncated (needs a bigger ceiling); 'end_turn' = the model
    // finished on its own without ever producing the expected JSON (a compliance/content problem,
    // not a length problem — raising maxTokens further would not fix this one).
    const diag = () => `stopReason=${stopReason} outputTokens=${outputTokens} textLen=${text.length} ` +
      `text=${JSON.stringify(text.length > 1500 ? text.slice(0, 800) + ' …[snip]… ' + text.slice(-700) : text)}`;

    // Shared with the shadow evaluator (lib/pis7.js) so both apply the SAME contract — a divergence
    // would make the November head-to-head compare two models under two different validators.
    let scored;
    try {
      scored = scoreFromText(text);
    } catch (e) {
      if (e.kind === 'invalid_json') {
        console.error(`[RIMPL evaluate] invalid JSON — ${diag()}`);
      } else {
        console.error(`[RIMPL evaluate] out-of-range/missing domain scores: ${JSON.stringify(e.parsed).slice(0, 300)} — ${diag()}`);
      }
      // Shadow the FAILURES too. These are the long/hard transcripts (PLE-052 truncated the served
      // model's JSON at 2000 AND 3000 max_tokens), and they are exactly where a candidate with a
      // smaller context window is most likely to fail. Firing only on success would measure the
      // candidate's contract-compliance on a denominator that excludes them — a sample restricted
      // to what a stronger model already handled, biased in the candidate's favour.
      if (shadow) fireShadowEvaluation({ pleId: ple_id, transcriptText, servedProvider: provider });
      return res.status(502).json({ error: e.message });
    }
    const { scores, composite, rationale } = scored;

    res.json({
      ple_id,
      d1: scores.d1, d2: scores.d2, d3: scores.d3, d4: scores.d4,
      d5: scores.d5, d6: scores.d6, d7: scores.d7,
      composite_score: composite,
      domain_rationale: rationale,
      // Locked-version provenance (§10.2): recorded per evaluation for the reliability/stability check.
      // Stamped from the model that ACTUALLY produced this score, not a module constant — under a
      // hybrid or a shadow run the two diverge, and §10.2 requires the row to name the real system.
      model_version: modelVersion(model),
      prompt_version: PROMPT_VERSION,
      rubric_version: RUBRIC_VERSION,
      // §10.2 / Model Lock Record: the full configuration that produced THIS score, including the
      // decoding parameters actually sent and a fingerprint over the whole set. Two scores with
      // different fingerprints did not come from the same locked configuration — which is the
      // question the lock exists to make answerable from the data rather than from memory.
      provenance: buildProvenance({
        provider, model,
        promptVersion: PROMPT_VERSION, rubricVersion: RUBRIC_VERSION,
        temperature: EVAL_DECODING.temperature, maxTokens: EVAL_DECODING.maxTokens,
        weightsSha256: weights_sha256 ?? null,
      }),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      provider,
    });

    // AFTER the response: score the same transcript again with the candidate model and record it
    // where nobody can see it. Default OFF (SHADOW_EVAL_PROVIDER unset). Deliberately not awaited —
    // it must never delay, fail, or bill the served evaluation. Reuses the already de-identified
    // transcriptText, so it opens no new PII surface. See docs/LOCAL-MODEL-ROADMAP.md Phase 5.
    if (shadow) fireShadowEvaluation({ pleId: ple_id, transcriptText, servedProvider: provider });
  } catch (err) {
    logAiError('[RIMPL evaluate]', err);
    // Same reasoning as the 502 path: a transcript the served provider could not complete at all is
    // a data point about the candidate too. transcriptText is de-identified and in scope here.
    // Except a full queue — that says nothing about the transcript, and would only offer a second
    // call to a box that just refused the first.
    if (parsed.data.shadow && !isQueueFull(err)) fireShadowEvaluation({ pleId: parsed.data.ple_id, transcriptText });
    // 503 queue_full (+ Retry-After) / 499 client gone / 413 transcript_too_large / else this 500.
    sendAiError(res, err, 'Evaluation service temporarily unavailable.');
  }
});

module.exports = router;
