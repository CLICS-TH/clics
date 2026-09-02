// An AbortSignal that fires when the CLIENT of an Express request goes away before the response is
// written — the physician closed the tab, or the backend's own timeout hung up on us. Passed down to
// callAI so a queued call leaves the queue and an in-flight one is cancelled at the transport; a
// turn nobody is waiting for must not keep occupying the model.
//
// It listens on `res.on('close')`, NOT `req.on('close')`. On Node >= 16 the request's 'close' fires
// as soon as the request BODY has been consumed — i.e. right after express.json() has parsed it —
// which would abort every call the moment it was queued. The response only closes when the socket
// does, and `writableFinished` tells a normal completion (the reply went out, then the socket
// closed) apart from a hang-up (the socket closed with nothing written).
function requestSignal(_req, res) {
  const controller = new AbortController();
  res.once('close', () => {
    if (res.writableFinished) return;
    controller.abort(Object.assign(new Error('client disconnected before the response was sent'), {
      name: 'AbortError', code: 'aborted', aborted: true,
    }));
  });
  return controller.signal;
}

module.exports = { requestSignal };
