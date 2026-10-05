// Server-sent events for a streamed chat turn (POST /chat with `stream: true`).
//
// The stream opens LAZILY, on the first event. Until then the route answers exactly as it always has
// (a plain JSON body, a 4xx/5xx from sendAiError), so a turn that fails before the model says anything,
// or a rescue turn that is never streamed, looks to the caller exactly like a non-streamed one.
//
// Once open, the route keeps its existing `res.status(n).json(body)` calls: `out()` hands it a
// stand-in that turns that call into the stream's last event,
//   event: done   data: {"status": n, "body": {...the JSON the route would have sent...}}
// so the final reply, its provenance and every error shape stay ONE contract in both modes.
// Events before it:
//   event: delta    data: {"text": "..."}               a piece of the reply, in order
//   event: replace  data: {"reason": "citation"|...}    the text so far is being replaced by a retry

function sseStream(res) {
  let open = false;

  function ensureOpen() {
    if (open) return;
    open = true;
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // nginx (and Railway's edge) buffer a response unless told not to, which would deliver the
      // "stream" in one piece at the end.
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
  }

  function send(event, data) {
    ensureOpen();
    if (res.writableEnded || res.destroyed) return;   // the caller hung up: nothing to deliver to
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function finish(status, body) {
    send('done', { status, body: body ?? null });
    if (!res.writableEnded) res.end();
  }

  // What the route calls `res` from the point a stream may have opened. A fresh stand-in per call,
  // so `status()` on one never leaks into another.
  function out() {
    if (!open) return res;
    const shim = {
      headersSent: true,
      _status: 200,
      status(n) { shim._status = n; return shim; },
      set() { return shim; },          // Retry-After etc.: the body already carries retry_after_s
      json(body) { finish(shim._status, body); return shim; },
      end() { finish(shim._status, null); return shim; },
    };
    return shim;
  }

  return {
    get open() { return open; },
    send,
    out,
  };
}

module.exports = { sseStream };
