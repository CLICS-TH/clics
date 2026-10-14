// ONE numbering across every route that de-identifies a session. /chat numbers tokens chief complaint
// first, then the turns oldest first; the model writes those tokens into its own stored replies, the
// auditor reads them (POST /deidentify), the discussion prompt carries them next to the evaluator's
// rationale (/audit-discuss), and the persisted PII map (/evaluate-criteria pii_map) is their reverse.
// If any one route numbered differently, "[AGE-2]" would be one value in one place and another value
// in the next — the reviewer's repro below, which /evaluate and /evaluate-criteria produced before they
// were seeded with the chief complaint (they numbered the transcript's age "[AGE-1]").
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, resolveProviderName } = require('../src/services/ai');

// The reviewer's repro, plus a titled name and a phone so more than one category is in play.
const CC = 'ผู้ป่วยชาย 45 ปี เจ็บหน้าอก';
const TURNS = [
  { role: 'physician', content: 'มารดาอายุ 70 ปี เป็นเบาหวาน' },
  { role: 'assistant', content: 'ขอข้อมูลเพิ่มเติม' },
  { role: 'physician', content: 'นายกฤตภาส โทร 081-234-5678 ยังมีไข้' },
];
const PATIENT_REF = null;
const RAW = ['45', '70', 'กฤตภาส', '081-234-5678'];

const EVAL_REPLY = {
  text: JSON.stringify({ d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, rationale: { d1: 'มารดา[AGE-2] เป็นปัจจัยเสี่ยง' } }),
  inputTokens: 10, outputTokens: 10, provider: 'anthropic', model: 'claude-sonnet-4-6', stopReason: 'end_turn',
};
const CRITERIA_REPLY = { text: '{"c4":true,"c5":true,"c6":true,"c7":true,"on_topic":true}', inputTokens: 1, outputTokens: 1, provider: 'anthropic' };
const CHAT_REPLY = { text: 'พิจารณา (ADA, 2024).', tokenCount: 1, inputTokens: 1, outputTokens: 1, provider: 'anthropic' };

let errSpy;
beforeEach(() => {
  callAI.mockReset();
  resolveProviderName.mockReset().mockResolvedValue('anthropic');
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

// Apply a pii_map (token → raw) to masked text.
const reidentify = (text, map) => map.reduce((t, e) => t.split(e.token).join(e.value), text);

async function runAll() {
  const deid = await request(app).post('/deidentify').send({ chief_complaint: CC, messages: TURNS, patient_ref: PATIENT_REF });
  callAI.mockResolvedValueOnce(CRITERIA_REPLY);
  const criteria = await request(app).post('/evaluate-criteria').send({ transcript: TURNS, patient_ref: PATIENT_REF, chief_complaint: CC });
  const criteriaInput = callAI.mock.calls.at(-1)[0].messages[0].content;
  callAI.mockResolvedValueOnce(EVAL_REPLY);
  const evaluation = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: TURNS, patient_ref: PATIENT_REF, chief_complaint: CC, shadow: false });
  const evalInput = callAI.mock.calls.at(-1)[0].messages[0].content;
  callAI.mockResolvedValueOnce(CHAT_REPLY);
  await request(app).post('/chat').send({ ple_id: 'x', language: 'th', chief_complaint: CC, patient_ref: PATIENT_REF,
    history: TURNS.slice(0, 2), message: TURNS[2].content });
  const chatSent = callAI.mock.calls.at(-1)[0].messages;
  callAI.mockResolvedValueOnce(CHAT_REPLY);
  await request(app).post('/audit-discuss').send({ chief_complaint: CC, patient_ref: PATIENT_REF, transcript: TURNS,
    ai_rationale: evaluation.body.domain_rationale, message: 'ทำไม d1 ได้ 3' });
  const discussPrompt = callAI.mock.calls.at(-1)[0].systemPrompt;
  return { deid, criteria, criteriaInput, evaluation, evalInput, chatSent, discussPrompt };
}

test("the reviewer's repro: the transcript's age is [AGE-2] on every route, because the chief complaint's is [AGE-1]", async () => {
  const r = await runAll();
  expect(r.deid.status).toBe(200);
  expect(r.criteria.status).toBe(200);
  expect(r.evaluation.status).toBe(200);
  const masked = r.deid.body.messages.map((m) => m.content);
  expect(r.deid.body.chief_complaint).toBe('ผู้ป่วยชาย [AGE-1] เจ็บหน้าอก');
  expect(masked[0]).toBe('มารดา[AGE-2] เป็นเบาหวาน');
  for (const turn of masked) {
    expect(r.evalInput).toContain(turn);        // the PIS-7 evaluator's input
    expect(r.criteriaInput).toContain(turn);    // the classifier that also yields the PII map
    expect(r.discussPrompt).toContain(turn);    // the discussion's transcript block
  }
  expect(r.chatSent[0].content).toBe(masked[0]);
  expect(r.chatSent[1].content).toBe(masked[1]);
  expect(r.chatSent[2].content).toContain(masked[2]);
  // The evaluator's rationale, pasted into the discussion, now means the same person as the transcript next to it.
  expect(r.discussPrompt).toContain('AI rationale: มารดา[AGE-2] เป็นปัจจัยเสี่ยง');
});

test('the persisted PII map is the exact reverse of the tokens the auditor sees', async () => {
  const r = await runAll();
  const map = r.criteria.body.pii_map;
  expect(map).toEqual(expect.arrayContaining([
    { token: '[AGE-1]', category: 'AGE', value: '45 ปี' },          // from the chief complaint (seed)
    { token: '[AGE-2]', category: 'AGE', value: 'อายุ 70 ปี' },
    { token: '[NAME-1]', category: 'NAME', value: 'กฤตภาส' },
    { token: '[PHONE-1]', category: 'PHONE', value: '081-234-5678' },
  ]));
  r.deid.body.messages.forEach((m, i) => expect(reidentify(m.content, map)).toBe(TURNS[i].content));
  expect(reidentify(r.deid.body.chief_complaint, map)).toBe(CC);
});

test('the chief complaint seeds /evaluate, /evaluate-criteria and /audit-discuss but is never sent to the model', async () => {
  const r = await runAll();
  for (const input of [r.evalInput, r.criteriaInput, r.discussPrompt]) {
    expect(input).not.toContain('เจ็บหน้าอก');      // the chief complaint's only clinical words
    expect(input).not.toContain('ผู้ป่วยชาย');
    for (const frag of RAW) expect(input).not.toContain(frag);
  }
});

test('provenance records the numbering, and config_fingerprint does not move with it', async () => {
  callAI.mockResolvedValueOnce(EVAL_REPLY);
  const seeded = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: TURNS, chief_complaint: CC, shadow: false });
  callAI.mockResolvedValueOnce(EVAL_REPLY);
  const unseeded = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: TURNS, shadow: false });
  expect(seeded.body.provenance.deid).toBe('cc-seeded-v1');
  expect(unseeded.body.provenance.deid).toBe('transcript-only-v1');   // an older backend / the calibration harness
  expect(seeded.body.provenance.config_fingerprint).toBe(unseeded.body.provenance.config_fingerprint);
  // ...and without a chief complaint the input is the one every evaluation before this change scored.
  expect(callAI.mock.calls.at(-1)[0].messages[0].content).toContain('มารดา[AGE-1] เป็นเบาหวาน');
});

test('an old backend that sends no chief complaint still validates on /evaluate and /evaluate-criteria', async () => {
  callAI.mockResolvedValueOnce(CRITERIA_REPLY);
  const criteria = await request(app).post('/evaluate-criteria').send({ transcript: TURNS, patient_ref: null });
  expect(criteria.status).toBe(200);
  callAI.mockResolvedValueOnce(CRITERIA_REPLY);
  const nullCc = await request(app).post('/evaluate-criteria').send({ transcript: TURNS, patient_ref: null, chief_complaint: null });
  expect(nullCc.status).toBe(200);
});
