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

// ---------------------------------------------------------------------------------------------
// Review fixes: retry failure keeps the first reply; physician-language gate; artifact / references.
// ---------------------------------------------------------------------------------------------
const { QueueFullError } = require('../src/services/providers/runtime');

const queueFull = () => new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 });
const tooLarge = () => Object.assign(new Error('refused before send'), {
  status: 413, code: 'transcript_too_large', contextTooSmall: true, est_tokens: 70000, limit: 64000,
});
const aborted = () => Object.assign(new Error('aborted'), { code: 'aborted', aborted: true });
const fourExchanges = () => Array.from({ length: 4 }, (_, i) => [
  { role: 'physician', content: `คำถาม ${i}` }, { role: 'assistant', content: `คำตอบ ${i}` },
]).flat();
const SHALLOW = JSON.stringify({ c4: true, c5: false, c6: false, c7: false, on_topic: true });
const EN_TABLE = '| Dx | Features |\n|---|---|\n| Pneumonia | Fever, productive cough, consolidation |\n| Pulmonary embolism | Pleuritic pain, tachycardia, hypoxia |\n| Heart failure | Orthopnea, oedema, raised JVP |';
const FENCE = (body) => `:::artifact{type="differential" title="DDx"}\n${body}\n:::`;

describe('a failed language retry keeps the first reply', () => {
  test.each([['503 queue_full', queueFull], ['413 transcript_too_large', tooLarge]])('%s: 200 with the FIRST text and the first call\'s tokens only', async (_n, mkErr) => {
    callAI.mockResolvedValueOnce(r(EN_OK, 1000, 300)).mockRejectedValueOnce(mkErr());
    const res = await send({ language: 'th' });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.content).toBe(EN_OK);
    expect(res.body.language_retry).toBe(false);
    expect(res.body.input_tokens).toBe(1000);
    expect(res.body.output_tokens).toBe(300);
    expect(res.body.token_count).toBe(1300);
    expect(res.body.context_tokens).toBe(1300);
    // Logged by code only, never the content.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/language retry failed \((queue_full|transcript_too_large)\)/);
    expect(warn.mock.calls[0][0]).not.toContain('Metformin');
  });

  test('a provider 5xx without a code is logged by status', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 10, 10)).mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 502 }));
    const res = await send({ language: 'th' });
    expect(res.status).toBe(200);
    expect(warn.mock.calls[0][0]).toMatch(/\(502\)/);
  });

  test('a rescue turn keeps its activation when the language retry fails, and reply_check is on the first reply', async () => {
    callAI.mockImplementation(async (a) => {
      if (a.purpose === 'criteria') return r(SHALLOW, 7, 3, { provider: 'local' });
      if (callAI.mock.calls.filter((c) => c[0].purpose === 'chat').length === 1) {
        return r('What have you already considered about the likely cause of these symptoms?', 100, 20);
      }
      throw queueFull();
    });
    const res = await send({ language: 'th', history: fourExchanges(), message: 'ผมยังไม่แน่ใจเลยครับ ขอความเห็นหน่อย' });
    expect(res.status).toBe(200);
    expect(res.body.rescue).toMatchObject({ activated: true, rescuing: true, reason: 'not_qualifying' });
    expect(res.body.rescue.assessment).toMatchObject({ input_tokens: 7, output_tokens: 3 });
    expect(res.body.rescue.reply_check).toMatchObject({ questions: 1, ok: true });
    expect(res.body.language_retry).toBe(false);
    expect(res.body.input_tokens).toBe(100);
  });

  test('an abort during the retry still yields 499 (nobody to deliver to)', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 10, 10)).mockRejectedValueOnce(aborted());
    const res = await send({ language: 'th' });
    expect(res.status).toBe(499);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/language retry failed/));
  });

  test('a retry needed for a MISSING CITATION still fails closed (unchanged): its first reply was not deliverable', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE, 10, 10)).mockRejectedValueOnce(queueFull());
    const res = await send({ language: 'en' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('queue_full');
    callAI.mockReset();
    callAI.mockResolvedValueOnce(r(EN_NO_CITE, 10, 10)).mockRejectedValueOnce(queueFull());
    expect((await send({ language: 'th' })).status).toBe(503);   // combined citation+language: same
  });
});

describe('the guard polices only a physician who wrote substantially in Thai', () => {
  test("an English message with a trailing ครับ (client says 'th') and an English reply: no retry", async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 10, 10));
    const res = await send({ language: 'th', message: "What's first-line for outpatient CAP? ครับ" });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.language_retry).toBe(false);
    expect(res.body.content).toBe(EN_OK);
  });

  test('same with ค่ะ, in examiner mode', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK_Q, 10, 10));
    const res = await send({ language: 'th', socratic: true, message: 'Should I start empiric doxycycline for a stable outpatient with CAP and no comorbidities? ค่ะ' });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.language_retry).toBe(false);
  });

  test('a substantially Thai message with an English reply: retry', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 10, 10)).mockResolvedValueOnce(r(THAI_OK, 10, 10));
    const res = await send({ language: 'th', message: 'ผู้ป่วยปอดอักเสบชุมชนแบบผู้ป่วยนอก ควรเริ่มยาปฏิชีวนะตัวไหนก่อนครับ' });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.language_retry).toBe(true);
  });

  test('a Thai message with English drug names still counts as Thai (share is over letters)', async () => {
    callAI.mockResolvedValueOnce(r(EN_OK, 10, 10)).mockResolvedValueOnce(r(THAI_OK, 10, 10));
    const res = await send({ language: 'th', message: 'ผู้ป่วยเบาหวาน ควรเริ่ม metformin ก่อนหรือ SGLT2i ครับ เพราะ eGFR ลดลง' });
    expect(res.body.language_retry).toBe(true);
  });
});

describe('artifact blocks and reference lists are not language evidence', () => {
  const THAI_LEAD = 'ผู้ป่วยรายนี้เข้าได้กับปอดอักเสบ ควรประเมินความรุนแรงก่อน (IDSA/ATS, 2019)';

  test('a Thai lead plus an English DDx artifact: no retry', async () => {
    callAI.mockResolvedValueOnce(r(`${THAI_LEAD}\n${FENCE(EN_TABLE)}\n❓ คุณคิดถึงโรคใดอีก`, 10, 10));
    const res = await send({ language: 'th', artifacts: true });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.language_retry).toBe(false);
  });

  test('a Thai answer plus an English trailing References list: no retry', async () => {
    const refs = '\n\n**References:**\n1. Metlay JP, Waterer GW, Long AC, et al. Diagnosis and treatment of adults with community-acquired pneumonia. Am J Respir Crit Care Med.\n2. Mandell LA, Wunderink RG, Anzueto A, et al. Infectious Diseases Society of America and American Thoracic Society consensus guidelines.';
    callAI.mockResolvedValueOnce(r(`${THAI_LEAD}${refs}`, 10, 10));
    const res = await send({ language: 'th' });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.language_retry).toBe(false);
  });

  test('an English reply carrying an artifact IS still caught, and the rewrite sees the fence intact and is told to keep it', async () => {
    const english = `${EN_OK}\n${FENCE(EN_TABLE)}`;
    const thai = `${THAI_OK}\n${FENCE(EN_TABLE)}`;
    callAI.mockResolvedValueOnce(r(english, 10, 10)).mockResolvedValueOnce(r(thai, 10, 10));
    const res = await send({ language: 'th', artifacts: true });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.language_retry).toBe(true);
    const msgs = callAI.mock.calls[1][0].messages;
    expect(msgs[msgs.length - 2].content).toContain(':::artifact{type="differential"');   // fence NOT stripped
    expect(msgs[msgs.length - 2].content).toMatch(/\n:::$/);
    expect(msgs[msgs.length - 1].content).toMatch(/:::artifact/);
    expect(msgs[msgs.length - 1].content).toMatch(/Keep any :::artifact block exactly as is/);
    expect(res.body.content).toContain(':::artifact{type="differential"');
  });

  test('with artifacts OFF a stray fence is still stripped before replay, as for the citation retry', async () => {
    callAI.mockResolvedValueOnce(r(`${EN_OK}\n${FENCE(EN_TABLE)}`, 10, 10)).mockResolvedValueOnce(r(THAI_OK, 10, 10));
    await send({ language: 'th', artifacts: false });
    const msgs = callAI.mock.calls[1][0].messages;
    expect(msgs[msgs.length - 2].content).not.toContain(':::');
  });

  test('a citation retry still strips the fence (it re-answers; unchanged)', async () => {
    callAI.mockResolvedValueOnce(r(`${EN_NO_CITE}\n${FENCE(EN_TABLE)}`, 10, 10)).mockResolvedValueOnce(r(EN_OK, 10, 10));
    await send({ language: 'en', artifacts: true });
    const msgs = callAI.mock.calls[1][0].messages;
    expect(msgs[msgs.length - 2].content).not.toContain(':::');
  });

  test('rescue.reply_check is computed on the REWRITTEN text', async () => {
    // First reply: English with 3 questions (fails the check). Rewrite: Thai with one. If reply_check
    // were taken from the first reply it would read questions:3, ok:false.
    const first = 'What have you considered? What else? Anything about the history?';
    const second = 'คุณพิจารณาสาเหตุที่เป็นไปได้ของอาการเหล่านี้ไว้อย่างไรบ้างแล้ว ❓';
    callAI.mockResolvedValueOnce(r(first, 10, 10)).mockResolvedValueOnce(r(second, 10, 10));
    const res = await send({ language: 'th', socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS, message: 'ผมไม่แน่ใจว่าควรทำอย่างไรต่อครับ' });
    expect(res.body.language_retry).toBe(true);
    expect(res.body.content).toBe(second);
    expect(res.body.rescue.reply_check).toMatchObject({ questions: 1, ok: true });
  });
});
