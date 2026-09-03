// CHAT_FAILOVER_PROVIDER — the DORMANT chat fail-over hook in services/ai.js.
//
// HERMETIC: both providers are mocked at the module boundary; no key, no socket, no database
// (credentials are cleared so provider-settings is inert and env decides).
//
// The contract, in the order it matters:
//   1. UNSET (how it ships) changes nothing: a primary error propagates as the same object, and the
//      other provider is never called. CREC decision pending — research transcripts must not fall
//      back to a cloud model without an ethics amendment.
//   2. Set, purpose `chat`, primary DOWN (connection refused / reset / unresolvable, our own deadline,
//      HTTP 5xx) → exactly one more call, on the fail-over provider, with the IDENTICAL de-identified
//      request; the result names the provider that answered and the one that did not.
//   3. NEVER on queue_full (our own lane bound), aborted (nobody is waiting), 413 / any 4xx (the
//      request is the problem), a config error (a misconfigured box must stay loud), for
//      evaluate / criteria / discuss / shadow, or on a pinned call (one turn, one model).

const mockAnthropic = {
  name: 'anthropic',
  call: jest.fn(),
  model: jest.fn(() => 'claude-sonnet-4-6'),
  ready: jest.fn(() => ({ checks: { anthropic_key: { status: 'up' } } })),
  stats: jest.fn(() => ({ provider: 'anthropic', active: 0, queued: 0 })),
};
const mockLocal = {
  name: 'local',
  call: jest.fn(),
  model: jest.fn(() => 'qwen3-32b-medical'),
  ready: jest.fn(async () => ({ checks: { local_ai: { status: 'up' } } })),
  stats: jest.fn(() => ({ provider: 'local', active: 0, queued: 0 })),
};
jest.mock('../src/services/providers/anthropic', () => mockAnthropic);
jest.mock('../src/services/providers/local', () => mockLocal);

const ai = require('../src/services/ai');
const { QueueFullError, AbortError } = require('../src/services/providers/runtime');

const ENV = ['AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA', 'AI_PROVIDER_DISCUSS',
  'CHAT_FAILOVER_PROVIDER', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
let savedEnv;
let warnSpy;

const A = { text: 'A', inputTokens: 1, outputTokens: 2, tokenCount: 3, stopReason: 'end_turn', model: 'claude-sonnet-4-6' };
const L = { text: 'L', inputTokens: 10, outputTokens: 20, tokenCount: 30, stopReason: 'end_turn', model: 'qwen3-32b-medical' };

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.AI_PROVIDER = 'local';              // the primary for every purpose, unless a test says otherwise
  jest.clearAllMocks();                           // ready()/stats() call counts must not carry across tests
  mockAnthropic.call.mockReset().mockImplementation(async () => ({ ...A }));
  mockLocal.call.mockReset().mockImplementation(async () => ({ ...L }));
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const args = (purpose) => ({ purpose, systemPrompt: 'sys', messages: [{ role: 'user', content: 'de-identified text' }], maxTokens: 900 });

// Stands in for a server body that might quote the prompt. It must never appear in the log line.
const SENTINEL = 'SENTINEL-NEVER-LOGGED';
// The shapes providers/local.js actually produces (see its httpJson / isRetryable):
const withCause = (code) => Object.assign(new TypeError('fetch failed'),
  { cause: Object.assign(new Error(`connect ${code} 100.64.0.1:8000 ${SENTINEL}`), { code, syscall: 'connect' }) });
const direct = (code) => Object.assign(new Error(`read ${code} ${SENTINEL}`), { code });
const deadline = () => Object.assign(new DOMException(`The operation was aborted due to timeout ${SENTINEL}`, 'TimeoutError'), { localTimeout: true });
const untaggedTimeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const http = (status) => Object.assign(new Error(`local AI ${status} Error: ${SENTINEL}`), { status, headers: new Headers() });
const queueFull = () => new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 });
const aborted = () => new AbortError('interactive', new Error('client disconnected before the response was sent'));
const tooLarge = () => Object.assign(new Error(`local AI request refused before send ${SENTINEL}`),
  { status: 413, code: 'transcript_too_large', contextTooSmall: true, est_tokens: 99999, limit: 32000 });
const contextTooSmall = () => Object.assign(new Error(`local AI 400 Bad Request: exceeds the available context size (4096) ${SENTINEL}`),
  { status: 400, code: 'transcript_too_large', contextTooSmall: true, est_tokens: 9144, limit: null });
const misconfig = () => new Error('LOCAL_AI_BASE_URL is not set (AI_PROVIDER=local requires it)');
const opaque = () => new Error(`something unexpected ${SENTINEL}`);

// [label, factory, the class token the log line must carry]
const DOWN = [
  ['ECONNREFUSED on fetch\'s .cause (Node fetch shape)', () => withCause('ECONNREFUSED'), 'ECONNREFUSED'],
  ['ECONNRESET directly on the error', () => direct('ECONNRESET'), 'ECONNRESET'],
  ['ENOTFOUND (DNS) on .cause', () => withCause('ENOTFOUND'), 'ENOTFOUND'],
  ['EHOSTUNREACH on .cause', () => withCause('EHOSTUNREACH'), 'EHOSTUNREACH'],
  ['our own deadline — TimeoutError tagged localTimeout by providers/local.js', deadline, 'timeout'],
  ['a bare TimeoutError (untagged)', untaggedTimeout, 'timeout'],
  ['HTTP 500 from the provider', () => http(500), 'HTTP 500'],
  ['HTTP 502 from the provider', () => http(502), 'HTTP 502'],
  ['HTTP 503 from the PROVIDER (not our queue_full)', () => http(503), 'HTTP 503'],
  ['HTTP 504 from the provider', () => http(504), 'HTTP 504'],
  ['HTTP 529 overloaded', () => http(529), 'HTTP 529'],
];
const NEVER = [
  ['queue_full — our own lane bound (a 503, but not a dead provider)', queueFull],
  ['aborted — the caller hung up', aborted],
  ['413 transcript_too_large — cannot shrink by changing vendor', tooLarge],
  ['400 context-too-small (same vocabulary, different status)', contextTooSmall],
  ['HTTP 400', () => http(400)],
  ['HTTP 401', () => http(401)],
  ['HTTP 404', () => http(404)],
  ['HTTP 429 (after the runner\'s own retries)', () => http(429)],
  ['a configuration error — a misconfigured box must stay loud', misconfig],
  ['an opaque error with no status and no code', opaque],
  ['an unrelated code (ERR_INVALID_ARG_TYPE)', () => direct('ERR_INVALID_ARG_TYPE')],
];

// ---------------------------------------------------------------------------
describe('dormant — CHAT_FAILOVER_PROVIDER unset (how it ships)', () => {
  test.each(DOWN)('%s → the primary error propagates unchanged; the other provider is never called', async (_label, makeErr) => {
    const err = makeErr();
    mockLocal.call.mockRejectedValueOnce(err);
    await expect(ai.callAI(args('chat'))).rejects.toBe(err);
    expect(mockLocal.call).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('an empty / whitespace value is unset', async () => {
    process.env.CHAT_FAILOVER_PROVIDER = '   ';
    const err = withCause('ECONNREFUSED');
    mockLocal.call.mockRejectedValueOnce(err);
    await expect(ai.callAI(args('chat'))).rejects.toBe(err);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
  });

  test('a successful call carries no failed_over_from key', async () => {
    const r = await ai.callAI(args('chat'));
    expect(r).toEqual({ ...L, provider: 'local' });
    expect(r).not.toHaveProperty('failed_over_from');
  });
});

// ---------------------------------------------------------------------------
describe('armed — CHAT_FAILOVER_PROVIDER=anthropic, chat primary local', () => {
  beforeEach(() => { process.env.CHAT_FAILOVER_PROVIDER = 'anthropic'; });

  test.each(DOWN)('%s → ONE retry on the fail-over provider; the result is marked; one log line, names only', async (_label, makeErr, reason) => {
    mockLocal.call.mockRejectedValueOnce(makeErr());

    const r = await ai.callAI(args('chat'));

    expect(r).toEqual({ ...A, provider: 'anthropic', failed_over_from: 'local' });
    expect(mockLocal.call).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.call).toHaveBeenCalledTimes(1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0];
    expect(line).toMatch(/chat fail-over/);
    expect(line).toContain('"local"');
    expect(line).toContain('"anthropic"');
    expect(line).toContain(reason);
    expect(line).not.toContain(SENTINEL);           // never the message — it may quote the server body
  });

  test.each(NEVER)('%s → propagates as the same object; no second call; no log line', async (_label, makeErr) => {
    const err = makeErr();
    mockLocal.call.mockRejectedValueOnce(err);
    await expect(ai.callAI(args('chat'))).rejects.toBe(err);
    expect(mockLocal.call).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('the fail-over provider receives the IDENTICAL request the primary received (same messages reference, same signal)', async () => {
    const ac = new AbortController();
    const messages = [{ role: 'user', content: 'de-identified text' }];
    mockLocal.call.mockRejectedValueOnce(withCause('ECONNREFUSED'));

    await ai.callAI({ purpose: 'chat', systemPrompt: 'sys', messages, maxTokens: 900, temperature: 0.3, signal: ac.signal });

    const toPrimary = mockLocal.call.mock.calls[0][0];
    const toFailover = mockAnthropic.call.mock.calls[0][0];
    expect(toFailover).toEqual(toPrimary);
    expect(toFailover).toEqual({ systemPrompt: 'sys', messages, maxTokens: 900, temperature: 0.3, purpose: 'chat', signal: ac.signal });
    expect(toFailover.messages).toBe(messages);   // the same array — nothing was rebuilt
    expect(toFailover.signal).toBe(ac.signal);
  });

  test('a healthy primary is a single call and carries no marker', async () => {
    const r = await ai.callAI(args('chat'));
    expect(r).toEqual({ ...L, provider: 'local' });
    expect(r).not.toHaveProperty('failed_over_from');
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('when the fail-over provider ALSO fails, its error propagates — no third call, nothing swallowed', async () => {
    const second = http(500);
    mockLocal.call.mockRejectedValueOnce(withCause('ECONNREFUSED'));
    mockAnthropic.call.mockRejectedValueOnce(second);

    await expect(ai.callAI(args('chat'))).rejects.toBe(second);
    expect(mockLocal.call).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.call).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('the model reported is the one the fail-over provider RESULT carried (§10.2 provenance)', async () => {
    mockLocal.call.mockRejectedValueOnce(http(503));
    mockAnthropic.call.mockResolvedValueOnce({ ...A, model: 'claude-sonnet-4-6-20260901' });
    const r = await ai.callAI(args('chat'));
    expect(r.model).toBe('claude-sonnet-4-6-20260901');
    expect(r.provider).toBe('anthropic');
    expect(r.failed_over_from).toBe('local');
  });
});

// ---------------------------------------------------------------------------
describe('scope — chat only, the resolved (not pinned) path only', () => {
  beforeEach(() => { process.env.CHAT_FAILOVER_PROVIDER = 'anthropic'; });

  test.each(['evaluate', 'criteria', 'discuss'])('%s + primary down → no fail-over (P5: evaluate never fails over)', async (purpose) => {
    const err = withCause('ECONNREFUSED');
    mockLocal.call.mockRejectedValueOnce(err);
    await expect(ai.callAI(args(purpose))).rejects.toBe(err);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('callProvider (the shadow evaluator, purpose "shadow") never fails over', async () => {
    const err = http(503);
    mockLocal.call.mockRejectedValueOnce(err);
    await expect(ai.callProvider({ provider: 'local', purpose: 'shadow', systemPrompt: 's', messages: [], maxTokens: 10 })).rejects.toBe(err);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
  });

  test('a purposeless call never fails over', async () => {
    const err = withCause('ECONNREFUSED');
    mockLocal.call.mockRejectedValueOnce(err);
    await expect(ai.callAI({ systemPrompt: 's', messages: [] })).rejects.toBe(err);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
  });

  test('a PINNED chat call never fails over — one physician turn, one model (routes/chat.js citation retry)', async () => {
    const err = withCause('ECONNREFUSED');
    mockLocal.call.mockRejectedValueOnce(err);
    await expect(ai.callAI({ ...args('chat'), provider: 'local' })).rejects.toBe(err);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('a fail-over target equal to the primary is a no-op (anthropic → anthropic)', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    const err = http(503);
    mockAnthropic.call.mockRejectedValueOnce(err);
    await expect(ai.callAI(args('chat'))).rejects.toBe(err);
    expect(mockAnthropic.call).toHaveBeenCalledTimes(1);
    expect(mockLocal.call).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('an unknown fail-over name throws on the FIRST chat turn, with the primary healthy, naming the variable', async () => {
    process.env.CHAT_FAILOVER_PROVIDER = 'antropic';
    await expect(ai.callAI(args('chat'))).rejects.toThrow(/Unknown AI provider "antropic" \(from CHAT_FAILOVER_PROVIDER\)/);
    expect(mockLocal.call).not.toHaveBeenCalled();     // surfaced before the outage, not during it
    expect(mockAnthropic.call).not.toHaveBeenCalled();
  });

  test('…and that typo leaves every other purpose untouched', async () => {
    process.env.CHAT_FAILOVER_PROVIDER = 'antropic';
    expect((await ai.callAI(args('evaluate'))).provider).toBe('local');
    expect((await ai.callAI(args('criteria'))).provider).toBe('local');
  });

  test('readiness() probes the fail-over provider too — a missing key is visible in /health/deep BEFORE the outage', async () => {
    expect(ai.activeProviders()).toEqual(['local']);         // routing and the `providers` report are unchanged…
    const checks = await ai.readiness();
    expect(mockLocal.ready).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.ready).toHaveBeenCalledTimes(1);    // …but the target IS probed
    expect(checks).toMatchObject({ local_ai: { status: 'up' }, anthropic_key: { status: 'up' } });
  });

  test('readiness(): a fail-over target that is also the active provider is probed once', async () => {
    process.env.AI_PROVIDER = 'anthropic';
    await ai.readiness();
    expect(mockAnthropic.ready).toHaveBeenCalledTimes(1);
    expect(mockLocal.ready).not.toHaveBeenCalled();
  });

  test('readiness(): an unknown fail-over name is a down check, not a throw', async () => {
    process.env.CHAT_FAILOVER_PROVIDER = 'antropic';
    const checks = await ai.readiness();
    expect(checks.antropic_provider).toEqual({ status: 'down', error: 'unknown provider "antropic"' });
    expect(checks.local_ai).toEqual({ status: 'up' });
  });

  test('readiness(): with the hook dormant only the active providers are probed (unchanged)', async () => {
    delete process.env.CHAT_FAILOVER_PROVIDER;
    await ai.readiness();
    expect(mockLocal.ready).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.ready).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('isProviderDown — the DOWN class, as a table', () => {
  test.each(DOWN)('%s is DOWN', (_label, makeErr) => {
    expect(ai.isProviderDown(makeErr())).toBe(true);
  });

  test.each(NEVER)('%s is NOT down', (_label, makeErr) => {
    expect(ai.isProviderDown(makeErr())).toBe(false);
  });

  test('null / undefined are not down', () => {
    expect(ai.isProviderDown(null)).toBe(false);
    expect(ai.isProviderDown(undefined)).toBe(false);
  });

  test('a 5xx that is ALSO tagged aborted is not down — the caller is gone', () => {
    expect(ai.isProviderDown(Object.assign(http(503), { aborted: true }))).toBe(false);
  });

  test('a runtime AbortError wrapping a connection error is not down', () => {
    expect(ai.isProviderDown(new AbortError('interactive', withCause('ECONNREFUSED')))).toBe(false);
  });

  test('the code is found through an SDK-style wrapper (error → fetch failed → ECONNREFUSED)', () => {
    const sdkShaped = Object.assign(new Error('Connection error.'), { cause: withCause('ECONNREFUSED') });
    expect(ai.isProviderDown(sdkShaped)).toBe(true);
  });
});
