// DEADLINE for the OPTIONAL retries (routes/chat.js; lib/turn-limits.js CHAT_OPTIONAL_RETRY_CUTOFF_MS).
//
// The backend hangs up on a chat turn after 100 s and fails it closed with a 502. A language-only or
// evidence-only retry exists to improve a reply that was ALREADY deliverable, so one that would start
// past half that budget is skipped: the first reply goes out, the flags say no retry happened, and the
// log says why without any content. A REQUIRED retry (missing citation / ❓, rescue rules) still runs —
// its first reply was not deliverable, and failing it closed is the existing behaviour.
//
// The cutoff is read from the environment at load, so this file sets a 20 ms cutoff BEFORE requiring
// the app (jest gives each test file its own module registry) and every first call takes 80 ms: the
// elapsed time is always past the cutoff, with no fake clock.
//
// HERMETIC: callAI is mocked at the seam; RAG and Supabase are stubbed.
process.env.RIMPL_CHAT_OPTIONAL_RETRY_CUTOFF_MS = '20';

jest.mock('../src/services/ai', () => ({ callAI: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { CHAT_OPTIONAL_RETRY_CUTOFF_MS } = require('../src/lib/turn-limits');
const { MAX_RESCUE_ROUNDS } = require('../src/services/rescue');

const EN = 'Amoxicillin 1 g three times daily for 5 days is first line for low-severity CAP (BTS, 2019).';
const EN_NO_CITE = 'Amoxicillin 1 g three times daily for 5 days is first line for low-severity CAP.';
const TH = 'ผู้ป่วยปอดอักเสบชุมชนความรุนแรงต่ำควรได้รับ amoxicillin หนึ่งกรัมวันละสามครั้งเป็นเวลาห้าวัน (BTS, 2019)';
const TH_MSG = 'ผู้ป่วยปอดอักเสบชุมชนแบบผู้ป่วยนอก ควรเริ่มยาปฏิชีวนะตัวไหนก่อนครับ';

const r = (text) => ({ text, tokenCount: 20, inputTokens: 10, outputTokens: 10, provider: 'local', model: 'm' });
const slow = (text, ms = 80) => () => new Promise((res) => setTimeout(() => res(r(text)), ms));
const send = (body = {}) => request(app).post('/chat')
  .send({ ple_id: 'x', history: [], message: 'First-line for CAP?', language: 'en', ...body });

let warn;
beforeEach(() => { callAI.mockReset(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

test('the cutoff is env-tunable (default 50 s; 20 ms in this file)', () => {
  expect(CHAT_OPTIONAL_RETRY_CUTOFF_MS).toBe(20);
});

test('an evidence-only retry past the cutoff is SKIPPED: one call, first reply, evidence_retry false', async () => {
  callAI.mockImplementationOnce(slow(EN));
  const res = await send({ evidence_marker: true });
  expect(res.status).toBe(200);
  expect(callAI).toHaveBeenCalledTimes(1);
  expect(res.body).toMatchObject({ content: EN, evidence_level: null, evidence_retry: false });
  const line = warn.mock.calls.map((c) => c[0]).find((m) => /retry skipped/.test(m));
  expect(line).toMatch(/^\[RIMPL chat\] evidence retry skipped: \d+ ms into the turn, past the 20 ms cutoff — delivering the first reply$/);
  expect(line).not.toContain('Amoxicillin');
});

test('a language-only retry past the cutoff is SKIPPED too (also with the marker missing)', async () => {
  callAI.mockImplementationOnce(slow(EN));
  const res = await send({ language: 'th', message: TH_MSG, evidence_marker: true });
  expect(callAI).toHaveBeenCalledTimes(1);
  expect(res.body).toMatchObject({ content: EN, language_retry: false, evidence_retry: false });
  expect(warn.mock.calls.some((c) => /language retry skipped/.test(c[0]))).toBe(true);
});

test('a streamed turn past the cutoff: delta, done — no replace, nothing superseded', async () => {
  callAI.mockImplementationOnce(({ onDelta }) => new Promise((res) => setTimeout(() => { onDelta?.(EN); res(r(EN)); }, 80)));
  const res = await send({ evidence_marker: true, stream: true });
  const events = res.text.split('\n\n').filter(Boolean).map((b) => /^event: (.+)$/m.exec(b)?.[1]);
  expect(events).toEqual(['delta', 'done']);
  expect(callAI).toHaveBeenCalledTimes(1);
});

test('a REQUIRED citation retry still runs past the cutoff', async () => {
  callAI.mockImplementationOnce(slow(EN_NO_CITE)).mockResolvedValueOnce(r(EN));
  const res = await send({ evidence_marker: true });
  expect(callAI).toHaveBeenCalledTimes(2);
  expect(res.body.content).toBe(EN);
  expect(warn.mock.calls.some((c) => /retry skipped/.test(c[0]))).toBe(false);
});

test('a REQUIRED rescue rewrite still runs past the cutoff', async () => {
  callAI.mockImplementationOnce(slow('Rivaroxaban 20 mg once daily (ROCKET AF, 2011).')).mockResolvedValueOnce(r('What are you weighing here?'));
  const res = await send({ socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS });
  expect(callAI).toHaveBeenCalledTimes(2);
  expect(res.body.rescue_retry).toBe(true);
});

test('a turn that needs no retry is untouched by the cutoff', async () => {
  callAI.mockImplementationOnce(slow(TH));
  const res = await send({ language: 'th', message: TH_MSG });
  expect(callAI).toHaveBeenCalledTimes(1);
  expect(res.body.content).toBe(TH);
  expect(warn).not.toHaveBeenCalled();
});
