// Shared call runtime for every AI provider: a concurrency queue + exponential backoff with jitter.
// Extracted VERBATIM from the original Anthropic relay so both providers inherit the same burst
// behaviour — a burst of simultaneous chats used to fail (~33% success at 40 concurrent) because
// they all hit the API at once and tripped its rate limit. Capping the number of IN-FLIGHT calls
// and queuing the excess smooths the burst instead of failing it.
//
// The queue and the retry are deliberately nested this way: the slot stays HELD during backoff, so a
// provider that is rate-limiting or overloaded naturally sheds pressure instead of letting waiters
// pile straight back onto it.
//
// Two queue shapes, chosen by the `lanes` option:
//   * no `lanes` — the original single FIFO. The Anthropic relay uses this, unchanged.
//   * `lanes`    — two lanes with an interactive reserve and a bounded depth, for the local DGX. A
//     physician's chat turn or the /end criteria call ('interactive') must never wait behind a burst
//     of PIS-7 evaluations ('background'): measured on the box, one evaluation is p50 68s, two
//     concurrent push p95 to 114s and four to 154s — over the 150s client deadline — so a FIFO shared
//     by every purpose parks the next chat turn for minutes. A bounded depth turns "wait, then time
//     out" into an immediate 503 the caller can retry later, and a caller's AbortSignal gives back the
//     slot (or the queue position) the moment it hangs up, so a backend timeout followed by a retry
//     cannot stack duplicate work behind itself.
// Abort-aware: resolves EARLY when `signal` fires, so a slot held through a backoff is given back the
// moment the caller hangs up rather than at the end of the wait. Timer and listener are both cleaned up.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const LANES = ['interactive', 'background'];

// Thrown WITHOUT enqueueing when a lane is already holding its maximum number of waiters. Carries
// everything the HTTP layer needs (503 + Retry-After) so no route has to know the queue's shape.
class QueueFullError extends Error {
  constructor({ provider, lane, maxQueue, retryAfterMs }) {
    super(`${provider} AI queue is full (lane "${lane}", ${maxQueue} already waiting) — retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'QueueFullError';
    this.code = 'queue_full';
    this.status = 503;
    this.lane = lane;
    this.retryAfterMs = retryAfterMs;
  }
}

// The caller's AbortSignal fired — while queued (the waiter is dropped) or in flight (the provider's
// own error is wrapped). `aborted: true` is what every layer above keys on; it is never retried.
class AbortError extends Error {
  constructor(lane, cause) {
    super(`AI call aborted by the caller${lane ? ` (lane "${lane}")` : ''}`, cause !== undefined ? { cause } : undefined);
    this.name = 'AbortError';
    this.code = 'aborted';
    this.aborted = true;
    this.lane = lane ?? null;
  }
}

const isQueueFull = (err) => !!err && err.code === 'queue_full';
const isAborted = (err) => !!err && (err.aborted === true || err.code === 'aborted');

// The original single FIFO. `lane` and `signal` are accepted and ignored so run() has one shape.
function fifoScheduler({ name, maxConcurrency }) {
  let active = 0;
  const waiters = [];
  return {
    acquire() {
      if (active < maxConcurrency) { active++; return Promise.resolve(); }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();      // hand the slot straight to the next waiter (active unchanged)
      else active--;
    },
    stats: () => ({ provider: name, active, queued: waiters.length, maxConcurrency }),
  };
}

// Two lanes over one pool of `maxConcurrency` slots.
//   interactive starts whenever ANY slot is free.
//   background  never holds more than maxConcurrency − reserve slots at once, so `reserve` slots can
//               only ever be taken by interactive work. It MAY run beside an interactive call: with
//               2 slots and reserve 1, one chat turn and one evaluation overlap, two evaluations never
//               do. (An earlier, stricter reading — background only while the reserve was idle —
//               starved evaluations under any steady chat traffic; the backend drain then saw a
//               503 storm rather than progress.)
// A freed slot goes to an interactive waiter first, then to a background waiter the reserve rule
// admits — never simply to whoever queued first.
function laneScheduler({ name, maxConcurrency, lanes }) {
  const reserve = Math.max(0, Math.floor(Number(lanes.reserve) || 0));
  const backgroundMax = maxConcurrency - reserve;
  if (backgroundMax < 1) {
    throw new Error(`createRunner(${name}): lanes.reserve (${reserve}) must be below maxConcurrency (${maxConcurrency}), or background calls could never start`);
  }
  const maxQueue = {
    interactive: lanes.maxQueue?.interactive ?? Infinity,
    background: lanes.maxQueue?.background ?? Infinity,
  };
  const retryAfterMs = lanes.retryAfterMs ?? 30000;

  const active = { interactive: 0, background: 0 };
  const waiters = { interactive: [], background: [] };
  const total = () => active.interactive + active.background;

  function canStart(lane) {
    if (lane === 'interactive') return total() < maxConcurrency;
    return total() < maxConcurrency && active.background < backgroundMax;
  }

  function acquire({ lane, signal }) {
    if (!LANES.includes(lane)) {
      return Promise.reject(new TypeError(`createRunner(${name}): unknown lane "${lane}" (valid: ${LANES.join(', ')})`));
    }
    if (signal?.aborted) return Promise.reject(new AbortError(lane, signal.reason));
    if (canStart(lane)) { active[lane]++; return Promise.resolve(); }
    // Depth is checked BEFORE enqueueing: a full lane is refused outright (nothing is counted,
    // nothing is held), so the caller can answer 503 now instead of timing out later.
    if (waiters[lane].length >= maxQueue[lane]) {
      return Promise.reject(new QueueFullError({ provider: name, lane, maxQueue: maxQueue[lane], retryAfterMs }));
    }
    return new Promise((resolve, reject) => {
      const waiter = { lane, resolve, reject, signal, onAbort: null };
      if (signal) {
        // A caller that hangs up while queued simply leaves the queue. It never held a slot, so
        // `active` is untouched and the later release() of whoever IS running cannot double-count.
        waiter.onAbort = () => {
          const i = waiters[lane].indexOf(waiter);
          if (i !== -1) waiters[lane].splice(i, 1);
          reject(new AbortError(lane, signal.reason));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiters[lane].push(waiter);
    });
  }

  function dequeue(lane) {
    const waiter = waiters[lane].shift();
    if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
    active[lane]++;
    waiter.resolve();
  }

  function release(lane) {
    active[lane]--;
    if (waiters.interactive.length && canStart('interactive')) return dequeue('interactive');
    if (waiters.background.length && canStart('background')) return dequeue('background');
  }

  const stats = () => ({
    provider: name,
    active: total(),
    queued: waiters.interactive.length + waiters.background.length,
    maxConcurrency,
    lanes: {
      interactive: { active: active.interactive, queued: waiters.interactive.length, maxQueue: maxQueue.interactive },
      background: { active: active.background, queued: waiters.background.length, maxQueue: maxQueue.background, maxActive: backgroundMax },
    },
  });

  return { acquire, release, stats };
}

// Providers differ in how they report "try again" (Anthropic sets err.status + a retry-after header;
// a local OpenAI-compatible server may only produce a network error), so both predicates are injected.
//
// `lanes` (optional): { reserve, maxQueue: { interactive, background }, retryAfterMs } — see above.
//
// Two predicates, because they answer different questions. `isRetryable(err)` CLASSIFIES the error
// (is it the kind of failure that could succeed on retry?) and is what lastError.retryable records.
// `shouldRetry(err)` DECIDES whether this call retries it, and defaults to isRetryable. A provider can
// decline to retry a retryable error for its own reasons (anthropic: a late evaluation error that a
// further attempt could not finish in time) without making the health record say the error was not
// retryable.
function createRunner({
  name,
  maxConcurrency,
  maxRetries,
  retryBaseMs,
  isRetryable,
  shouldRetry = isRetryable,
  retryAfterMs = () => null,
  onRetry = null,
  lanes = null,
}) {
  const sched = lanes ? laneScheduler({ name, maxConcurrency, lanes }) : fifoScheduler({ name, maxConcurrency });

  // Last observed OUTCOME, so a readiness probe can answer "can this provider actually serve?"
  // without spending a token on a synthetic call. Nothing recorded this before, and the gap was not
  // theoretical: an exhausted Anthropic balance returns 400 on every request while /health/deep
  // reported `ok`, because the probe only checked that the env var was set and the SDK constructed.
  // That is the same shape as the outage that left production broken for three days with both
  // operator screens green.
  //
  // Only TERMINAL outcomes are recorded. A retryable error that the loop then recovered from is not
  // a health signal — it is the retry doing its job — so `lastError` is written where the error
  // leaves run(), not where it is caught. Aborts and queue-full are caller and capacity conditions,
  // never provider health, and are excluded.
  let lastOk = null;      // epoch ms of the last successful call
  let lastError = null;   // { at, status, code, message, retryable, attempts }

  function backoffMs(attempt, err) {
    const ra = retryAfterMs(err);
    if (ra != null) return ra;  // honor the server's Retry-After when present
    const base = Math.min(retryBaseMs * 2 ** attempt, 20000);
    return base + Math.floor(Math.random() * 400); // jitter to de-sync concurrent retries
  }

  // `fn(attempt, signal)` receives the 0-based attempt number so a provider can log or vary per
  // attempt, and the caller's signal so an in-flight request can be cancelled at the transport.
  // Rejects with QueueFullError (lane full — nothing was queued) or AbortError (the signal fired).
  async function run(fn, { lane = 'background', signal } = {}) {
    const laneTag = lanes ? lane : null;
    await sched.acquire({ lane, signal }); // queue if we're already at max in-flight
    try {
      if (signal?.aborted) throw new AbortError(laneTag, signal.reason);
      let lastErr;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const out = await fn(attempt, signal);
          // Clear on success rather than letting the reader compare timestamps: lastOk and
          // lastError are both Date.now(), so a failure in the SAME millisecond as the previous
          // success would be silently discarded by a `lastOk >= lastError.at` test. Under load
          // that is not a rare race. "Any success clears the last failure" is also the rule we
          // actually mean.
          lastOk = Date.now();
          lastError = null;
          return out;
        } catch (err) {
          lastErr = err;
          // A caller that has hung up gets no retry: the work would be dead on arrival, and the slot
          // it is holding is exactly what the next caller is waiting for.
          if (signal?.aborted) throw isAborted(err) ? err : new AbortError(laneTag, err);
          if (attempt < maxRetries && shouldRetry(err)) {
            if (onRetry) onRetry(err, attempt, retryAfterMs(err));
            await sleep(backoffMs(attempt, err), signal); // slot stays held during backoff — the wait ends early on abort
            // Hung up during the backoff: release now (finally), not after one more attempt against a dead caller.
            if (signal?.aborted) throw new AbortError(laneTag, err);
            continue;
          }
          recordFailure(err, attempt);
          throw err;
        }
      }
      recordFailure(lastErr, maxRetries);
      throw lastErr;
    } finally {
      sched.release(lane);
    }
  }

  // Aborts and queue-full describe the CALLER or the queue, not the provider — recording them would
  // mark a healthy provider unhealthy every time a user closed a tab.
  function recordFailure(err, attempt) {
    if (isAborted(err) || isQueueFull(err)) return;
    lastError = {
      at: Date.now(),
      status: typeof err?.status === 'number' ? err.status : null,
      code: err?.code || err?.cause?.code || null,
      message: String(err?.message || err).slice(0, 300),
      retryable: isRetryable(err),
      attempts: attempt + 1,
    };
  }

  // Queue depth is the local-provider replacement for Anthropic's rate-limit headers: with no
  // quota to read, saturation only shows up as waiters piling up. lastOk/lastError answer the
  // question queue depth cannot: whether the last thing this provider did actually worked.
  return { run, stats: () => ({ ...sched.stats(), lastOk, lastError }) };
}

module.exports = { createRunner, QueueFullError, AbortError, isQueueFull, isAborted };
