// LANGUAGE GUARD — chat.js asks for ONE retry when a Thai turn (language === 'th') is answered in
// mostly-not-Thai, folded into the citation/❓ retry so a turn never makes more than two AI calls.
//
// HERMETIC: callAI is mocked at the seam (services/ai), RAG and Supabase are stubbed; no provider,
// key, socket or database.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { RIMPL_SYSTEM_PROMPT_EXAMINER, RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_RESCUE } = require('../src/lib/prompts');
const { promptLabel } = require('../src/lib/versions');
const { MAX_RESCUE_ROUNDS } = require('../src/services/rescue');

const THAI_OK = 'เมตฟอร์มินเป็นยาทางเลือกแรกสำหรับผู้ป่วยเบาหวานชนิดที่ 2 ควรปรับขนาดยาตามการทำงานของไต (ADA, 2024)';
const THAI_OK_Q = `${THAI_OK}\n❓ ถ้า eGFR ต่ำกว่า 30 คุณจะเปลี่ยนแผนอย่างไร`;
const EN_OK = 'Metformin is first-line therapy for type 2 diabetes and the dose should follow renal function (ADA, 2024).';
const EN_OK_Q = `${EN_OK}\n❓ How would an eGFR below 30 change your plan?`;
const EN_NO_CITE = 'Metformin is first-line therapy for type 2 diabetes and the dose should follow renal function.';

// Distinct usages so no coincidence can satisfy a sum.
const r = (text, i, o, extra = {}) => ({ text, tokenCount: i + o, inputTokens: i, outputTokens: o, provider: 'local', model: 'm', ...extra });
const send = (body) => request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'ถามเรื่องเมตฟอร์มิน', ...body });

let warn;
beforeEach(() => { callAI.mockReset(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe('language guard (chat.js)', () => {
  test('a Thai turn answered in English triggers exactly ONE retry, and the Thai reply is returned', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 1000, 300)).mockResolvedValueOnce(r(THAI_OK, 1400, 120));
    const res = await send({ language: 'th' });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.content).toBe(THAI_OK);
    expect(res.body.language_retry).toBe(true);
    // The retry is a USER-turn message after the rejected reply, asking for Thai in both languages.
    const msgs = callAI.mock.calls[1][0].messages;
    expect(msgs[msgs.length - 2]).toEqual({ role: 'assistant', content: EN_OK });
    expect(msgs[msgs.length - 1].role).toBe('user');
    expect(msgs[msgs.length - 1].content).toMatch(/ภาษาไทย/);
    expect(msgs[msgs.length - 1].content).toMatch(/in Thai/);
  });

  test('a Thai reply to a Thai turn does NOT retry', async () => {
    callAI.mockResolvedValueOnce(r(THAI_OK, 1000, 300));
    const res = await send({ language: 'th' });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.language_retry).toBe(false);
  });

  test('Thai prose carrying English drug names and an English-titled citation does not retry', async () => {
    const text = 'ผู้ป่วยรายนี้ควรเริ่ม metformin 500 mg วันละสองครั้งหลังอาหาร และติดตาม HbA1c ทุกสามเดือน (Kidney Disease: Improving Global Outcomes Diabetes Work Group, 2022)';
    callAI.mockResolvedValueOnce(r(text, 10, 10));
    const res = await send({ language: 'th' });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.language_retry).toBe(false);
  });

  test("language 'en' NEVER triggers it — English is not forced (a Thai reply to an English turn is fine too)", async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 10, 10));
    expect((await send({ language: 'en' })).body.language_retry).toBe(false);
    callAI.mockResolvedValueOnce(r(THAI_OK, 10, 10));
    expect((await send({ language: 'en' })).body.language_retry).toBe(false);
    expect(callAI).toHaveBeenCalledTimes(2);   // one call each, no retries
  });

  test('citation AND language both failing still costs only TWO calls (one combined retry), natural mode', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE, 1000, 300)).mockResolvedValueOnce(r(THAI_OK, 1400, 120));
    const res = await send({ language: 'th' });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.language_retry).toBe(true);
    const asked = callAI.mock.calls[1][0].messages.at(-1).content;
    expect(asked).toMatch(/\(แหล่ง, ปี\)/);        // the citation ask is still there
    expect(asked).toMatch(/Write the whole reply in Thai/);
  });

  test('citation AND ❓ AND language all failing (examiner mode) is still TWO calls, even if the retry is bad too', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE, 1000, 300)).mockResolvedValueOnce(r(EN_NO_CITE, 1400, 120));
    const res = await send({ language: 'th', socratic: true });
    expect(callAI).toHaveBeenCalledTimes(2);       // no third call, ever
    expect(res.body.language_retry).toBe(true);
    const asked = callAI.mock.calls[1][0].messages.at(-1).content;
    expect(asked).toMatch(/❓/);
    expect(asked).toMatch(/Write the whole reply in Thai/);
    // Still-not-Thai after the one retry: delivered, and logged with the share only — not the text.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/did not produce Thai \(share 0\.00\)/);
    expect(warn.mock.calls[0][0]).not.toContain('Metformin');
  });

  test('citation failing alone (a Thai reply) is unchanged: one retry, language_retry false, no Thai instruction added', async () => {
    const thaiNoCite = 'เมตฟอร์มินเป็นยาทางเลือกแรกสำหรับผู้ป่วยเบาหวานชนิดที่ 2 ควรปรับขนาดยาตามการทำงานของไต';
    callAI.mockResolvedValueOnce(r(thaiNoCite, 10, 10)).mockResolvedValueOnce(r(THAI_OK, 10, 10));
    const res = await send({ language: 'th' });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.language_retry).toBe(false);
    expect(callAI.mock.calls[1][0].messages.at(-1).content).not.toMatch(/Write the whole reply in Thai/);
  });

  test('language-only retry in examiner mode asks for a REWRITE that keeps the ❓ and the citation', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK_Q, 10, 10)).mockResolvedValueOnce(r(THAI_OK_Q, 10, 10));
    const res = await send({ language: 'th', socratic: true });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.socratic_question).toBe('ถ้า eGFR ต่ำกว่า 30 คุณจะเปลี่ยนแผนอย่างไร');
    expect(callAI.mock.calls[1][0].messages.at(-1).content).toMatch(/rewrite your previous reply in Thai/);
  });

  test('token accounting sums BOTH calls exactly; context_tokens is the returned call only', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 1000, 300)).mockResolvedValueOnce(r(THAI_OK, 1400, 70));
    const res = await send({ language: 'th' });
    expect(res.body.input_tokens).toBe(2400);
    expect(res.body.output_tokens).toBe(370);
    expect(res.body.token_count).toBe(2770);
    expect(res.body.context_tokens).toBe(1470);
  });

  test('the retry is PINNED to the provider that served the first call, with the same system prompt and ceiling', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 1, 1, { provider: 'local' })).mockResolvedValueOnce(r(THAI_OK, 1, 1, { provider: 'local' }));
    await send({ language: 'th' });
    const [first, second] = callAI.mock.calls.map((c) => c[0]);
    expect(first.provider).toBeUndefined();        // first call resolves normally
    expect(second.provider).toBe('local');         // retry pinned to whoever answered
    expect(second.purpose).toBe('chat');
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.maxTokens).toBe(first.maxTokens);
  });

  test('prompt_version is unchanged by the retry: the label of the system prompt, which the retry does not touch', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 1, 1)).mockResolvedValueOnce(r(THAI_OK, 1, 1));
    const retried = await send({ language: 'th' });
    callAI.mockReset().mockResolvedValueOnce(r(THAI_OK, 1, 1));
    const plain = await send({ language: 'th' });
    expect(retried.body.prompt_version).toBe(plain.body.prompt_version);
    expect(retried.body.prompt_version).toBe(promptLabel('chat', RIMPL_SYSTEM_PROMPT_NATURAL));
    callAI.mockReset().mockResolvedValueOnce(r(EN_OK_Q, 1, 1)).mockResolvedValueOnce(r(THAI_OK_Q, 1, 1));
    const ex = await send({ language: 'th', socratic: true });
    expect(ex.body.prompt_version).toBe(promptLabel('chat', RIMPL_SYSTEM_PROMPT_EXAMINER));
  });

  test('a rescue turn is guarded by a REWRITE (never a citation re-ask), under the rescue prompt, label unchanged', async () => {
    // Round cap reached → the rescue prompt runs one last time with no classifier call (hermetic).
    callAI
      .mockResolvedValueOnce(r('What have you already considered about the likely cause of these symptoms?', 10, 10))
      .mockResolvedValueOnce(r('คุณพิจารณาสาเหตุที่เป็นไปได้ของอาการเหล่านี้ไว้อย่างไรบ้างแล้ว ❓', 10, 10));
    const res = await send({ language: 'th', socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.language_retry).toBe(true);
    const asked = callAI.mock.calls[1][0].messages.at(-1).content;
    expect(asked).toMatch(/rewrite your previous reply in Thai/);
    expect(asked).not.toMatch(/\(Source, Year\) citation\. Engage/);
    expect(callAI.mock.calls[1][0].systemPrompt).toBe(RIMPL_SYSTEM_PROMPT_RESCUE);
    expect(res.body.prompt_version).toBe(promptLabel('chat', RIMPL_SYSTEM_PROMPT_RESCUE));
  });
});
