const { Router } = require('express');
const { z } = require('zod');
const { callAI, resolveProviderName } = require('../services/ai');
const { pis7PromptFor } = require('../lib/prompts');
const { Pis7ScoreError } = require('../lib/pis7');
const { scoreWithConsistency, MODES: CONSISTENCY_MODES } = require('../services/consistency');
const { flattenForPrompt } = require('../lib/transcript');
const { buildProvenance } = require('../lib/provenance');
const { deriveHintTokens } = require('../services/pii-filter');
const { modelVersion, promptVersionFor, RUBRIC_VERSION } = require('../lib/versions');
const { fireShadowEvaluation } = require('../services/shadow');
const { requestSignal } = require('../lib/request-signal');
const { sendAiError, logAiError, isQueueFull } = require('../lib/ai-errors');

const router = Router();

// The evaluator's REQUESTED decoding parameters, in ONE place. §10.2 requires them frozen and recorded.
// temperature 0: the scoring instrument must be reproducible, and a sampled score is not.
// What is RECORDED is what the provider reports it actually sent (`decoding` on the call result), not
// this object: claude-sonnet-5-5 rejects a non-default temperature with a 400, so the anthropic
// provider does not send it and provenance must read null there. The local provider sends 0 as asked.
const EVAL_DECODING = { temperature: 0, maxTokens: 4096 };

// Self-consistency (services/consistency.js; docs/LOCAL-MODEL-ROADMAP.md D18 / D21) — for the LOCAL
// arm only. EVAL_CONSISTENCY: off (default) | adaptive (two calls, a third when the pair disagrees) |
// median3 (always three). The incumbent (anthropic) path is unchanged whatever the env says, so its
// response stays byte-identical to before this existed. An unknown value is off.
const consistencyModeFor = (provider) => {
  const mode = String(process.env.EVAL_CONSISTENCY || '').trim().toLowerCase();
  return provider === 'local' && CONSISTENCY_MODES.includes(mode) ? mode : 'off';
};
// Σ|Δ| ceiling for the adaptive pair to count as agreeing (0 = the per-domain check alone). A uniform
// ±1 level shift across 5–6 domains passes the per-domain check with Σ|Δ| = 5–6, and the D18
// repeatability bar is Σ|Δ| median ≤ 2 — see services/consistency.js DEFAULT_AGREE.
function maxSumDelta() {
  const n = parseInt(process.env.EVAL_CONSISTENCY_MAX_SUM_DELTA, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
// Re-asks allowed across one adaptive / median3 evaluation when the model returns unparseable /
// out-of-range JSON. Not applied to the incumbent path: a re-ask there would be a new cloud-spend
// path on the instrument the pilot is locked to, and it has had none.
function jsonRetries() {
  const n = parseInt(process.env.EVAL_JSON_RETRIES, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

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
  // Assigned INSIDE the try below: a de-identification failure must answer 500 (fail closed, nothing
  // sent anywhere), never escape as an unhandled rejection that takes the whole process down.
  let transcriptText = null;
  // Fires if the backend hangs up (its evaluation deadline): the queued or in-flight scoring call is
  // released, so the backend's retry does not stack a duplicate behind a call nobody will read.
  const signal = requestSignal(req, res);

  // Resolved FIRST, then pinned into every call of this evaluation (same precedent as routes/chat.js's
  // citation retry). The prompt and the scoring rule are chosen from the provider, so a superadmin
  // flipping the toggle mid-run must not have one provider's prompt scored by another — nor a second
  // consistency call answered by a different model than the first.
  let provider = null;
  try {
    transcriptText = flattenForPrompt(transcript, deriveHintTokens(patient_ref));
    provider = await resolveProviderName('evaluate');
    const mode = consistencyModeFor(provider);
    const systemPrompt = pis7PromptFor(provider);
    const promptVersion = promptVersionFor(provider);

    // The raw replies, kept for the 502 diagnostics (first = the billed call, last = the one that
    // failed to parse). services/consistency.js itself carries no model text.
    let first = null;
    let last = null;
    const callOnce = async () => {
      last = await callAI({
        purpose: 'evaluate',
        provider,
        systemPrompt,
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
      first ??= last;
      return last;
    };

    // stopReason 'max_tokens' = genuinely truncated (needs a bigger ceiling); 'end_turn' = the model
    // finished on its own without ever producing the expected JSON (a compliance/content problem,
    // not a length problem — raising maxTokens further would not fix this one).
    const diag = () => {
      if (!last) return 'no model reply';
      const text = String(last.text ?? '');
      return `stopReason=${last.stopReason} outputTokens=${last.outputTokens} textLen=${text.length} ` +
        `text=${JSON.stringify(text.length > 1500 ? text.slice(0, 800) + ' …[snip]… ' + text.slice(-700) : text)}`;
    };

    // Shared with the shadow evaluator (lib/pis7.js via services/consistency.js) so both apply the
    // SAME contract — a divergence would make the November head-to-head compare two models under two
    // different validators. mode 'off' is exactly the historical single call: one model call, and an
    // unparseable reply is a 502 with no re-ask.
    let scored;
    try {
      scored = await scoreWithConsistency({
        callOnce, mode, jsonRetries: mode === 'off' ? 0 : jsonRetries(), agree: { maxSumDelta: maxSumDelta() },
      });
    } catch (e) {
      if (!(e instanceof Pis7ScoreError || e?.name === 'Pis7ScoreError')) throw e;   // transport / queue / abort → below
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
    const { scores, composite, rationale, billed } = scored;
    // Present in the response and in provenance ONLY when the evaluation actually reconciled several
    // calls. Omitted for 'off', so the incumbent path's response and fingerprint are unchanged.
    const consistency = mode === 'off' ? null : scored.consistency;
    // §10.2: the model that ACTUALLY produced this score — from the billed call, which every further
    // call was pinned to the same provider as.
    const model = first?.model;
    // Same call, same reason: the engine and its version as the SERVER reported them. Providers that
    // report nothing (anthropic) leave both undefined, so the incumbent path's provenance — and its
    // config_fingerprint, which does not cover these fields — is byte-identical to before.
    const engine = first?.engine ?? null;
    const runtime = first?.runtime ?? null;
    // Same call, same reason: the decoding the provider reports it SENT. A provider that reports nothing
    // leaves temperature null rather than restating the request, because "asked for 0" is not "ran at 0".
    const sent = first?.decoding ?? {};

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
      // The version of the prompt THIS provider received (base, or base + local addendum).
      prompt_version: promptVersion,
      rubric_version: RUBRIC_VERSION,
      // §10.2 / Model Lock Record: the full configuration that produced THIS score, including the
      // decoding parameters actually sent and a fingerprint over the whole set. Two scores with
      // different fingerprints did not come from the same locked configuration — which is the
      // question the lock exists to make answerable from the data rather than from memory.
      provenance: buildProvenance({
        provider, model,
        promptVersion, rubricVersion: RUBRIC_VERSION,
        temperature: sent.temperature ?? null, maxTokens: EVAL_DECODING.maxTokens,
        thinking: sent.thinking ?? null,
        weightsSha256: weights_sha256 ?? null,
        engine, runtime,
        consistency,
      }),
      // D21: the physician is billed call 1 only. The system-initiated calls live in `consistency`.
      input_tokens: billed.inputTokens,
      output_tokens: billed.outputTokens,
      provider,
      ...(consistency ? { consistency } : {}),
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
    // transcriptText is null when de-identification itself failed — then there is nothing safe to shadow.
    if (transcriptText !== null && parsed.data.shadow && !isQueueFull(err)) {
      fireShadowEvaluation({ pleId: parsed.data.ple_id, transcriptText });
    }
    // 503 queue_full (+ Retry-After) / 499 client gone / 413 transcript_too_large / else this 500.
    sendAiError(res, err, 'Evaluation service temporarily unavailable.');
  }
});

module.exports = router;
