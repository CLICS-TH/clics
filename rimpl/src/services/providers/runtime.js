// Shared call runtime for every AI provider: a FIFO concurrency queue + exponential backoff with
// jitter. Extracted VERBATIM from the original Anthropic relay so both providers inherit the same
// burst behaviour — a burst of simultaneous chats used to fail (~33% success at 40 concurrent)
// because they all hit the API at once and tripped its rate limit. Capping the number of IN-FLIGHT
// calls and queuing the excess smooths the burst instead of failing it.
//
// The queue and the retry are deliberately nested this way: the slot stays HELD during backoff, so a
// provider that is rate-limiting or overloaded naturally sheds pressure instead of letting waiters
// pile straight back onto it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Providers differ in how they report "try again" (Anthropic sets err.status + a retry-after header;
// a local OpenAI-compatible server may only produce a network error), so both predicates are injected.
function createRunner({
  name,
  maxConcurrency,
  maxRetries,
  retryBaseMs,
  isRetryable,
  retryAfterMs = () => null,
  onRetry = null,
}) {
  let active = 0;
  const waiters = [];

  function acquire() {
    if (active < maxConcurrency) { active++; return Promise.resolve(); }
    return new Promise((resolve) => waiters.push(resolve));
  }
  function release() {
    const next = waiters.shift();
    if (next) next();      // hand the slot straight to the next waiter (active unchanged)
    else active--;
  }

  function backoffMs(attempt, err) {
    const ra = retryAfterMs(err);
    if (ra != null) return ra;  // honor the server's Retry-After when present
    const base = Math.min(retryBaseMs * 2 ** attempt, 20000);
    return base + Math.floor(Math.random() * 400); // jitter to de-sync concurrent retries
  }

  // `fn` receives the 0-based attempt number so a provider can log or vary per attempt.
  async function run(fn) {
    await acquire(); // queue if we're already at max in-flight
    try {
      let lastErr;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn(attempt);
        } catch (err) {
          lastErr = err;
          if (attempt < maxRetries && isRetryable(err)) {
            if (onRetry) onRetry(err, attempt, retryAfterMs(err));
            await sleep(backoffMs(attempt, err)); // slot stays held during backoff
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    } finally {
      release();
    }
  }

  // Queue depth is the local-provider replacement for Anthropic's rate-limit headers: with no
  // quota to read, saturation only shows up as waiters piling up.
  const stats = () => ({ provider: name, active, queued: waiters.length, maxConcurrency });

  return { run, stats };
}

module.exports = { createRunner };
