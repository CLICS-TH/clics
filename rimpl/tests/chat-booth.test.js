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
const FIELDS = { strength: 'An ECG first is a strength.', weigh: 'Weigh the timing.', safety: '' };
const NO_REPLY = { strength: '', weigh: '', safety: '' };
const boothJson = (extra = {}) => JSON.stringify({ ...FIELDS, ...extra });
// Every rule line of the plain booth prompt, so a prompt built on it can be shown to keep them all.
const ruleLines = (prompt) => prompt.split('\n').filter((l) => l.startsWith('- '));
// language th: what the backend sends for every booth play in a Thai-primary look, the default.
const send = (body = {}) => request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'I would order an ECG first.', language: 'th', ...body });
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
    callAI.mockResolvedValue(r(boothJson()));
    const res = await send({ booth_mode: true });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0)).toMatchObject({ purpose: 'chat', systemPrompt: BOOTH_PROMPT, maxTokens: BOOTH_MAX_TOKENS });
    expect(call(0)).not.toHaveProperty('provider');
    expect(call(0)).not.toHaveProperty('thinking');
  });

  test('the prompt sent asks for the three fields under their length and bold rules, and keeps the never-name-the-best-option rule', async () => {
    callAI.mockResolvedValue(r(boothJson()));
    await send({ booth_mode: true });
    const sys = call(0).systemPrompt;
    expect(sys).toContain('{"strength": "...", "weigh": "...", "safety": "..."}');
    expect(sys).toMatch(/each at most 80 Thai characters or 20 English words/);
    expect(sys).toMatch(/at most TWO short phrases in \*\*double asterisks\*\*.*only words copied exactly from the physician's own answer/);
    expect(sys).toMatch(/safety: "" unless the chosen or typed action could seriously harm the patient/);
    expect(sys).toMatch(/Never say or hint which option is best, correct or preferred, for this step or any other step/);
    expect(sys).not.toMatch(/THREE short sentences|Plain text only/);
  });

  test('every PLE flag is ignored: no rescue classifier, no router, no retry, even for an uncited English reply to Thai', async () => {
    callAI.mockResolvedValue(r(boothJson()));
    const res = await send({
      booth_mode: true, language: 'th', message: 'ขั้นที่ 6: เลือกให้ aspirin ทันที', history: FIVE_EXCHANGES,
      socratic: true, artifacts: true, evidence_marker: true, router_enabled: true, deep_mode: true,
      rescue_active: true, rescue_rounds: 0,
    });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0)).toMatchObject({ purpose: 'chat', systemPrompt: BOOTH_PROMPT, maxTokens: BOOTH_MAX_TOKENS });
    expect(call(0)).not.toHaveProperty('thinking');
    expect(res.body.reply).toEqual(FIELDS);
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
    callAI.mockResolvedValue(r(boothJson({ weigh: 'ECG first.\n:::artifact{type="differential" title="x"}\n| STEMI | NSTEMI |\n:::\nGood reasoning.' })));
    const res = await send({ booth_mode: true, artifacts: true });
    expect(res.body.reply.weigh).toMatch(/^ECG first\./);
    expect(res.body.reply.weigh).not.toContain(':::artifact');
    expect(res.body.reply.weigh).not.toMatch(/^:::[ \t]*$/m);
  });

  test('no reference chips, even for a cited reply (a PLE turn extracts them)', async () => {
    callAI.mockResolvedValue(r('Do an ECG within ten minutes (ESC ACS, 2023).'));
    const ple = await send();
    expect(ple.body.refs).not.toEqual([]);
    const booth = await send({ booth_mode: true });
    expect(booth.body.refs).toEqual([]);
  });

  test('always plain JSON with exactly the documented keys, even when the caller asks for a stream', async () => {
    callAI.mockResolvedValue(r(boothJson(), { failed_over_from: 'anthropic' }));
    const res = await send({ booth_mode: true, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      reply: FIELDS, refs: [], token_count: 20, input_tokens: 12, output_tokens: 8,
      provider: 'local-tutor', model: 'qwen-tutor', prompt_version: expect.stringMatching(/^chat-prompt-[0-9a-f]{8}$/),
      failed_over_from: 'anthropic', pick: null,
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

const BANK = {
  variants: [
    { id: 'q_first', question: { th: 'ขั้นต่อไปคุณจะส่งตรวจอะไร', en: 'What test next?' } },
    { id: 'q_alt', question: { th: 'คุณจะยืนยันการวินิจฉัยอย่างไร', en: 'How would you confirm it?' } },
  ],
  options: [
    { id: 'mat', tier: 'best', label: { th: 'ส่งตรวจ MAT', en: 'Send MAT' }, line: { th: 'ยืนยันด้วยซีรัม', en: 'Confirm by serology' } },
    { id: 'pcr', tier: 'best', label: { th: 'ส่งตรวจ PCR', en: 'Send PCR' }, line: { th: 'ได้ผลเร็วในสัปดาห์แรก', en: 'Fast in week one' } },
    { id: 'cbc', tier: 'reasonable', label: { th: 'ตรวจ CBC ซ้ำ', en: 'Repeat CBC' }, line: { th: 'ดูเกล็ดเลือด', en: 'Watch platelets' } },
    { id: 'wait', tier: 'weaker', label: { th: 'รอดูอาการ', en: 'Watch and wait' }, line: { th: 'นัดดูอาการสองวัน', en: 'Review in two days' } },
  ],
};
const GRILL_PROMPT = P.chatSystemPrompt({ booth: true, grill: true });
const PICK = { variant_id: 'q_alt', bridge: 'Fever after floodwater narrows the next question.', option_ids: ['pcr', 'cbc', 'wait'] };
const grillJson = (extra = {}) => JSON.stringify({ ...FIELDS, ...PICK, ...extra });

describe('the grill play: a booth turn with the next step\'s bank', () => {
  test('one call at the booth ceiling with the fixed grill prompt, which keeps every booth rule', async () => {
    callAI.mockResolvedValue(r(grillJson()));
    const res = await send({ booth_mode: true, booth_bank: BANK });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0)).toMatchObject({ purpose: 'chat', systemPrompt: GRILL_PROMPT, maxTokens: BOOTH_MAX_TOKENS });
    for (const line of ruleLines(BOOTH_PROMPT)) expect(call(0).systemPrompt).toContain(line);
    expect(call(0).systemPrompt).toContain('{"strength": "...", "weigh": "...", "safety": "...", "variant_id": "...", "bridge": "...", "option_ids": ["...", "...", "..."]}');
    expect(call(0).systemPrompt).toMatch(/Never write a question, an option label or an option line yourself/);
    expect(call(0).systemPrompt).not.toContain('q_first');
    expect(res.body.prompt_version).not.toBe((await send({ booth_mode: true })).body.prompt_version);
  });

  test('the bank (ids, tiers, Thai text) rides at the end of the last user turn only, after the de-identified history', async () => {
    callAI.mockResolvedValue(r(grillJson()));
    await send({ ...PII_TURN, booth_mode: true });
    const plain = call(0).messages;
    callAI.mockClear();
    await send({ ...PII_TURN, booth_mode: true, booth_bank: BANK });
    const msgs = call(0).messages;
    expect(msgs.slice(0, -1)).toEqual(plain.slice(0, -1));
    const last = msgs[msgs.length - 1].content;
    expect(last.startsWith(plain[plain.length - 1].content)).toBe(true);
    for (const s of ['q_alt', 'mat', '"tier":"weaker"', 'รอดูอาการ', 'ได้ผลเร็วในสัปดาห์แรก']) expect(last).toContain(s);
    expect(last).not.toContain('Watch and wait');
    const wire = JSON.stringify(callAI.mock.calls);
    for (const leak of LEAKS) expect(wire).not.toContain(leak);
  });

  test('a JSON reply returns its fields as the reply and the pick as sent, unjudged', async () => {
    callAI.mockResolvedValue(r(grillJson({ option_ids: ['pcr', 'mat', 'nope'] })));
    const res = await send({ booth_mode: true, booth_bank: BANK });
    expect(res.body.reply).toEqual(FIELDS);
    expect(res.body.pick).toEqual({ ...PICK, option_ids: ['pcr', 'mat', 'nope'] });
  });

  test('a fenced JSON reply is still read, and an artifact inside a field is stripped', async () => {
    callAI.mockResolvedValue(r('```json\n' + grillJson({ strength: 'Good.\n:::artifact{type="x" title="y"}\nbody\n:::' }) + '\n```'));
    const res = await send({ booth_mode: true, booth_bank: BANK });
    expect(res.body.pick).toEqual(PICK);
    expect(res.body.reply.strength).toMatch(/^Good\./);
    expect(res.body.reply.strength).not.toContain(':::');
  });

  test('a reply whose pick fields have the wrong types keeps the reply and drops the pick', async () => {
    callAI.mockResolvedValue(r(grillJson({ option_ids: 'pcr,cbc,wait' })));
    const res = await send({ booth_mode: true, booth_bank: BANK });
    expect(res.body.reply).toEqual(FIELDS);
    expect(res.body.pick).toBeNull();
  });

  test('no bank: the plain booth prompt, and a pick the model writes anyway is not read', async () => {
    callAI.mockResolvedValue(r(grillJson()));
    const res = await send({ booth_mode: true });
    expect(call(0)).toMatchObject({ systemPrompt: BOOTH_PROMPT, maxTokens: BOOTH_MAX_TOKENS });
    expect(res.body).toMatchObject({ reply: FIELDS, pick: null });
  });

  test.each([
    ['an id outside the pattern', { ...BANK, variants: [{ id: 'Q1', question: BANK.variants[0].question }] }],
    ['an unknown tier', { ...BANK, options: [...BANK.options.slice(1), { ...BANK.options[0], tier: 'top' }] }],
    ['a missing language', { ...BANK, variants: [{ id: 'q1', question: { th: 'ถาม' } }] }],
    ['an extra key', { ...BANK, default_trio: ['mat', 'cbc', 'wait'] }],
    ['too few options', { ...BANK, options: BANK.options.slice(0, 2) }],
    ['too many variants', { ...BANK, variants: [1, 2, 3, 4].map((i) => ({ id: `q${i}`, question: BANK.variants[0].question })) }],
  ])('a bank with %s is refused with 400 before any call', async (_label, bank) => {
    const res = await send({ booth_mode: true, booth_bank: bank });
    expect(res.status).toBe(400);
    expect(callAI).not.toHaveBeenCalled();
  });
});

const TYPED_PROMPT = P.chatSystemPrompt({ booth: true, typed: true });
const TYPED = { current: BANK, next: { best: BANK, reasonable: BANK, weaker: BANK } };
const typedJson = (extra = {}) => JSON.stringify({ ...FIELDS, tier: 'reasonable', ...PICK, ...extra });

describe('the typed answer: a booth turn that also sorts the answer into a tier (#247)', () => {
  test('one call at the booth ceiling with the typed prompt, which keeps every booth rule and puts the unsafe idea in safety', async () => {
    callAI.mockResolvedValue(r(typedJson()));
    const res = await send({ booth_mode: true, booth_typed: TYPED });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0)).toMatchObject({ purpose: 'chat', systemPrompt: TYPED_PROMPT, maxTokens: BOOTH_MAX_TOKENS });
    for (const line of ruleLines(BOOTH_PROMPT)) expect(call(0).systemPrompt).toContain(line);
    expect(call(0).systemPrompt).toContain('{"strength": "...", "weigh": "...", "safety": "...", "tier": "...",');
    expect(call(0).systemPrompt).toMatch(/If the typed idea could seriously harm the patient, say so gently in safety/);
    expect(call(0).systemPrompt).toMatch(/Never reveal or hint the tier/);
  });

  test('the SORT block (current bank, next banks by tier, Thai text) rides at the end of the last turn only, de-identified', async () => {
    callAI.mockResolvedValue(r(typedJson()));
    await send({ ...PII_TURN, booth_mode: true });
    const plain = call(0).messages;
    callAI.mockClear();
    await send({ ...PII_TURN, booth_mode: true, booth_typed: TYPED });
    const msgs = call(0).messages;
    expect(msgs.slice(0, -1)).toEqual(plain.slice(0, -1));
    const last = msgs[msgs.length - 1].content;
    expect(last.startsWith(plain[plain.length - 1].content)).toBe(true);
    for (const s of ['SORT:', '"current"', '"next"', '"best"', '"weaker"', 'รอดูอาการ']) expect(last).toContain(s);
    expect(last).not.toContain('Watch and wait');
    const wire = JSON.stringify(callAI.mock.calls);
    for (const leak of LEAKS) expect(wire).not.toContain(leak);
  });

  test('the fields, the tier and the pick come back as the model wrote them, unjudged', async () => {
    const safety = 'Stopping **all fluids** could seriously harm him.';
    callAI.mockResolvedValue(r(typedJson({ tier: 'unsafe', safety })));
    const res = await send({ booth_mode: true, booth_typed: TYPED });
    expect(res.body).toMatchObject({ reply: { ...FIELDS, safety }, tier: 'unsafe', pick: PICK });
  });

  test('without a next bank only the fields and the tier are asked for', async () => {
    callAI.mockResolvedValue(r(JSON.stringify({ ...FIELDS, tier: 'best', variant_id: '', bridge: '', option_ids: [] })));
    const res = await send({ booth_mode: true, booth_typed: { current: BANK } });
    expect(res.body).toMatchObject({ reply: FIELDS, tier: 'best' });
  });

  test.each([['with the next banks', TYPED], ['at the last step', { current: BANK }]])('the sort call %s sends temperature 0', async (_label, typed) => {
    callAI.mockResolvedValue(r(typedJson()));
    await send({ booth_mode: true, booth_typed: typed });
    expect(call(0).temperature).toBe(0);
  });

  test('a tapped booth turn and a plain booth turn send no temperature', async () => {
    callAI.mockResolvedValue(r(grillJson()));
    await send({ booth_mode: true, booth_bank: BANK });
    await send({ booth_mode: true });
    expect(callAI).toHaveBeenCalledTimes(2);
    for (const n of [0, 1]) expect(call(n)).not.toHaveProperty('temperature');
  });

  test('a tapped booth turn returns no tier key', async () => {
    callAI.mockResolvedValue(r(grillJson()));
    expect((await send({ booth_mode: true, booth_bank: BANK })).body).not.toHaveProperty('tier');
  });

  test('a next map missing a tier is refused with 400 before any call', async () => {
    const res = await send({ booth_mode: true, booth_typed: { current: BANK, next: { best: BANK, weaker: BANK } } });
    expect(res.status).toBe(400);
    expect(callAI).not.toHaveBeenCalled();
  });
});

describe('the typed answer comes back de-identified for the backend to keep (#375, ADR 0010)', () => {
  const ANSWER = `ให้นาย${RAW.name} โทร ${RAW.phone} มาตรวจ PCR`;
  const typedTurn = { language: 'th', message: `คุณจะส่งตรวจอะไร\n${ANSWER}`, booth_mode: true, booth_typed: TYPED };

  test('answer_deidentified is the typed answer under the message\'s own tokens, with no identifier left', async () => {
    callAI.mockResolvedValue(r(typedJson()));
    const res = await send({ ...typedTurn, booth_answer: ANSWER });
    expect(res.status).toBe(200);
    const kept = res.body.answer_deidentified;
    for (const leak of LEAKS) expect(kept).not.toContain(leak);
    expect(kept).toMatch(/\[NAME-\d+\]/);
    expect(kept).toContain('[PHONE-1]');
    expect(kept).toContain('มาตรวจ PCR');
    expect(call(0).messages.at(-1).content).toContain(kept);
  });

  test('the model is sent exactly what it gets without booth_answer', async () => {
    callAI.mockResolvedValue(r(typedJson()));
    await send(typedTurn);
    const without = call(0);
    callAI.mockClear();
    await send({ ...typedTurn, booth_answer: ANSWER });
    expect(call(0)).toEqual(without);
  });

  test('no booth_answer, no answer_deidentified; outside booth_mode it is never returned', async () => {
    callAI.mockResolvedValue(r(typedJson()));
    expect((await send(typedTurn)).body).not.toHaveProperty('answer_deidentified');
    callAI.mockResolvedValue(r('Reasonable (ESC, 2023).'));
    expect((await send({ language: 'th', message: ANSWER, booth_answer: ANSWER })).body).not.toHaveProperty('answer_deidentified');
  });

  test('a booth_answer over the bound is refused with 400 before any call', async () => {
    const res = await send({ ...typedTurn, booth_answer: 'ก'.repeat(601) });
    expect(res.status).toBe(400);
    expect(callAI).not.toHaveBeenCalled();
  });
});

describe('the reply language is the request\'s language (#377): the kiosk\'s primary language', () => {
  const EN_RULE = '- Reply in English only, whatever language the physician\'s answer is in. Never repeat the reply in another language.';
  const TH_RULE = '- Reply in Thai only, whatever language the physician\'s answer is in. Never repeat the reply in another language.';
  const THAI_TEXT = ['ขั้นต่อไปคุณจะส่งตรวจอะไร', 'รอดูอาการ', 'ได้ผลเร็วในสัปดาห์แรก'];
  const ENGLISH_TEXT = ['What test next?', 'Watch and wait', 'Fast in week one'];
  const kinds = [['plain', {}, {}], ['grill', { booth_bank: BANK }, { grill: true }], ['typed', { booth_typed: TYPED }, { typed: true }]];

  test.each(kinds)('%s: language en sends the English prompt, which keeps every other booth rule', async (_kind, body, opts) => {
    callAI.mockResolvedValue(r(typedJson()));
    const res = await send({ booth_mode: true, language: 'en', ...body });
    const sys = call(0).systemPrompt;
    expect(sys).toBe(P.chatSystemPrompt({ booth: true, ...opts, language: 'en' }));
    expect(sys).toContain(EN_RULE);
    expect(sys).not.toContain(TH_RULE);
    expect(sys).not.toMatch(/Thai if the physician's answer contains any Thai/);
    const thai = P.chatSystemPrompt({ booth: true, ...opts });
    expect(sys.split('\n').filter((l) => l !== EN_RULE)).toEqual(thai.split('\n').filter((l) => l !== TH_RULE));
    expect(res.body.prompt_version).not.toBe((await send({ booth_mode: true, ...body })).body.prompt_version);
  });

  test.each(kinds)('%s: language th (the default) sends the Thai prompt', async (_kind, body, opts) => {
    callAI.mockResolvedValue(r(typedJson()));
    await send({ booth_mode: true, ...body });
    expect(call(0).systemPrompt).toBe(P.chatSystemPrompt({ booth: true, ...opts, language: 'th' }));
    expect(call(0).systemPrompt).toContain(TH_RULE);
  });

  test.each([['BANK', { booth_bank: BANK }], ['SORT', { booth_typed: TYPED }]])('the %s block carries the English text only under language en', async (name, body) => {
    callAI.mockResolvedValue(r(typedJson()));
    await send({ booth_mode: true, language: 'en', ...body });
    const last = call(0).messages.at(-1).content;
    expect(last).toContain(`${name}: `);
    for (const s of ['q_alt', 'mat', '"tier":"weaker"', ...ENGLISH_TEXT]) expect(last).toContain(s);
    for (const s of THAI_TEXT) expect(last).not.toContain(s);
    callAI.mockClear();
    await send({ booth_mode: true, ...body });
    const thai = call(0).messages.at(-1).content;
    for (const s of THAI_TEXT) expect(thai).toContain(s);
    for (const s of ENGLISH_TEXT) expect(thai).not.toContain(s);
  });
});

const KINDS = [
  ['the last step', {}],
  ['a grill step', { booth_bank: BANK }],
  ['a typed answer', { booth_typed: TYPED }],
];

describe('the reply fields (#376): rimpl reads them, the backend judges them', () => {
  test.each(KINDS)('%s: each field is trimmed, and its bold markers are left raw', async (_kind, body) => {
    const fields = { strength: '  Choosing **ECG** first is a strength.\n', weigh: 'Weigh **the timing**.', safety: '*Never* wait.' };
    callAI.mockResolvedValue(r(typedJson(fields)));
    const res = await send({ booth_mode: true, ...body });
    expect(res.body.reply).toEqual({ strength: 'Choosing **ECG** first is a strength.', weigh: 'Weigh **the timing**.', safety: '*Never* wait.' });
  });

  test.each(KINDS)('%s: a missing or non-string field is empty and the others are kept', async (_kind, body) => {
    callAI.mockResolvedValue(r(JSON.stringify({ strength: 'Good.', safety: 7, tier: 'best', ...PICK })));
    const res = await send({ booth_mode: true, ...body });
    expect(res.body.reply).toEqual({ strength: 'Good.', weigh: '', safety: '' });
  });

  const MALFORMED = [
    ['truncated JSON', '{"strength": "Thinking of exposure is a strength", "weigh": "half'],
    ['prose with braces', 'Thinking of {exposure} is a strength.'],
    ['prose with no JSON', 'Thinking of exposure is a strength.'],
    ['JSON with none of the fields', JSON.stringify({ reply: 'Thinking of exposure is a strength.', ...PICK })],
    ['a repeated key', '{"strength": "a", "strength": "b", "weigh": "", "safety": "", "variant_id": "q_alt", "bridge": "", "option_ids": []}'],
  ];
  test.each(KINDS.flatMap(([kind, body]) => MALFORMED.map(([label, text]) => [kind, label, body, text])))(
    '%s, %s: every field empty, no pick, no tier, and no JSON text on the screen', async (_kind, _label, body, text) => {
      callAI.mockResolvedValue(r(text));
      const res = await send({ booth_mode: true, ...body });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ reply: NO_REPLY, pick: null });
      if (body.booth_typed) expect(res.body.tier).toBeNull();
    },
  );
});
