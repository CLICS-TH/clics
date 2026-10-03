// HTTP mapping for the errors the AI seam can raise, shared by the four AI routes so the backend sees
// ONE vocabulary regardless of which route or provider produced the failure:
//   503 { code: 'queue_full', retry_after_s }  + Retry-After  — the provider's lane is full
//   499 (no body)                                             — the client hung up; nobody to answer
//   413 { code: 'transcript_too_large', est_tokens, limit }   — the prompt cannot fit the model
//   422 { code: 'refused', category, input_tokens, output_tokens, provider, model }
//                                                             — the model's safeguards declined the
//                                                               request (stop_reason "refusal"). 422,
//                                                               not 5xx: re-sending the same request is
//                                                               declined again and billed again, so the
//                                                               backend must treat it as deterministic
//                                                               (rimpl-client DETERMINISTIC_STATUSES).
//                                                               The tokens are BILLED, so they travel
//                                                               back for the backend to meter.
//   500 { error }                                             — the route's own generic message
//
// Bodies are deliberately generic. The transcript, the identifiers it carried, and the provider's
// hint text (which names the model and the server) belong in the on-prem logs only — an error body
// travels back through the backend and could end up in a client, a log aggregator, or a bug report.
const isQueueFull = (err) => !!err && err.code === 'queue_full';
const isAborted = (err) => !!err && (err.aborted === true || err.code === 'aborted');
const isTooLarge = (err) => !!err && (err.contextTooSmall === true || err.code === 'transcript_too_large');
const isRefused = (err) => !!err && err.code === 'refused';
// A refusal's category is a short lowercase word from Anthropic's (open) set; anything else is dropped.
const refusalCategory = (err) => (typeof err?.category === 'string' && /^[a-z_]{1,40}$/.test(err.category) ? err.category : null);
const KNOWN_PROVIDERS = new Set(['anthropic', 'local']);

// Copy ONLY the named keys, and only when they are finite numbers (else null). An error body travels
// back through the backend; a field that is not a number does not get in, whatever else the provider
// hung on the object.
function numbersOnly(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = Number.isFinite(obj?.[k]) ? obj[k] : null;
  return out;
}

function sendAiError(res, err, fallback = 'AI service temporarily unavailable. Please try again.') {
  if (isQueueFull(err)) {
    const retryAfterS = Math.max(1, Math.ceil((Number(err.retryAfterMs) || 30000) / 1000));
    res.set('Retry-After', String(retryAfterS));
    return res.status(503).json({ error: 'AI service is busy. Please retry shortly.', code: 'queue_full', retry_after_s: retryAfterS });
  }
  if (isAborted(err)) {
    // The client is gone; 499 (nginx's "client closed request") exists for the access log only.
    if (!res.headersSent) res.status(499).end();
    return;
  }
  if (isTooLarge(err)) {
    return res.status(413).json({
      error: 'Transcript is too large for the AI model.',
      code: 'transcript_too_large',
      est_tokens: Number.isFinite(err.est_tokens) ? err.est_tokens : null,
      limit: Number.isFinite(err.limit) ? err.limit : null,
      // How est_tokens was derived — providers/local.js's learnt estimate/served ratio and its sample
      // count — when the provider says. Two whitelisted numbers; nothing else rides along.
      ...(err.calibration ? { calibration: numbersOnly(err.calibration, ['ratio', 'n']) } : {}),
    });
  }
  if (isRefused(err)) {
    // Generic wording on purpose: the physician-facing notice is the backend's (and is COPY PENDING).
    return res.status(422).json({
      error: 'The AI model declined this request.',
      code: 'refused',
      category: refusalCategory(err),
      input_tokens: Number.isFinite(err.inputTokens) ? err.inputTokens : 0,
      output_tokens: Number.isFinite(err.outputTokens) ? err.outputTokens : 0,
      provider: KNOWN_PROVIDERS.has(err.usage?.provider) ? err.usage.provider : 'anthropic',
      model: typeof err.model === 'string' && /^[a-z0-9.-]{1,64}$/.test(err.model) ? err.model : null,
    });
  }
  return res.status(500).json({ error: fallback });
}

// One line for the expected classes — a busy box or a hung-up client is not a stack trace — and the
// full error otherwise. A provider error may quote the SERVER's message; it never carries the prompt.
function logAiError(tag, err) {
  if (isAborted(err)) return console.warn(`${tag} client went away — call aborted (${err?.message || ''})`);
  if (isQueueFull(err) || isTooLarge(err)) return console.warn(`${tag} ${err.code}: ${err.message}`);
  // `refused:<category>`, a distinct line from invalid_json / out-of-range. The category only, never content.
  if (isRefused(err)) return console.warn(`${tag} refused:${refusalCategory(err) ?? 'none'}`);
  console.error(`${tag} error:`, err);
}

module.exports = { sendAiError, logAiError, isQueueFull, isAborted, isTooLarge, isRefused };
