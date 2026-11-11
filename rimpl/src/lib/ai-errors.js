// HTTP mapping for the errors the AI seam can raise, shared by the four AI routes so the backend sees
// ONE vocabulary regardless of which route or provider produced the failure:
//   503 { code: 'queue_full', retry_after_s }  + Retry-After  — the provider's lane is full
//   499 (no body)                                             — the client hung up; nobody to answer
//   413 { code: 'transcript_too_large', est_tokens, limit }   — the prompt cannot fit the model
//   503 { code: 'empty_reply', input_tokens, output_tokens, provider } — the model answered with no reply text
//   503 { code: 'local_only_refused', provider, purpose } — local-only mode refused a non-local provider; nothing was sent
//   500 { error }                                             — the route's own generic message
//
// Bodies are deliberately generic. The transcript, the identifiers it carried, and the provider's
// hint text (which names the model and the server) belong in the on-prem logs only — an error body
// travels back through the backend and could end up in a client, a log aggregator, or a bug report.
const isQueueFull = (err) => !!err && err.code === 'queue_full';
const isAborted = (err) => !!err && (err.aborted === true || err.code === 'aborted');
const isTooLarge = (err) => !!err && (err.contextTooSmall === true || err.code === 'transcript_too_large');
const isEmptyReply = (err) => !!err && err.code === 'empty_reply';
const isLocalOnlyRefused = (err) => !!err && err.code === 'local_only_refused';

// 503, not 502: backend/src/services/rimpl-client.js treats a 502 as deterministic (criteria go to manual
// QA, no retry) and a 503 as transient. A reasoning model that spent max_tokens thinking may well answer
// on the next generation. No retry hint: unlike queue_full the box was not busy, so the backend keeps its
// own backoff. The burned tokens ride along so the backend meters a call that produced nothing.

// The provider answered, but with no reply text: empty, whitespace, or nothing but reasoning. Raised by
// services/ai.js for every provider and purpose, and by providers/local-factory.js for an unclosed
// THINK_PREOPENED block (reasoningOnly). Detail is numbers and a stop-reason token, never the text.
function emptyReplyError({ provider, stopReason, inputTokens, outputTokens, reasoningOnly = false } = {}) {
  const stop = typeof stopReason === 'string' ? stopReason.slice(0, 32) : null;
  const tokens = Number.isFinite(outputTokens) ? outputTokens : null;
  const err = new Error(`${provider || 'AI provider'}: the reply carried no answer text (${reasoningOnly ? 'reasoning only' : 'empty'}, stop ${stop ?? 'none'}, ${tokens ?? '?'} output tokens)`);
  return Object.assign(err, {
    code: 'empty_reply', status: 503, provider: provider || null, stopReason: stop,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null, outputTokens: tokens, reasoningOnly: !!reasoningOnly,
  });
}

// Local-only mode (lib/provider-policy.js localOnly, ADR 0012) refused the call BEFORE any request was
// sent: the purpose resolved to a non-local provider, or the settings cache is cold. 503, not 500: the
// backend treats a 503 as transient (an evaluation is requeued, never sent to manual QA; a chat turn is
// refunded and its text kept), and the fix is a configuration change, not a different request. The
// message is for the on-prem log and names where the provider came from; the HTTP body carries only the
// code, the provider name and the purpose.
function localOnlyError({ provider, purpose, whence, reason } = {}) {
  const what = reason || `provider "${provider}"${whence ? ` (from ${whence})` : ''} is not an on-prem model`;
  const err = new Error(`Local-only mode (CLICS_LOCAL_ONLY) refused ${purpose ? `"${purpose}"` : 'this call'}: ${what}. Only the on-prem evaluator (local) and the on-prem tutor (local-tutor) may serve while it is on; nothing was sent.`);
  return Object.assign(err, { code: 'local_only_refused', status: 503, provider: provider || null, purpose: purpose || null });
}

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
  if (isEmptyReply(err)) {
    return res.status(503).json({
      error: fallback, code: 'empty_reply',
      ...numbersOnly({ input_tokens: err.inputTokens, output_tokens: err.outputTokens }, ['input_tokens', 'output_tokens']),
      provider: typeof err.provider === 'string' && /^[a-z-]{1,32}$/.test(err.provider) ? err.provider : null,
    });
  }
  if (isLocalOnlyRefused(err)) {
    const word = (v) => (typeof v === 'string' && /^[a-z-]{1,32}$/.test(v) ? v : null);
    return res.status(503).json({
      error: 'Local-only mode is on: this AI request was refused before anything was sent.', code: 'local_only_refused',
      provider: word(err.provider), purpose: word(err.purpose),
    });
  }
  return res.status(500).json({ error: fallback });
}

// One line for the expected classes — a busy box or a hung-up client is not a stack trace — and the
// full error otherwise. A provider error may quote the SERVER's message; it never carries the prompt.
function logAiError(tag, err) {
  if (isAborted(err)) return console.warn(`${tag} client went away — call aborted (${err?.message || ''})`);
  if (isQueueFull(err) || isTooLarge(err) || isEmptyReply(err) || isLocalOnlyRefused(err)) return console.warn(`${tag} ${err.code}: ${err.message}`);
  console.error(`${tag} error:`, err);
}

module.exports = { sendAiError, logAiError, emptyReplyError, localOnlyError, isQueueFull, isAborted, isTooLarge, isEmptyReply, isLocalOnlyRefused };
