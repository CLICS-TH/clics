// Booth Mode (#211): POST /chat with booth_mode answers a conference-kiosk demo turn. HERMETIC: callAI and
// the capability queries are mocked at the seam; RAG and Supabase stubbed.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn(),
  providerSupportsThinking: jest.fn(),
  supportsThinking: jest.fn(),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn() }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, providerSupportsThinking, supportsThinking } = require('../src/services/ai');
const { ragLookup } = require('../src/services/rag');
const { QueueFullError } = require('../src/services/providers/runtime');
const P = require('../src/lib/prompts');
const { BOOTH_MAX_TOKENS, CHAT_MAX_TOKENS } = require('../src/lib/turn-limits');

const BOOTH_PROMPT = P.chatSystemPrompt({ booth: true });
const r = (text, extra = {}) => ({ text, tokenCount: 20, inputTokens: 12, outputTokens: 8, provider: 'local-tutor', model: 'qwen-tutor', ...extra });
const send = (body = {}) => request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'I would order an ECG first.', language: 'en', ...body });
const call = (n) => callAI.mock.calls[n][0];
const chatCalls = () => callAI.mock.calls.map(([c]) => c).filter((c) => c.purpose === 'chat');

const FIVE_EXCHANGES = Array.from({ length: 5 }, (_, i) => [
  { role: 'physician', content: `ขั้นที่ ${i + 1}: เลือกตรวจ ECG` },
  { role: 'assistant', content: 'ECG ช่วยแยก STEMI ได้เร็ว' },
]).flat();

// The adversarial suite's identifiers (pii-leak-adversarial.test.js), one per field a booth turn carries.
const RAW = { name: 'สมชาย ใจดี', hn: '12345678', phone: '081-234-5678', cid: '1234567890123' };
const PII_TURN = {
  language: 'th',
  patient_ref: RAW.name,
  chief_complaint: `นาย${RAW.name} อายุ 54 ปี เจ็บหน้าอก 2 ชั่วโมง`,
  history: [
    { role: 'physician', content: `ผู้ป่วย HN ${RAW.hn} โทร ${RAW.phone} เลือกตรวจ ECG` },
    { role: 'assistant', content: 'ECG ช่วยแยก STEMI ได้เร็ว' },
  ],
  message: `สมชาย บัตรประชาชน ${RAW.cid} ควรให้ aspirin เลยไหม`,
};
const LEAKS = ['สมชาย', 'ใจดี', RAW.hn, RAW.phone, '5678', RAW.cid];

let warn, error;
beforeEach(() => {
  callAI.mockReset();
  providerSupportsThinking.mockReset().mockResolvedValue(true);
  supportsThinking.mockReset().mockReturnValue(true);
  ragLookup.mockReset().mockResolvedValue([]);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); error.mockRestore(); });

describe('the request a booth turn sends', () => {
  test('one call, purpose chat, the booth prompt at the booth ceiling, with no provider pin and no thinking', async () => {
    callAI.mockResolvedValue(r('An ECG first is reasonable: it can show STEMI within minutes.'));
    const res = await send({ booth_mode: true });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0)).toMatchObject({ purpose: 'chat', systemPrompt: BOOTH_PROMPT, maxTokens: BOOTH_MAX_TOKENS });
    expect(call(0)).not.toHaveProperty('provider');
    expect(call(0)).not.toHaveProperty('thinking');
  });

  test('the prompt sent carries the three-sentence rule and the never-name-the-best-option rule', async () => {
    callAI.mockResolvedValue(r('Reasonable.'));
    await send({ booth_mode: true });
    expect(call(0).systemPrompt).toMatch(/At most THREE short sentences/);
    expect(call(0).systemPrompt).toMatch(/Never say or hint which option is best, correct or preferred, for this step or any other step/);
  });

  test('every PLE flag is ignored: no rescue classifier, no router, no retry, even for an uncited English reply to Thai', async () => {
    callAI.mockResolvedValue(r('An ECG first is reasonable.'));
    const res = await send({
      booth_mode: true, language: 'th', message: 'ขั้นที่ 6: เลือกให้ aspirin ทันที', history: FIVE_EXCHANGES,
      socratic: true, artifacts: true, evidence_marker: true, router_enabled: true, deep_mode: true,
      rescue_active: true, rescue_rounds: 0,
    });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0)).toMatchObject({ purpose: 'chat', systemPrompt: BOOTH_PROMPT, maxTokens: BOOTH_MAX_TOKENS });
    expect(call(0)).not.toHaveProperty('thinking');
    expect(res.body.content).toBe('An ECG first is reasonable.');
  });

  test('artifact and evidence guidance switched on for the session never reach the booth prompt', async () => {
    callAI.mockResolvedValue(r('Reasonable (ESC, 2023).\n❓ Why?'));
    await send({ artifacts: true, evidence_marker: true });
    expect(chatCalls()[0].systemPrompt).toContain(P.ARTIFACT_GUIDANCE.trim());   // the flags are live on a PLE turn
    callAI.mockClear();
    await send({ booth_mode: true, artifacts: true, evidence_marker: true, socratic: true });
    const sys = call(0).systemPrompt;
    for (const guidance of [P.ARTIFACT_GUIDANCE, P.EVIDENCE_GUIDANCE.natural, P.EVIDENCE_GUIDANCE.examiner]) {
      expect(sys).not.toContain(guidance.trim());
    }
    expect(sys).not.toContain(':::artifact');
  });

  test('no RAG lookup (a PLE turn makes one)', async () => {
    callAI.mockResolvedValue(r('Reasonable (ESC, 2023).'));
    await send();
    expect(ragLookup).toHaveBeenCalledTimes(1);
    ragLookup.mockClear();
    await send({ booth_mode: true });
    expect(ragLookup).not.toHaveBeenCalled();
  });
});

describe('the reply a booth turn returns', () => {
  test('an artifact the model writes anyway opens no side panel: no fence line survives', async () => {
    callAI.mockResolvedValue(r('ECG first.\n:::artifact{type="differential" title="x"}\n| STEMI | NSTEMI |\n:::\nGood reasoning.'));
    const res = await send({ booth_mode: true, artifacts: true });
    expect(res.body.content).not.toContain(':::artifact');
    expect(res.body.content).not.toMatch(/^:::[ \t]*$/m);
  });

  test('no reference chips, even for a cited reply (a PLE turn extracts them)', async () => {
    callAI.mockResolvedValue(r('Do an ECG within ten minutes (ESC ACS, 2023).'));
    const ple = await send();
    expect(ple.body.refs).not.toEqual([]);
    const booth = await send({ booth_mode: true });
    expect(booth.body.refs).toEqual([]);
  });

  test('always plain JSON with exactly the documented keys, even when the caller asks for a stream', async () => {
    callAI.mockResolvedValue(r('Reasonable.', { failed_over_from: 'anthropic' }));
    const res = await send({ booth_mode: true, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      content: 'Reasonable.', refs: [], token_count: 20, input_tokens: 12, output_tokens: 8,
      provider: 'local-tutor', model: 'qwen-tutor', prompt_version: expect.stringMatching(/^chat-prompt-[0-9a-f]{8}$/),
      failed_over_from: 'anthropic',
    });
  });

  test.each([
    ['503 queue_full', () => new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 }), 503],
    ['500 provider failure', () => Object.assign(new Error('provider down'), { status: 500 }), 500],
  ])('%s: the same status, headers and body a PLE turn returns', async (_label, makeErr, status) => {
    callAI.mockRejectedValueOnce(makeErr());
    const ple = await send();
    callAI.mockRejectedValueOnce(makeErr());
    const booth = await send({ booth_mode: true, stream: true });
    expect(booth.status).toBe(status);
    expect(booth.status).toBe(ple.status);
    expect(booth.headers['retry-after']).toBe(ple.headers['retry-after']);
    expect(booth.body).toEqual(ple.body);
  });
});

describe('de-identification is the PLE path\'s', () => {
  test('no identifier from the chief complaint, history, message or patient_ref reaches the model', async () => {
    callAI.mockResolvedValue(r('ควรตรวจ ECG ก่อน'));
    await send({ ...PII_TURN, booth_mode: true });
    const wire = JSON.stringify(callAI.mock.calls);
    for (const leak of LEAKS) expect(wire).not.toContain(leak);
    for (const token of ['[NAME-1]', '[NAME-2]', '[HN-1]', '[PHONE-1]', '[ID-1]']) expect(wire).toContain(token);
  });

  test('a booth turn sends the model exactly the messages a PLE turn sends for the same input', async () => {
    callAI.mockResolvedValue(r('ควรตรวจ ECG ก่อน (ESC, 2023)'));
    await send(PII_TURN);
    const ple = chatCalls()[0].messages;
    callAI.mockClear();
    await send({ ...PII_TURN, booth_mode: true });
    expect(call(0).messages).toEqual(ple);
  });
});

test('without booth_mode the turn is a PLE turn: the mode prompt at the chat ceiling', async () => {
  callAI.mockResolvedValue(r('Reasonable (ESC, 2023).'));
  for (const body of [{}, { booth_mode: false }]) {
    callAI.mockClear();
    const res = await send(body);
    expect(res.status).toBe(200);
    expect(call(0)).toMatchObject({ purpose: 'chat', systemPrompt: P.chatSystemPrompt({}), maxTokens: CHAT_MAX_TOKENS });
  }
});
