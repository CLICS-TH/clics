// providers/runtime.js — the two-lane bounded runner behind the local provider, tested on its own:
// fake fns behind deferred promises, no provider, no network, no timers beyond a 1ms backoff.
//
// The invariants that matter (each is a physician-visible failure when broken):
//   * an interactive waiter (a chat turn) is served before an earlier-queued background one (an
//     evaluation) — otherwise a burst of scoring parks the next physician for minutes;
//   * the reserve keeps a slot free for interactive work while background is saturated;
//   * a full lane is refused synchronously (503 now beats a timeout later) and counts nothing;
//   * a caller that hangs up while queued leaves the queue; in flight, its signal reaches fn, the
//     failure is never retried, and the slot is released — no phantom slots, no double counting;
//   * without `lanes` the runner is the original FIFO, byte for byte (the Anthropic relay).
const { createRunner, QueueFullError, AbortError, isQueueFull, isAborted } = require('../src/services/providers/runtime');

const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mkRunner(over = {}) {
  return createRunner({
    name: 'test',
    maxConcurrency: 2,
    maxRetries: 0,
    retryBaseMs: 1,
    isRetryable: () => false,
    lanes: { reserve: 1, maxQueue: { interactive: 4, background: 2 }, retryAfterMs: 30000 },
    ...over,
  });
}

// A job whose fn blocks until finish() / fail(); records whether and how often it started.
function job(runner, lane, opts = {}) {
  const gate = deferred();
  const j = { started: false, attempts: 0, signal: undefined, finish: gate.resolve, fail: gate.reject };
  j.result = runner.run(async (attempt, signal) => {
    j.started = true;
    j.attempts = attempt + 1;
    j.signal = signal;
    return gate.promise;
  }, { lane, ...opts });
  j.result.catch(() => {}); // observed explicitly by the tests that care; never an unhandled rejection
  return j;
}

describe('lane ordering and the interactive reserve', () => {
  test('an interactive waiter is dequeued before an earlier-queued background waiter', async () => {
    const r = mkRunner(); // 2 slots, background may hold 1
    const b1 = job(r, 'background');
    const i1 = job(r, 'interactive');
    await tick();
    expect(b1.started).toBe(true);
    expect(i1.started).toBe(true);
    expect(r.stats()).toMatchObject({ active: 2, queued: 0 });

    const b2 = job(r, 'background');   // queued FIRST
    const i2 = job(r, 'interactive');  // queued second
    await tick();
    expect(b2.started).toBe(false);
    expect(i2.started).toBe(false);
    expect(r.stats()).toMatchObject({ active: 2, queued: 2 });

    i1.finish();
    await i1.result;
    await tick();
    expect(i2.started).toBe(true);    // the later interactive jumps the earlier background
    expect(b2.started).toBe(false);

    i2.finish();
    await i2.result;
    await tick();
    expect(b2.started).toBe(false);   // one background (b1) still running: the reserve holds b2 back

    b1.finish();
    await b1.result;
    await tick();
    expect(b2.started).toBe(true);    // box idle → background may start

    b2.finish();
    await b2.result;
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('the reserve keeps one slot free for interactive while background is saturated', async () => {
    const r = mkRunner();
    const b1 = job(r, 'background');
    const b2 = job(r, 'background');
    await tick();
    expect(b1.started).toBe(true);
    expect(b2.started).toBe(false);   // background maxActive = 2 − 1 = 1
    expect(r.stats().lanes.background).toEqual({ active: 1, queued: 1, maxQueue: 2, maxActive: 1 });

    const i1 = job(r, 'interactive');
    await tick();
    expect(i1.started).toBe(true);    // the reserved slot, immediately, past the waiting b2
    expect(r.stats()).toMatchObject({ active: 2, queued: 1 });

    i1.finish(); b1.finish();
    await Promise.all([i1.result, b1.result]);
    await tick();
    expect(b2.started).toBe(true);
    b2.finish();
    await b2.result;
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('one interactive call does NOT stop a background call taking the other slot (they overlap; two backgrounds never do)', async () => {
    const r = mkRunner(); // 2 slots, reserve 1 → background maxActive 1
    const i1 = job(r, 'interactive');
    await tick();
    expect(i1.started).toBe(true);
    const b1 = job(r, 'background');
    await tick();
    expect(b1.started).toBe(true);    // total 1 < 2 and background 0 < 1 → the evaluation runs beside the chat turn
    expect(r.stats()).toMatchObject({ active: 2, queued: 0 });
    const b2 = job(r, 'background');
    await tick();
    expect(b2.started).toBe(false);   // background maxActive reached — the reserve slot stays interactive-only
    i1.finish(); await i1.result; await tick();
    expect(b2.started).toBe(false);   // still one background running; the freed slot is the reserve
    b1.finish(); await b1.result; await tick();
    expect(b2.started).toBe(true);
    b2.finish(); await b2.result;
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('background never holds more than maxConcurrency − reserve slots even when the box is otherwise idle', async () => {
    const r = mkRunner({ maxConcurrency: 4, lanes: { reserve: 1, maxQueue: { interactive: 4, background: 8 }, retryAfterMs: 1000 } });
    const jobs = Array.from({ length: 6 }, () => job(r, 'background'));
    await tick();
    expect(jobs.filter((j) => j.started)).toHaveLength(3);
    expect(r.stats()).toMatchObject({ active: 3, queued: 3 });
    expect(r.stats().lanes.background.maxActive).toBe(3);
    jobs.forEach((j) => j.finish());
    await Promise.all(jobs.map((j) => j.result));
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });
});

describe('bounded depth → QueueFullError', () => {
  test('background beyond maxQueue is refused synchronously with queue_full; nothing queued, nothing counted', async () => {
    const r = mkRunner(); // background maxQueue 2
    const b1 = job(r, 'background');
    const b2 = job(r, 'background');
    const b3 = job(r, 'background');
    await tick();
    expect(r.stats().lanes.background).toMatchObject({ active: 1, queued: 2, maxQueue: 2 });

    let fnRan = false;
    const refused = r.run(async () => { fnRan = true; }, { lane: 'background' });
    refused.catch(() => {});
    // Refused BEFORE enqueueing: the queue is still exactly 2 deep and `active` did not move.
    expect(r.stats()).toMatchObject({ active: 1, queued: 2 });
    await expect(refused).rejects.toBeInstanceOf(QueueFullError);
    await expect(refused).rejects.toMatchObject({ code: 'queue_full', status: 503, lane: 'background', retryAfterMs: 30000 });
    expect(isQueueFull(await refused.catch((e) => e))).toBe(true);
    expect(fnRan).toBe(false);

    // The interactive lane is independent: it still admits.
    const i1 = job(r, 'interactive');
    await tick();
    expect(i1.started).toBe(true);

    [b1, i1].forEach((j) => j.finish());
    await Promise.all([b1.result, i1.result]);
    await tick();
    b2.finish(); await b2.result; await tick();
    b3.finish(); await b3.result;
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('the interactive lane has its own depth', async () => {
    const r = mkRunner(); // interactive maxQueue 4
    const running = [job(r, 'interactive'), job(r, 'interactive')];
    const waiting = Array.from({ length: 4 }, () => job(r, 'interactive'));
    await tick();
    expect(r.stats().lanes.interactive).toEqual({ active: 2, queued: 4, maxQueue: 4 });
    await expect(r.run(async () => 'no', { lane: 'interactive' })).rejects.toMatchObject({ code: 'queue_full', lane: 'interactive' });
    expect(r.stats().lanes.interactive.queued).toBe(4);

    for (const j of [...running, ...waiting]) { j.finish(); await j.result; await tick(); }
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('maxQueue 0 means "never wait": refused whenever no slot is free', async () => {
    const r = mkRunner({ maxConcurrency: 1, lanes: { reserve: 0, maxQueue: { interactive: 0, background: 0 }, retryAfterMs: 5000 } });
    const a = job(r, 'interactive');
    await tick();
    await expect(r.run(async () => 'no', { lane: 'interactive' })).rejects.toMatchObject({ code: 'queue_full', retryAfterMs: 5000 });
    a.finish();
    await a.result;
    await expect(r.run(async () => 'yes', { lane: 'interactive' })).resolves.toBe('yes');
  });

  test('the error message carries the lane and the retry hint, never anything from the call', () => {
    const err = new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 });
    expect(err.message).toMatch(/local AI queue is full \(lane "interactive", 4 already waiting\) — retry in 30s/);
    expect(err.name).toBe('QueueFullError');
  });
});

describe('cancellation via the caller signal', () => {
  test('abort while queued removes the waiter; later releases do not double-count', async () => {
    const r = mkRunner({ maxConcurrency: 1, lanes: { reserve: 0, maxQueue: { interactive: 4, background: 4 }, retryAfterMs: 1000 } });
    const a = job(r, 'interactive');
    await tick();
    expect(a.started).toBe(true);

    const ac = new AbortController();
    const q = job(r, 'interactive', { signal: ac.signal });
    await tick();
    expect(q.started).toBe(false);
    expect(r.stats()).toMatchObject({ active: 1, queued: 1 });

    ac.abort();
    await expect(q.result).rejects.toBeInstanceOf(AbortError);
    await expect(q.result).rejects.toMatchObject({ code: 'aborted', aborted: true, lane: 'interactive' });
    expect(isAborted(await q.result.catch((e) => e))).toBe(true);
    expect(r.stats()).toMatchObject({ active: 1, queued: 0 });   // gone from the queue; `active` untouched

    a.finish();
    await a.result;
    await tick();
    expect(q.started).toBe(false);                              // the aborted waiter never ran
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });  // not −1, no phantom start

    // …and the runner is healthy afterwards.
    const c = job(r, 'background');
    await tick();
    expect(c.started).toBe(true);
    c.finish();
    await c.result;
    expect(r.stats().active).toBe(0);
  });

  test('abort in flight: fn received the signal, the failure is never retried, the slot is released', async () => {
    const r = mkRunner({ maxRetries: 3, isRetryable: () => true }); // "retry everything" — the abort must still win
    const ac = new AbortController();
    const j = job(r, 'interactive', { signal: ac.signal });
    await tick();
    expect(j.started).toBe(true);
    expect(j.signal).toBe(ac.signal);   // the very same signal, so the transport can cancel on it
    expect(r.stats()).toMatchObject({ active: 1 });

    ac.abort();
    j.fail(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })); // what fetch throws
    const err = await j.result.catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err).toMatchObject({ code: 'aborted', aborted: true });
    expect(err.cause).toMatchObject({ name: 'AbortError' });   // the transport's error is kept as the cause
    expect(j.attempts).toBe(1);
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('an in-flight failure already tagged `aborted` is passed through, not re-wrapped', async () => {
    const r = mkRunner({ maxRetries: 3, isRetryable: () => true });
    const ac = new AbortController();
    const j = job(r, 'background', { signal: ac.signal });
    await tick();
    const tagged = Object.assign(new Error('undici aborted'), { aborted: true });
    ac.abort();
    j.fail(tagged);
    await expect(j.result).rejects.toBe(tagged);
    expect(j.attempts).toBe(1);
    expect(r.stats().active).toBe(0);
  });

  test('an already-aborted signal is refused before taking a slot; fn never runs', async () => {
    const r = mkRunner();
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    await expect(r.run(async () => { ran = true; }, { lane: 'interactive', signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(ran).toBe(false);
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('a signal that aborts between dequeue and start does not run fn', async () => {
    const r = mkRunner({ maxConcurrency: 1, lanes: { reserve: 0, maxQueue: { interactive: 4, background: 4 }, retryAfterMs: 1000 } });
    const a = job(r, 'interactive');
    await tick();
    const ac = new AbortController();
    let ran = false;
    const q = r.run(async () => { ran = true; }, { lane: 'interactive', signal: ac.signal });
    q.catch(() => {});
    await tick();
    // Release a and abort q in the same synchronous turn: q is dequeued (slot handed over) but must
    // notice the abort before calling fn — and still release the slot it was handed.
    a.finish();
    ac.abort();
    await expect(q).rejects.toMatchObject({ code: 'aborted' });
    expect(ran).toBe(false);
    await a.result;
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('a signal that never fires leaves the queued waiter untouched and is cleaned up on dequeue', async () => {
    const r = mkRunner({ maxConcurrency: 1, lanes: { reserve: 0, maxQueue: { interactive: 4, background: 4 }, retryAfterMs: 1000 } });
    const a = job(r, 'interactive');
    await tick();
    const ac = new AbortController();
    const q = job(r, 'interactive', { signal: ac.signal });
    await tick();
    a.finish();
    await a.result;
    await tick();
    expect(q.started).toBe(true);
    q.finish();
    await expect(q.result).resolves.toBeUndefined();
    ac.abort();   // after the fact: nothing to reject, nothing to remove, no throw
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });
});

describe('retry keeps the slot (unchanged from the FIFO runner)', () => {
  test('the slot is held during backoff, so a waiter does not start until the retrying call is done', async () => {
    const r = mkRunner({ maxConcurrency: 1, maxRetries: 1, isRetryable: () => true, retryBaseMs: 1,
      lanes: { reserve: 0, maxQueue: { interactive: 4, background: 4 }, retryAfterMs: 1000 } });
    let attempts = 0;
    const p1 = r.run(async () => { attempts++; if (attempts === 1) throw new Error('flaky'); return 'ok'; }, { lane: 'interactive' });
    await tick();
    const j2 = job(r, 'interactive');
    await tick();
    expect(attempts).toBe(1);
    expect(j2.started).toBe(false);   // p1 is in backoff and still holds the only slot
    expect(r.stats()).toMatchObject({ active: 1, queued: 1 });

    await expect(p1).resolves.toBe('ok');
    await tick();
    expect(j2.started).toBe(true);
    j2.finish();
    await j2.result;
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('onRetry fires with (err, attempt, retryAfter) as before', async () => {
    const onRetry = jest.fn();
    const r = mkRunner({ maxRetries: 2, isRetryable: () => true, retryAfterMs: () => 1, onRetry });
    let n = 0;
    await expect(r.run(async () => { if (n++ < 2) throw new Error('again'); return n; }, { lane: 'background' })).resolves.toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]).toEqual([expect.any(Error), 0, 1]);
  });

  test('abort DURING the backoff ends the wait at once: AbortError, no further attempt, the slot goes to the next waiter', async () => {
    // A backoff that would otherwise hold the only slot for ~20s (base is capped at 20s, plus jitter).
    const r = mkRunner({ maxConcurrency: 1, maxRetries: 3, isRetryable: () => true, retryBaseMs: 60000,
      lanes: { reserve: 0, maxQueue: { interactive: 4, background: 4 }, retryAfterMs: 1000 } });
    const ac = new AbortController();
    let attempts = 0;
    const p1 = r.run(async () => { attempts++; throw new Error('flaky'); }, { lane: 'interactive', signal: ac.signal });
    p1.catch(() => {});
    await tick();
    expect(attempts).toBe(1);
    expect(r.stats()).toMatchObject({ active: 1, queued: 0 });   // in backoff, slot held
    const j2 = job(r, 'interactive');
    await tick();
    expect(j2.started).toBe(false);                               // …so the waiter cannot start

    const t0 = Date.now();
    ac.abort();                                                   // the physician closes the tab mid-backoff
    const outcome = await Promise.race([p1.catch((e) => e), new Promise((res) => setTimeout(() => res('STILL WAITING'), 1500))]);
    expect(outcome).toMatchObject({ code: 'aborted', aborted: true, lane: 'interactive' });
    expect(Date.now() - t0).toBeLessThan(1000);                   // the backoff was cut short, not waited out
    expect(attempts).toBe(1);                                     // no attempt against a caller who has gone
    await tick();
    expect(j2.started).toBe(true);                                // the slot was handed on promptly
    j2.finish();
    await j2.result;
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });
});

describe('stats() shape and configuration guards', () => {
  test('stats() keeps the legacy fields and adds both lanes', () => {
    const r = mkRunner();
    expect(r.stats()).toEqual({
      provider: 'test', active: 0, queued: 0, maxConcurrency: 2,
      // Added 2026-09-05: the last OUTCOME, so a readiness probe can tell "cannot serve" from
      // "idle" without spending a token. Null here because nothing has run.
      lastOk: null, lastError: null,
      lanes: {
        interactive: { active: 0, queued: 0, maxQueue: 4 },
        background: { active: 0, queued: 0, maxQueue: 2, maxActive: 1 },
      },
    });
  });

  test('queued (top level) is the total across lanes — what shadow.js sheds on', async () => {
    const r = mkRunner();
    const running = [job(r, 'background'), job(r, 'interactive')];
    const waiting = [job(r, 'background'), job(r, 'interactive'), job(r, 'interactive')];
    await tick();
    expect(r.stats().queued).toBe(3);
    expect(r.stats().lanes.background.queued + r.stats().lanes.interactive.queued).toBe(3);
    // Open every gate first, then drain: freed slots go to the interactive waiters before the queued
    // background one, so finishing them one at a time in arrival order would wait on itself.
    const all = [...running, ...waiting];
    all.forEach((j) => j.finish());
    await Promise.all(all.map((j) => j.result));
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('reserve at or above maxConcurrency is rejected at creation (background could never start)', () => {
    expect(() => mkRunner({ maxConcurrency: 2, lanes: { reserve: 2, maxQueue: { interactive: 1, background: 1 }, retryAfterMs: 1 } }))
      .toThrow(/lanes\.reserve \(2\) must be below maxConcurrency \(2\)/);
  });

  test('an unknown lane is a TypeError, not a silent lane', async () => {
    const r = mkRunner();
    await expect(r.run(async () => 'x', { lane: 'interactve' })).rejects.toThrow(/unknown lane "interactve"/);
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test('lane defaults to background when run() is given no options', async () => {
    const r = mkRunner();                // background maxActive = 1
    const b = job(r, 'background');
    await tick();
    const p = r.run(async () => 'bg');   // no options at all
    await tick();
    expect(r.stats().lanes.background.queued).toBe(1);   // held by the background cap → it must be background
    b.finish();
    await b.result;
    await expect(p).resolves.toBe('bg');
  });
});

describe('without `lanes` the runner is the original FIFO', () => {
  const fifo = (over = {}) => createRunner({ name: 'fifo', maxConcurrency: 2, maxRetries: 0, retryBaseMs: 1, isRetryable: () => false, ...over });

  test('strict arrival order, one-argument run(fn), no `lanes` in stats', async () => {
    const r = fifo();
    const gates = [deferred(), deferred(), deferred()];
    const order = [];
    const runs = gates.map((g, i) => r.run(async (attempt) => { order.push(i); expect(attempt).toBe(0); return g.promise; }));
    await tick();
    expect(order).toEqual([0, 1]);
    expect(r.stats()).toEqual({ provider: 'fifo', active: 2, queued: 1, maxConcurrency: 2, lastOk: null, lastError: null });

    gates[0].resolve();
    await runs[0];
    await tick();
    expect(order).toEqual([0, 1, 2]);   // the slot is handed straight to the next waiter
    gates[1].resolve(); gates[2].resolve();
    await Promise.all(runs);
    expect(r.stats()).toEqual({ provider: 'fifo', active: 0, queued: 0, maxConcurrency: 2, lastOk: expect.any(Number), lastError: null });
  });

  test('a lane option is accepted and ignored — still FIFO, no reserve, no depth limit', async () => {
    const r = fifo({ maxConcurrency: 1 });
    const first = deferred();
    const order = [];
    const p0 = r.run(async () => { order.push('bg0'); return first.promise; }, { lane: 'background' });
    const p1 = r.run(async () => { order.push('bg1'); }, { lane: 'background' });
    const p2 = r.run(async () => { order.push('int'); }, { lane: 'interactive' });
    const extra = Array.from({ length: 50 }, (_, i) => r.run(async () => i, { lane: 'background' }));
    await tick();
    expect(r.stats().queued).toBe(52);   // nothing refused
    first.resolve();
    await Promise.all([p0, p1, p2, ...extra]);
    expect(order).toEqual(['bg0', 'bg1', 'int']);   // arrival order, the interactive did NOT jump
  });

  test('fn still receives the signal, and an in-flight abort is not retried (shared retry loop)', async () => {
    const r = fifo({ maxRetries: 3, isRetryable: () => true });
    const ac = new AbortController();
    let attempts = 0;
    const p = r.run(async (_a, signal) => { attempts++; expect(signal).toBe(ac.signal); ac.abort(); throw new Error('boom'); }, { signal: ac.signal });
    await expect(p).rejects.toMatchObject({ code: 'aborted', aborted: true });
    expect(attempts).toBe(1);
    expect(r.stats()).toMatchObject({ active: 0, queued: 0 });
  });
});
