// RESCUE RETRY — a rescue reply that breaks the rescue rules (no question, too many questions, or a
// diagnosis/plan; services/rescue.js checkRescueReply) gets the SAME single corrective retry as the
// citation and language guards: a REWRITE into questions, asked in the last user turn. Measured
// 2026-10-03: the local model ignored the rescue system prompt on 6/12 and 10/18 turns.
//
// HERMETIC: callAI is mocked at the seam; RAG and Supabase are stubbed.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const { RIMPL_SYSTEM_PROMPT_RESCUE } = require('../src/lib/prompts');
const { MAX_RESCUE_ROUNDS, RESCUE_RETRY_PROMPT } = require('../src/services/rescue');
const { QueueFullError } = require('../src/services/providers/runtime');

const r = (text, i, o) => ({ text, tokenCount: i + o, inputTokens: i, outputTokens: o, provider: 'local', model: 'm' });
// Round cap reached → the rescue prompt runs with no classifier call (hermetic).
const rescueTurn = (body = {}) => request(app).post('/chat').send({
  ple_id: 'x', history: [], message: 'What is the rivaroxaban dose for AF?', language: 'en',
  socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS, ...body,
});
const ANSWER = 'Rivaroxaban 20 mg once daily with the evening meal; 15 mg when CrCl is 15-49 mL/min (ROCKET AF, 2011).';
const QUESTION = 'What would you check before choosing a dose for this patient?';

let warn;
beforeEach(() => { callAI.mockReset(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe('rescue retry (chat.js)', () => {
  test('a rescue reply with no question gets ONE rewrite retry, under the rescue prompt, and the rewrite is returned', async () => {
    callAI.mockResolvedValueOnce(r(ANSWER, 100, 40)).mockResolvedValueOnce(r(QUESTION, 160, 15));
    const res = await rescueTurn();
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.content).toBe(QUESTION);
    expect(res.body.rescue_retry).toBe(true);
    expect(res.body.rescue.reply_check).toMatchObject({ ok: true, questions: 1 });
    const call = callAI.mock.calls[1][0];
    expect(call.systemPrompt).toBe(RIMPL_SYSTEM_PROMPT_RESCUE);
    expect(call.messages.at(-2)).toEqual({ role: 'assistant', content: ANSWER });
    expect(call.messages.at(-1)).toEqual({ role: 'user', content: RESCUE_RETRY_PROMPT.en });
    expect(res.body.token_count).toBe(140 + 175);   // both calls billed
  });

  test('a Thai rescue turn gets the Thai rewrite prompt', async () => {
    callAI.mockResolvedValueOnce(r('ให้ rivaroxaban 20 mg วันละครั้ง (ROCKET AF, 2011)', 10, 10)).mockResolvedValueOnce(r('คุณจะประเมินอะไรก่อนเลือกขนาดยา?', 10, 10));
    const res = await rescueTurn({ language: 'th', message: 'ขนาดยา rivaroxaban สำหรับ AF เท่าไรครับ' });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(callAI.mock.calls[1][0].messages.at(-1).content).toBe(RESCUE_RETRY_PROMPT.th);
    expect(res.body.rescue_retry).toBe(true);
  });

  test('a rescue reply that already follows the rules does NOT retry', async () => {
    callAI.mockResolvedValueOnce(r(QUESTION, 10, 10));
    const res = await rescueTurn();
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.rescue_retry).toBe(false);
  });

  test('a non-rescue turn is never put through the rescue retry', async () => {
    callAI.mockResolvedValueOnce(r(`${ANSWER}\n❓ How would renal function change your choice?`, 10, 10));
    const res = await request(app).post('/chat').send({ ple_id: 'x', history: [], message: 'dose?', language: 'en', socratic: true });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.rescue_retry).toBe(false);
  });

  test('a failed rescue retry keeps the first (deliverable) reply and logs the code only', async () => {
    callAI.mockResolvedValueOnce(r(ANSWER, 100, 40))
      .mockRejectedValueOnce(new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 }));
    const res = await rescueTurn();
    expect(res.status).toBe(200);
    expect(res.body.content).toBe(ANSWER);
    expect(res.body.rescue_retry).toBe(false);
    expect(res.body.token_count).toBe(140);
    expect(warn.mock.calls[0][0]).toMatch(/rescue retry failed \(queue_full\)/);
    expect(warn.mock.calls[0][0]).not.toContain('Rivaroxaban');
  });

  test('still at most TWO calls when the rewrite also breaks the rules', async () => {
    callAI.mockResolvedValueOnce(r(ANSWER, 10, 10)).mockResolvedValueOnce(r(ANSWER, 10, 10));
    const res = await rescueTurn();
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body.rescue.reply_check).toMatchObject({ ok: false, noQuestion: true });
  });
});
