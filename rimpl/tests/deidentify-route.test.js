// POST /deidentify — the masked copy of a stored transcript that the backend hands to a HUMAN reader
// (the auditor; docs/CONSENT-TEMPLATE.md "Auditors see only the de-identified transcript"). It makes
// no AI call, logs no content, sits behind the internal token, and numbers tokens with ONE registry in
// the same order /chat does, so the auditor's "[NAME-2]" is the "[NAME-2]" the model saw and wrote.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { MAX_TURN_CHARS } = require('../src/lib/turn-limits');
const { MAX_DEIDENTIFY_MESSAGES } = require('../src/routes/deidentify');

const A = 'กฤตภาส';   // not in the given-name gazetteer: only a title, a hint or the shared registry catches it
const B = 'วรินทร';
const RAW = { hn: 'HN 12345678', phone: '081-234-5678', cid: '1234567890123', email: 'kittapas.j@hospital.go.th' };
const TRANSCRIPT = [
  { role: 'physician', content: `ผู้ป่วยนาย${A} ${RAW.hn} โทร ${RAW.phone} มาด้วยอาการเจ็บหน้าอก troponin 0.04 ng/mL` },
  { role: 'assistant', content: `ควรตรวจ ECG ซ้ำ (ESC, 2023)\n❓ ${A}มีอาการร่วมอะไรบ้าง` },   // assistant echoing a bare name
  { role: 'physician', content: `ภรรยา นาง${B} บัตร ${RAW.cid} email ${RAW.email}` },
  { role: 'reflection', content: `เรียนรู้อะไร / What I learned:\n${A} ต้องได้ serial troponin` },
];
const LEAKS = [A, B, '12345678', RAW.phone, '5678', RAW.cid, RAW.email, 'kittapas'];

const post = (body, token) => {
  const r = request(app).post('/deidentify');
  return (token ? r.set('x-internal-token', token) : r).send(body);
};

let savedToken, logSpies;
beforeEach(() => {
  savedToken = process.env.INTERNAL_TOKEN;
  delete process.env.INTERNAL_TOKEN;
  callAI.mockReset();
  logSpies = ['log', 'info', 'warn', 'error'].map((k) => jest.spyOn(console, k).mockImplementation(() => {}));
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.INTERNAL_TOKEN; else process.env.INTERNAL_TOKEN = savedToken;
  logSpies.forEach((s) => s.mockRestore());
});

function assertNothingLogged() {
  const logged = logSpies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
  for (const frag of LEAKS) expect(logged).not.toContain(frag);
}

describe('auth', () => {
  test('with INTERNAL_TOKEN set, a call with no token is refused', async () => {
    process.env.INTERNAL_TOKEN = 'secret';
    const r = await post({ messages: TRANSCRIPT });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toContain(A);
  });

  test('a wrong token is refused', async () => {
    process.env.INTERNAL_TOKEN = 'secret';
    expect((await post({ messages: TRANSCRIPT }, 'nope')).status).toBe(401);
  });

  test('the right token is admitted', async () => {
    process.env.INTERNAL_TOKEN = 'secret';
    expect((await post({ messages: TRANSCRIPT }, 'secret')).status).toBe(200);
  });
});

describe('masking', () => {
  test('every role is masked, roles and order are kept, clinical content survives, no AI call', async () => {
    const r = await post({ messages: TRANSCRIPT, patient_ref: null });
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m) => m.role)).toEqual(TRANSCRIPT.map((m) => m.role));
    const wire = JSON.stringify(r.body);
    for (const frag of LEAKS) expect(wire).not.toContain(frag);
    expect(wire).toContain('troponin 0.04 ng/mL');
    expect(wire).toContain('(ESC, 2023)');
    expect(r.body.messages[1].content).toMatch(/^ควรตรวจ ECG ซ้ำ \(ESC, 2023\)\n❓ \[NAME-1\]มีอาการร่วมอะไรบ้าง$/);
    expect(r.body).not.toHaveProperty('chief_complaint'); // not sent → not returned
    expect(callAI).not.toHaveBeenCalled();
    assertNothingLogged();
  });

  test('ONE registry: the same person keeps one token across turns, a different person gets another', async () => {
    const r = await post({ messages: TRANSCRIPT });
    const [t1, t2, t3, t4] = r.body.messages.map((m) => m.content);
    const a = /นาย(\[NAME-\d+\])/.exec(t1)[1];
    const b = /นาง(\[NAME-\d+\])/.exec(t3)[1];
    expect(t2).toContain(`${a}มีอาการร่วม`);   // bare echo in an assistant turn
    expect(t4).toContain(`${a} ต้องได้`);        // bare mention in the reflection
    expect(b).not.toBe(a);
  });

  test('patient_ref hints scrub an unlabelled, untitled name and are never echoed', async () => {
    const r = await post({ messages: [{ role: 'physician', content: `${B}ปวดท้องมา 2 วัน` }], patient_ref: `นาง${B} ใจงาม` });
    expect(r.status).toBe(200);
    expect(r.body.messages[0].content).toBe('[NAME-1]ปวดท้องมา 2 วัน');
    expect(JSON.stringify(r.body)).not.toContain('ใจงาม');
    expect(r.body).not.toHaveProperty('patient_ref');
  });

  test('chief complaint is masked FIRST and numbered with the transcript', async () => {
    const r = await post({ chief_complaint: `นาย${A} อายุ 45 ปี เจ็บหน้าอก`, messages: [{ role: 'physician', content: `${A} ยังเจ็บ และ นาง${B} มาด้วย` }] });
    expect(r.status).toBe(200);
    expect(r.body.chief_complaint).toBe('นาย[NAME-1] [AGE-1] เจ็บหน้าอก');
    expect(r.body.messages[0].content).toBe('[NAME-1] ยังเจ็บ และ นาง[NAME-2] มาด้วย');
  });

  test('the numbering is the one /chat sent to the model for the same session', async () => {
    // Chat turn 2: history = turn-1 pair, message = turn-2 physician text. The auditor later opens the
    // whole stored transcript. Every token must line up, or the model's own stored reply ("[NAME-1]…")
    // would name someone else in the auditor's copy.
    callAI.mockResolvedValue({ text: 'พิจารณา (ESC, 2023).', tokenCount: 1, inputTokens: 1, outputTokens: 1, provider: 'anthropic' });
    const cc = `นาง${B} พามา`;
    const turn1 = [{ role: 'physician', content: `นาย${A} ${RAW.hn} มาด้วยไข้` }, { role: 'assistant', content: 'ขอข้อมูลเพิ่ม' }];
    const turn2 = { role: 'physician', content: `${A}ยังมีไข้ โทร ${RAW.phone}` };
    await request(app).post('/chat').send({ ple_id: 'x', language: 'th', chief_complaint: cc, history: turn1, message: turn2.content });
    const sent = callAI.mock.calls[0][0].messages;

    const r = await post({ chief_complaint: cc, messages: [...turn1, turn2] });
    expect(r.body.messages[0].content).toBe(sent[0].content);
    expect(r.body.messages[1].content).toBe(sent[1].content);
    expect(sent[2].content).toContain(r.body.chief_complaint);
    expect(sent[2].content).toContain(r.body.messages[2].content);
  });

  test('an empty transcript is a valid, empty answer', async () => {
    const r = await post({ messages: [] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ messages: [] });
  });
});

describe('bounds', () => {
  test('a turn over MAX_TURN_CHARS is refused, and the 400 echoes no content', async () => {
    const r = await post({ messages: [{ role: 'physician', content: `นาย${A} ` + 'ก'.repeat(MAX_TURN_CHARS) }] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(A);
  });

  test(`more than ${MAX_DEIDENTIFY_MESSAGES} messages is refused`, async () => {
    const r = await post({ messages: Array.from({ length: MAX_DEIDENTIFY_MESSAGES + 1 }, () => ({ role: 'physician', content: 'x' })) });
    expect(r.status).toBe(400);
  });

  // Against the shipped 2mb default (index.js); an operator override of RIMPL_BODY_LIMIT moves the bar.
  (process.env.RIMPL_BODY_LIMIT ? test.skip : test)('a body over the layer-wide limit never reaches the filter', async () => {
    // 40 turns x 24000 Thai chars x 3 bytes of UTF-8 ≈ 2.9 MB, over the 2mb default.
    const big = Array.from({ length: 40 }, () => ({ role: 'physician', content: 'ก'.repeat(MAX_TURN_CHARS) }));
    const r = await post({ messages: big });
    expect(r.status).toBe(413);
  });

  test('malformed bodies are refused', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ messages: [{ role: 'physician' }] })).status).toBe(400);
    expect((await post({ messages: [{ role: 'physician', content: 5 }] })).status).toBe(400);
  });
});

describe('fail closed', () => {
  test('a filter failure answers 500 with a fixed body — no partial, no raw transcript, nothing logged', async () => {
    jest.resetModules();
    jest.doMock('../src/services/pii-filter', () => {
      const actual = jest.requireActual('../src/services/pii-filter');
      return { ...actual, stripHistoryPii: () => { throw new RangeError(`boom on ${A}`); } };
    });
    const express = require('express');
    const isolated = express().use(express.json()).use('/deidentify', require('../src/routes/deidentify'));
    const r = await request(isolated).post('/deidentify').send({ messages: TRANSCRIPT });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'deidentify_failed' });
    expect(JSON.stringify(r.body) + r.text).not.toContain(A);
    assertNothingLogged();   // the thrown message quoted a name: only the error CLASS is logged
    jest.dontMock('../src/services/pii-filter');
  });
});
