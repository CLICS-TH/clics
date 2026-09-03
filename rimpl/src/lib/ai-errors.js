// HTTP mapping for the errors the AI seam can raise, shared by the four AI routes so the backend sees
// ONE vocabulary regardless of which route or provider produced the failure:
//   503 { code: 'queue_full', retry_after_s }  + Retry-After  — the provider's lane is full
//   499 (no body)                                             — the client hung up; nobody to answer
//   413 { code: 'transcript_too_large', est_tokens, limit }   — the prompt cannot fit the model
//   500 { error }                                             — the route's own generic message
//
// Bodies are deliberately generic. The transcript, the identifiers it carried, and the provider's
// hint text (which names the model and the server) belong in the on-prem logs only — an error body
// travels back through the backend and could end up in a client, a log aggregator, or a bug report.
const isQueueFull = (err) => !!err && err.code === 'queue_full';
const isAborted = (err) => !!err && (err.aborted === true || err.code === 'aborted');
const isTooLarge = (err) => !!err && (err.contextTooSmall === true || err.code === 'transcript_too_large');

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
  return res.status(500).json({ error: fallback });
}

// One line for the expected classes — a busy box or a hung-up client is not a stack trace — and the
// full error otherwise. A provider error may quote the SERVER's message; it never carries the prompt.
function logAiError(tag, err) {
  if (isAborted(err)) return console.warn(`${tag} client went away — call aborted (${err?.message || ''})`);
  if (isQueueFull(err) || isTooLarge(err)) return console.warn(`${tag} ${err.code}: ${err.message}`);
  console.error(`${tag} error:`, err);
}

module.exports = { sendAiError, logAiError, isQueueFull, isAborted, isTooLarge };
