// apiFetch's opt-in timeout: a stalled upstream resolves with a typed envelope instead of hanging
// forever, it never rejects, it never retries, and it leaves calls that did not ask for a timeout alone.
import { apiFetch, REQUEST_TIMEOUT_CODE } from '@/lib/api';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); });

// A fetch that never answers, but honours its abort signal like the real one.
function hangingFetch() {
  const calls: { signal?: AbortSignal }[] = [];
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
    calls.push({ signal: init?.signal ?? undefined });
    return new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe('apiFetch timeoutMs', () => {
  it('aborts at the limit and resolves with a typed timeout envelope (no rejection)', async () => {
    jest.useFakeTimers();
    const calls = hangingFetch();
    const p = apiFetch<{ error?: string; code?: string }>('/x', { method: 'POST', timeoutMs: 130_000 });
    jest.advanceTimersByTime(129_999);
    expect(calls[0].signal?.aborted).toBe(false);          // generous: nothing happens early
    jest.advanceTimersByTime(2);
    await expect(p).resolves.toMatchObject({ code: REQUEST_TIMEOUT_CODE });
    expect((await p).error).toMatch(/หมดเวลา|timed out/);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it('never re-sends: exactly one request is made for a timed-out call', async () => {
    jest.useFakeTimers();
    hangingFetch();
    const p = apiFetch('/x', { timeoutMs: 1000 });
    jest.advanceTimersByTime(60_000);
    await p;
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('a fast answer clears the timer (nothing is aborted later) and returns the body', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    global.fetch = jest.fn(async (_u: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return { status: 200, json: async () => ({ ok: 1 }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(apiFetch('/x', { timeoutMs: 5000 })).resolves.toEqual({ ok: 1 });
    jest.advanceTimersByTime(10_000);
    expect(signal?.aborted).toBe(false);
  });

  it('a network failure is still a plain network envelope, not a timeout', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const r = await apiFetch<{ error?: string; code?: string }>('/x', { timeoutMs: 5000 });
    expect(r.code).toBeUndefined();
    expect(r.error).toMatch(/เครือข่าย|Network/);
  });

  it('without timeoutMs no signal is attached and behaviour is unchanged', async () => {
    let init: RequestInit | undefined;
    global.fetch = jest.fn(async (_u: unknown, i?: RequestInit) => {
      init = i;
      return { status: 200, json: async () => ({ a: 1 }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(apiFetch('/x', { method: 'POST' })).resolves.toEqual({ a: 1 });
    expect(init?.signal).toBeUndefined();
    expect(init?.method).toBe('POST');
    expect(init as Record<string, unknown>).not.toHaveProperty('timeoutMs');
  });
});
