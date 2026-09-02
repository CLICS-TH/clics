// ADVERSARIAL — the chat fail-over hook (services/ai.js, CHAT_FAILOVER_PROVIDER) is a SECOND
// model-call surface: when the primary is down the request goes to another provider. Prove that what
// reaches that provider is the de-identified payload — the very object the primary received — and
// never the raw transcript, the patient_ref, or an identifier; and that the one log line it writes
// carries provider names only, even when the provider's error message quotes the prompt.
//
// Drives the REAL /chat route and the REAL services/ai.js against a PII-laden turn. Only the two
// providers, RAG and Supabase are mocked (hermetic: no key, no socket). The primary (local) rejects
// with connection-refused; the fail-over (anthropic) records exactly what it was handed.
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
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
// src/index.js runs dotenv.config(), so a developer rimpl/.env may supply Supabase credentials and the
// provider-settings layer would then read app_settings through this mock. No rows → env decides.
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        in: jest.fn(async () => ({ data: [], error: null })),
        limit: jest.fn(async () => ({ count: 1, error: null })),
      })),
    })),
    rpc: jest.fn().mockResolvedValue({ data: [], error: null }),
  },
}));

const ENV = ['AI_PROVIDER', 'AI_PROVIDER_CHAT', 'AI_PROVIDER_EVALUATE', 'AI_PROVIDER_CRITERIA', 'AI_PROVIDER_DISCUSS',
  'CHAT_FAILOVER_PROVIDER', 'PROVIDER_SETTINGS_SOURCE', 'SHADOW_EVAL_PROVIDER'];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

const request = require('supertest');
const app = require('../src/index');

const RAW = {
  name: 'สมชาย ใจดี', hn: 'HN 12345678', phone: '081-234-5678', cid: '1234567890123',
  email: 'somchai.j@hospital.go.th', clinical: 'มาด้วยอาการเจ็บหน้าอก 2 ชั่วโมง troponin 0.04',
};
const line = `ผู้ป่วยชื่อ ${RAW.name} ${RAW.hn} โทร ${RAW.phone} บัตร ${RAW.cid} email ${RAW.email} ${RAW.clinical}`;
const history = [{ role: 'physician', content: line }, { role: 'assistant', content: 'ขอข้อมูลเพิ่มเติม' }];
const LEAKS = ['สมชาย', 'ใจดี', '12345678', '081-234-5678', '5678', RAW.cid, RAW.email, 'somchai'];

// The adversarial worst case: the primary's error message quotes the prompt.
const connRefused = () => Object.assign(new TypeError('fetch failed'),
  { cause: Object.assign(new Error(`connect ECONNREFUSED 100.64.0.1:8000 while sending: ${line}`), { code: 'ECONNREFUSED' }) });
// A reply WITH a (Source, Year) citation, so routes/chat.js's citation retry does not fire.
const REPLY = { text: 'ควรตรวจ troponin ซ้ำที่ 3 ชั่วโมง (ESC, 2023).', inputTokens: 100, outputTokens: 20, tokenCount: 120, stopReason: 'end_turn', model: 'claude-sonnet-4-6' };

const body = () => ({ ple_id: 'x', history, message: line, language: 'th', patient_ref: RAW.name });
const noLeak = (text) => { for (const frag of LEAKS) expect(text).not.toContain(frag); };

let warnSpy, errSpy;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.AI_PROVIDER_CHAT = 'local';          // the smoke's shape: chat on the box…
  process.env.CHAT_FAILOVER_PROVIDER = 'anthropic'; // …with the cloud as the fail-over
  mockLocal.call.mockReset().mockResolvedValue({ ...REPLY, model: 'qwen3-32b-medical' });
  mockAnthropic.call.mockReset().mockResolvedValue({ ...REPLY });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warnSpy.mockRestore(); errSpy.mockRestore(); });

describe('adversarial — the chat fail-over hands the SECOND provider the de-identified payload, never the raw one', () => {
  test('primary down → the fail-over provider sees no identifier, and exactly the object the primary saw', async () => {
    mockLocal.call.mockRejectedValueOnce(connRefused());

    const res = await request(app).post('/chat').send(body());

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('anthropic');
    expect(res.body.failed_over_from).toBe('local');
    expect(res.body.context_tokens).toBe(120);   // the fail-over call's own 100 + 20 — the primary never answered
    expect(mockLocal.call).toHaveBeenCalledTimes(1);
    expect(mockAnthropic.call).toHaveBeenCalledTimes(1);

    // What the cloud provider was handed: system prompt, history and the new turn, all de-identified.
    const handed = mockAnthropic.call.mock.calls[0][0];
    const wire = JSON.stringify(handed);
    noLeak(wire);
    expect(wire).not.toContain(RAW.name);
    expect(wire).toContain('เจ็บหน้าอก');           // …while the clinical content survived
    expect(wire).toContain('troponin');
    expect(handed.purpose).toBe('chat');

    // The SAME request object the primary received — not a second, separately built payload.
    const toPrimary = mockLocal.call.mock.calls[0][0];
    expect(handed).toEqual(toPrimary);
    expect(handed.messages).toBe(toPrimary.messages);

    // Nothing on the wire back to the backend either.
    noLeak(JSON.stringify(res.body) + JSON.stringify(res.headers));

    // The one log line: provider names and the error class, never the message that quoted the prompt.
    const failoverLines = warnSpy.mock.calls.map((c) => String(c[0])).filter((l) => /chat fail-over/.test(l));
    expect(failoverLines).toHaveLength(1);
    expect(failoverLines[0]).toContain('"local"');
    expect(failoverLines[0]).toContain('"anthropic"');
    expect(failoverLines[0]).toContain('ECONNREFUSED');
    noLeak(failoverLines[0]);
    expect(failoverLines[0]).not.toContain('เจ็บหน้าอก');
    expect(errSpy).not.toHaveBeenCalled();
  });

  test('dormant (unset): the same outage is a 500 with the generic body — the cloud provider is never called', async () => {
    delete process.env.CHAT_FAILOVER_PROVIDER;
    mockLocal.call.mockRejectedValueOnce(connRefused());

    const res = await request(app).post('/chat').send(body());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'AI service temporarily unavailable. Please try again.' });
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    noLeak(JSON.stringify(res.body) + JSON.stringify(res.headers));
  });

  test('an ordinary turn (primary healthy) carries failed_over_from: null — a stable field for the backend', async () => {
    const res = await request(app).post('/chat').send(body());
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('local');
    expect(res.body.failed_over_from).toBeNull();
    expect(mockAnthropic.call).not.toHaveBeenCalled();
  });

  test('never for /evaluate: PIS-7 scoring with the primary down is a 500, not a cloud call', async () => {
    process.env.AI_PROVIDER = 'local';               // every purpose on the box
    mockLocal.call.mockRejectedValueOnce(connRefused());

    const res = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: history, patient_ref: RAW.name, shadow: false });

    expect(res.status).toBe(500);
    expect(mockAnthropic.call).not.toHaveBeenCalled();
    noLeak(JSON.stringify(res.body) + JSON.stringify(res.headers));
  });
});
