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
  temperature, maxTokens, topP, seed, numCtx,
  weightsSha256 = null, engine = null, quantization = null, runtime = null,
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
    engine: engine || null,
    quantization: quantization || null,
    runtime: runtime || null,
    locked: !!weightsSha256,
  };
  return { ...p, config_fingerprint: configFingerprint(p) };
}

module.exports = { buildProvenance, configFingerprint };
