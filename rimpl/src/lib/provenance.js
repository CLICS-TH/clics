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
    },
    // ONLY when present. An evaluation without a consistency block must hash byte-identically to one
    // produced before the field existed, or every stored fingerprint in the pilot stops being
    // comparable with the ones written after this change.
    ...(p.consistency ? { consistency: canonicalConsistency(p.consistency) } : {}),
    // The serving stack, by the same rule (#75 gap 1). Two scores from the same weights under a
    // different engine build or quantisation did not come from the same configuration — a vLLM upgrade
    // under an unchanged model id is exactly the drift §10.2 asks to be detectable — so each folds in
    // when it is known, and ONLY then. Anthropic reports none of the three, so an Anthropic row hashes
    // byte-identically to one fingerprinted before this (tests/provenance-fingerprint.test.js pins
    // that against master's value). A local row gets a new value when it carries a system_fingerprint
    // — and also when <prefix>NUM_CTX is set, because decoding.num_ctx above is now the value actually
    // sent (routes/evaluate.js), where until 2026-10-15 it was always null. Reverses the 2026-09-05 rule
    // (docs/GATE0-DGX-RESULTS.md §8.10).
    ...(p.engine ? { engine: p.engine } : {}),
    ...(p.quantization ? { quantization: p.quantization } : {}),
    ...(p.runtime ? { runtime: p.runtime } : {}),
    // The DECLARATION behind the lock in force, by the same rule (#75 acceptance criterion 7). Its
    // declared quantization, inference engine, environment and system prompt version are things no
    // API reports, so without this two locks over the same weights checksum — the same file served at
    // fp8 and at bf16, say — gave scores with identical fingerprints. The backend sends it ONLY while a
    // lock is in force (services/model-lock.js lockDeclarationDigest), so an unlocked or pre-lock row
    // hashes byte-identically to before (tests/provenance-lock-declaration.test.js pins master's values).
    ...(p.lock_declaration_sha256 ? { lock_declaration_sha256: p.lock_declaration_sha256 } : {}),
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
 *
 * `lockDeclarationSha256` is the backend's digest over the whole declared Model Lock Record (weights,
 * engine, quantization, environment, prompt and rubric versions, decoding). Null = no lock in force.
 * Opaque here: rimpl cannot recompute it, it only carries it into the score and its fingerprint.
 */
function buildProvenance({
  provider, model, promptVersion, rubricVersion,
  temperature, maxTokens, topP, seed, numCtx,
  weightsSha256 = null, lockDeclarationSha256 = null, engine = null, quantization = null, runtime = null,
  consistency = null,
  deid = null,
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
    },
    // Declared: filled from the Model Lock Record. Null until the evaluator is locked.
    weights_sha256: weightsSha256 || null,
    lock_declaration_sha256: lockDeclarationSha256 || null,
    engine: engine || null,
    quantization: quantization || null,
    runtime: runtime || null,
    locked: !!weightsSha256,
    // How several calls were reconciled into this score (services/consistency.js) — present only when
    // the evaluation ran that way. Numbers and fixed-vocabulary strings; never model text.
    ...(consistency ? { consistency } : {}),
    // How the scored transcript was de-identified — which token numbering it used (lib/transcript.js
    // seedWithChiefComplaint). Recorded, but deliberately NOT in config_fingerprint: it describes the
    // input, not the evaluator's configuration, and folding it in would make every fingerprint written
    // after this change incomparable with the ones before it.
    deid: deid ?? null,
  };
  return { ...p, config_fingerprint: configFingerprint(p) };
}

module.exports = { buildProvenance, configFingerprint, canonicalConsistency };
