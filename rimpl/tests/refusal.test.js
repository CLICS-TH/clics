// Safeguard refusals through the routes (claude-sonnet-5-5 declines in five categories with HTTP 200,
// `stop_reason: "refusal"`; providers/anthropic.js turns that into a RefusalError).
//
// What must hold:
//   * a refused chat turn answers 422 code 'refused' with the BILLED usage, and never runs the
//     citation retry (there is nothing to correct, and the retry would be billed again);
//   * a refused citation retry still meters BOTH calls; a refused language-only retry keeps the
//     deliverable first reply and adds the refused call's tokens to the turn;
//   * no retry ever carries an empty assistant message (an API 400);
//   * /evaluate logs `refused:<category>`, distinct from invalid_json, and answers 422 (deterministic
//     for the backend, so the drain does not re-pay for it).
//
// HERMETIC: callAI is mocked at the seam (services/ai); RAG and Supabase are stubbed.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn(), resolveProviderName: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, resolveProviderName } = require('../src/services/ai');

// The shape providers/anthropic.js throws (RefusalError), as a plain object so this suite needs no SDK.
const refused = (inputTokens, outputTokens, category = 'general_harms') => Object.assign(
  new Error(`model declined the request (refusal, category ${category})`),
  { code: 'refused', category, inputTokens, outputTokens, model: 'claude-sonnet-5-5',
    usage: { inputTokens, outputTokens, provider: 'anthropic' } },
);
const r = (text, i, o) => ({ text, tokenCount: i + o, inputTokens: i, outputTokens: o, provider: 'anthropic', model: 'claude-sonnet-5-5' });
const EN_OK = 'Metformin is first-line therapy for type 2 diabetes and the dose should follow renal function (ADA, 2024).';
const EN_NO_CITE = 'Metformin is first-line therapy for type 2 diabetes and the dose should follow renal function.';
const THAI_OK = 'เมตฟอร์มินเป็นยาทางเลือกแรกสำหรับผู้ป่วยเบาหวานชนิดที่ 2 ควรปรับขนาดยาตามการทำงานของไต (ADA, 2024)';

let warn, error;
beforeEach(() => {
  callAI.mockReset();
  resolveProviderName.mockReset().mockResolvedValue('anthropic');
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); error.mockRestore(); });

describe('POST /chat', () => {
  const send = (body = {}) => request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'first-line for T2DM?', language: 'en', ...body });

  test('a refused first call answers 422 refused with its billed usage, and NO citation retry runs', async () => {
    callAI.mockRejectedValueOnce(refused(1200, 4, 'bio'));
    const res = await send();
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'refused', category: 'bio', input_tokens: 1200, output_tokens: 4, provider: 'anthropic' });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/\[RIMPL chat\] refused:bio/);
  });

  test('a refused CITATION retry fails the turn, metering BOTH calls', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE, 1000, 300)).mockRejectedValueOnce(refused(1400, 2));
    const res = await send();
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'refused', input_tokens: 2400, output_tokens: 302 });
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  test('a refused LANGUAGE-only retry keeps the deliverable first reply and adds the refused tokens', async () => {
    // Physician wrote Thai, reply is English but cited: the retry is language-only.
    callAI.mockResolvedValueOnce(r(EN_OK, 1000, 300)).mockRejectedValueOnce(refused(1400, 2));
    const res = await send({ message: 'ผู้ป่วยเบาหวานชนิดที่ 2 ควรใช้ยาอะไรเป็นตัวแรก', language: 'th' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe(EN_OK);
    expect(res.body.input_tokens).toBe(2400);
    expect(res.body.output_tokens).toBe(302);
  });

  test('an EMPTY first reply is never sent back as an assistant message in the retry', async () => {
    callAI.mockResolvedValueOnce(r('', 1000, 0)).mockResolvedValueOnce(r(EN_OK, 1100, 200));
    const res = await send();
    expect(res.status).toBe(200);
    const retryMessages = callAI.mock.calls[1][0].messages;
    expect(retryMessages.some((m) => m.role === 'assistant' && !String(m.content).trim())).toBe(false);
    expect(retryMessages[retryMessages.length - 1].role).toBe('user');
  });

  test('a non-empty first reply is still sent back for correction (unchanged behaviour)', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE, 1000, 300)).mockResolvedValueOnce(r(EN_OK, 1100, 200));
    await send();
    const retryMessages = callAI.mock.calls[1][0].messages;
    expect(retryMessages[retryMessages.length - 2]).toEqual({ role: 'assistant', content: EN_NO_CITE });
  });
});

describe('POST /evaluate', () => {
  test('a refusal logs refused:<category> (not invalid_json) and answers 422 with the billed usage', async () => {
    callAI.mockRejectedValueOnce(refused(130000, 5, 'bio'));
    const res = await request(app).post('/evaluate').send({ ple_id: 'x', transcript: [{ role: 'physician', content: 'hello' }], shadow: false });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'refused', category: 'bio', input_tokens: 130000, output_tokens: 5 });
    const logs = [...warn.mock.calls, ...error.mock.calls].flat().join(' ');
    expect(logs).toMatch(/\[RIMPL evaluate\] refused:bio/);
    expect(logs).not.toMatch(/invalid JSON/);
    expect(callAI).toHaveBeenCalledTimes(1);   // the incumbent path never re-asks
  });
});

describe('POST /evaluate-criteria and /audit-discuss', () => {
  test('both answer 422 refused with the billed usage', async () => {
    callAI.mockRejectedValueOnce(refused(5000, 1));
    const crit = await request(app).post('/evaluate-criteria').send({ transcript: [{ role: 'physician', content: 'hello' }] });
    expect(crit.status).toBe(422);
    expect(crit.body).toMatchObject({ code: 'refused', input_tokens: 5000, output_tokens: 1 });
    callAI.mockRejectedValueOnce(refused(6000, 2));
    const disc = await request(app).post('/audit-discuss').send({ message: 'why d4?', transcript: [{ role: 'physician', content: 'hello' }], history: [] });
    expect(disc.status).toBe(422);
    expect(disc.body).toMatchObject({ code: 'refused', input_tokens: 6000, output_tokens: 2 });
  });
});
