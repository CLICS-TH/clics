// Evaluation provenance — CREC082 Primary Evaluator Model Lock Record V1.0, Protocol §10.2.
//
// The Model Lock Record asks for the weights SHA-256, inference engine, quantization, decoding
// parameters (temperature / top_p / max tokens / seed), and container/OS version, all frozen before
// the first participant. The system already stamped model_version, prompt_version and
// rubric_version onto every score; the rest was a set of blanks in a Word document.
//
// WHAT A RUNNING SYSTEM CAN AND CANNOT KNOW. The weights checksum is not readable over an inference
// API — the file sits on the DGX. So it cannot be MEASURED here; it can only be DECLARED once, at
// lock time, and then stamped onto every score. That turns an unverifiable claim into a checkable
// one: if the declared checksum is absent, scores say so, and if someone re-declares it mid-pilot
// the scores either side of that moment carry different values and the break is visible in the data
// rather than in somebody's memory.
//
// Everything else here IS measured: the decoding parameters are the ones actually sent, and the
// model string is the one the server answered with.
//
// The fingerprint exists so drift is detectable without comparing six fields by eye. Two scores with
// the same fingerprint came from the same declared configuration; two that differ did not, and the
// §10.2 lock has a question to answer.
const { createHash } = require('crypto');

// The CONFIGURATION half of a consistency block (services/consistency.js): which reconciliation
// method and mode produced the score. The per-run outcome fields (rule, calls, max_delta, the score
// vectors, latency, token counts) stay in the provenance object but OUT of the fingerprint — two
// evaluations under the same configuration must fingerprint the same whether or not one of them
// happened to need a third call.
function canonicalConsistency(c) {
  return {
    method: c.method ?? null,
    mode: c.mode ?? null,
    // The agreement thresholds are configuration too: a score reconciled under Σ|Δ| ≤ 2 did not come
    // from the same rule as one reconciled under the per-domain check alone.
    agree: { max_domain_delta: c.agree?.max_domain_delta ?? null, max_sum_delta: c.agree?.max_sum_delta ?? null },
  };
}

// A stable fingerprint over the configuration that produced a score. Sorted keys and a fixed shape,
// so the same configuration always hashes the same regardless of property order.
function configFingerprint(p) {
  const canonical = JSON.stringify({
    provider: p.provider ?? null,
    model: p.model ?? null,
    weights_sha256: p.weights_sha256 ?? null,
    prompt_version: p.prompt_version ?? null,
    rubric_version: p.rubric_version ?? null,
    decoding: {
      temperature: p.decoding?.temperature ?? null,
      max_tokens: p.decoding?.max_tokens ?? null,
      top_p: p.decoding?.top_p ?? null,
      seed: p.decoding?.seed ?? null,
      num_ctx: p.decoding?.num_ctx ?? null,
      // ONLY when a thinking mode was sent (claude-sonnet-5-5 and later). Omitted otherwise so every
      // fingerprint written before the field existed, and every local one, hashes exactly as it did.
      ...(p.decoding?.thinking ? { thinking: p.decoding.thinking } : {}),
      // Same rule for the effort level sent (output_config.effort).
      ...(p.decoding?.effort ? { effort: p.decoding.effort } : {}),
    },
    // ONLY when present. An evaluation without a consistency block must hash byte-identically to one
    // produced before the field existed, or every stored fingerprint in the pilot stops being
    // comparable with the ones written after this change.
    ...(p.consistency ? { consistency: canonicalConsistency(p.consistency) } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Build the provenance block recorded alongside a PIS-7 score.
 *
 * `weightsSha256` is the DECLARED checksum from the Model Lock Record (app_settings, forwarded by
 * the backend). Null means the evaluator has not been locked yet — which is itself the honest
 * answer, and is exactly what a reviewer asking "was this score produced under the locked
 * configuration?" needs to see.
 */
function buildProvenance({
  provider, model, promptVersion, rubricVersion,
  temperature, maxTokens, topP, seed, numCtx, thinking = null, effort = null,
  weightsSha256 = null, engine = null, quantization = null, runtime = null,
  consistency = null,
}) {
  const p = {
    provider: provider ?? null,
    model: model ?? null,
    prompt_version: promptVersion ?? null,
    rubric_version: rubricVersion ?? null,
    // Measured: what was actually sent on this call.
    decoding: {
      temperature: temperature ?? null,
      max_tokens: maxTokens ?? null,
      top_p: topP ?? null,
      seed: seed ?? null,
      num_ctx: numCtx ?? null,
      // The thinking mode sent (e.g. 'adaptive'), present only when one was. It changes what the
      // model does before it answers, so two scores that differ in it are two configurations.
      ...(thinking ? { thinking } : {}),
      // The effort level sent (output_config.effort), present only when one was. It sets how much the
      // model thinks, so it is configuration in the same sense.
      ...(effort ? { effort } : {}),
    },
    // Declared: filled from the Model Lock Record. Null until the evaluator is locked.
    weights_sha256: weightsSha256 || null,
    engine: engine || null,
    quantization: quantization || null,
    runtime: runtime || null,
    locked: !!weightsSha256,
    // How several calls were reconciled into this score (services/consistency.js) — present only when
    // the evaluation ran that way. Numbers and fixed-vocabulary strings; never model text.
    ...(consistency ? { consistency } : {}),
  };
  return { ...p, config_fingerprint: configFingerprint(p) };
}

module.exports = { buildProvenance, configFingerprint, canonicalConsistency };
