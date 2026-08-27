// Socratic rescue — CREC082 PLE Instruction Sheet §4.
//
// The protocol tells the ethics committee that Socratic mode is "a standardized rescue ... not an
// experimental arm". Two things therefore have to be true and stay true: it is decided from the
// conversation (never from the physician or the episode), and it asks rather than answers. Both are
// pinned here, because a regression in either turns a learning scaffold back into a trial arm.

jest.mock('../src/services/ai', () => ({ callAI: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const {
  countExchanges, shouldAssess, rescueDecision, checkRescueReply, RESCUE_AFTER_EXCHANGES,
} = require('../src/services/rescue');

// 4 physician turns + the AI turns between them = the protocol's "4 exchanges".
const fourExchanges = () => Array.from({ length: 4 }).flatMap((_, i) => ([
  { role: 'physician', content: `q${i}` }, { role: 'assistant', content: `a${i}` },
]));

// The classifier reply, then the chat reply — in the order the route makes them.
const mockTurn = ({ criteria, reply }) => {
  callAI.mockReset();
  if (criteria) callAI.mockResolvedValueOnce({ text: JSON.stringify(criteria), tokenCount: 10, provider: 'anthropic', model: 'm' });
  callAI.mockResolvedValue({ text: reply, tokenCount: 100, provider: 'anthropic', model: 'm' });
};

const QUALIFYING = { c4: true, c5: true, c6: true, c7: true, on_topic: true };
const SHALLOW    = { c4: true, c5: false, c6: false, c7: false, on_topic: true };
const OFF_TOPIC  = { c4: false, c5: false, c6: false, c7: false, on_topic: false };
const post = (body) => request(app).post('/chat').send({ cle_id: 'x', language: 'en', ...body });

describe('the trigger is the conversation, not the physician', () => {
  test('counts a physician turn as an exchange, under either role label', () => {
    expect(countExchanges([{ role: 'physician' }, { role: 'assistant' }, { role: 'user' }])).toBe(2);
    expect(RESCUE_AFTER_EXCHANGES).toBe(4);
  });

  test('below 4 exchanges: no classifier call at all, so no rescue is even possible', async () => {
    mockTurn({ reply: 'Metformin is first-line (ADA, 2024).' });
    await post({ history: [{ role: 'physician', content: 'q' }, { role: 'assistant', content: 'a' }], message: 'q2' });
    expect(callAI).toHaveBeenCalledTimes(1);              // the reply only
    expect(callAI.mock.calls[0][0].purpose).toBe('chat'); // never 'criteria'
  });

  test('at 4 exchanges and not qualifying → the reply is generated from the RESCUE prompt', async () => {
    mockTurn({ criteria: SHALLOW, reply: 'What are you weighing here? What would change your mind?' });
    const res = await post({ history: fourExchanges(), message: 'and again?' });
    expect(callAI.mock.calls[0][0].purpose).toBe('criteria');
    expect(callAI.mock.calls[1][0].systemPrompt).toMatch(/Ask ONE or TWO open questions/);
    expect(res.body.rescue).toMatchObject({ activated: true, reason: 'not_qualifying', exchanges_before: 4 });
  });

  test('off-topic is recorded as its own reason — the SAP analyses trigger reasons', async () => {
    mockTurn({ criteria: OFF_TOPIC, reply: 'What clinical question brought you here?' });
    const res = await post({ history: fourExchanges(), message: 'what is the weather' });
    expect(res.body.rescue).toMatchObject({ activated: true, reason: 'off_topic' });
  });

  test('a session that already qualifies is left alone', async () => {
    mockTurn({ criteria: QUALIFYING, reply: 'Renal function matters here (KDIGO, 2024).' });
    const res = await post({ history: fourExchanges(), message: 'so I have learned...' });
    expect(res.body.rescue).toMatchObject({ activated: false, reason: null, qualifying: true });
    expect(callAI.mock.calls[1][0].systemPrompt).not.toMatch(/Ask ONE or TWO open questions/);
  });

  test('the turn just sent counts — a physician who qualifies WITH this message is not rescued', async () => {
    mockTurn({ criteria: QUALIFYING, reply: 'Good (ADA, 2024).' });
    await post({ history: fourExchanges(), message: 'So I have learned that eGFR drives the choice.' });
    const sentToClassifier = callAI.mock.calls[0][0].messages[0].content;
    expect(sentToClassifier).toMatch(/eGFR drives the choice/);
  });

  test('latches: an already-rescued or already-qualified session pays no classifier call', () => {
    const h = fourExchanges();
    expect(shouldAssess({ history: h })).toBe(true);
    expect(shouldAssess({ history: h, rescueActive: true })).toBe(false);
    expect(shouldAssess({ history: h, alreadyQualified: true })).toBe(false);
    // A session already running as examiner has nothing to rescue.
    expect(shouldAssess({ history: h, socraticActive: true })).toBe(false);
  });

  test('a classifier failure degrades to a normal turn rather than costing the physician their turn', async () => {
    callAI.mockReset();
    callAI.mockRejectedValueOnce(new Error('classifier down'));
    callAI.mockResolvedValue({ text: 'Metformin is first-line (ADA, 2024).', tokenCount: 100, provider: 'anthropic', model: 'm' });
    const res = await post({ history: fourExchanges(), message: 'q' });
    expect(res.status).toBe(200);
    expect(res.body.rescue).toBeNull();
    expect(res.body.content).toMatch(/Metformin/);
  });
});

describe('a rescue asks, it does not answer', () => {
  test('the prompt forbids diagnosing and caps the questions at two', () => {
    const { RIMPL_SYSTEM_PROMPT_RESCUE } = require('../src/lib/prompts');
    expect(RIMPL_SYSTEM_PROMPT_RESCUE).toMatch(/Never more than two/);
    expect(RIMPL_SYSTEM_PROMPT_RESCUE).toMatch(/Do NOT give a diagnosis/);
    expect(RIMPL_SYSTEM_PROMPT_RESCUE).toMatch(/genuinely open/);
    // The physician must not be told the mode changed.
    expect(RIMPL_SYSTEM_PROMPT_RESCUE).toMatch(/Do not mention that a mode changed/);
  });

  test('the reply is checked, not merely requested', () => {
    expect(checkRescueReply('What are you weighing?')).toMatchObject({ ok: true, questions: 1 });
    expect(checkRescueReply('A? B? C?')).toMatchObject({ ok: false, tooManyQuestions: true });
    expect(checkRescueReply('Consider the differential.')).toMatchObject({ ok: false, diagnostic: true, noQuestion: true });
    expect(checkRescueReply('I would start metformin. What do you think?')).toMatchObject({ ok: false, diagnostic: true });
    // Thai: the check must not be English-only, since most sessions are in Thai.
    expect(checkRescueReply('แนะนำให้เริ่มยา metformin ครับ คุณคิดว่าอย่างไร?')).toMatchObject({ diagnostic: true });
  });

  test('the citation retry is skipped on a rescue turn', async () => {
    // A rescue reply cites nothing by design. Retrying for a citation would prompt the model to
    // answer — the one thing the rescue must not do.
    mockTurn({ criteria: SHALLOW, reply: 'What would change your mind?' }); // no (Source, Year)
    await post({ history: fourExchanges(), message: 'q' });
    expect(callAI).toHaveBeenCalledTimes(2); // classifier + one reply, no third call
  });

  test('the post-check result travels with the response so a bad rescue is visible', async () => {
    mockTurn({ criteria: SHALLOW, reply: 'The differential is wide.' }); // diagnostic, no question
    const res = await post({ history: fourExchanges(), message: 'q' });
    expect(res.body.rescue.reply_check).toMatchObject({ ok: false, diagnostic: true, noQuestion: true });
  });
});

describe('rescueDecision', () => {
  test('off-topic outranks not-qualifying — it is the more specific failure', () => {
    expect(rescueDecision({ onTopic: false, qualifying: false })).toEqual({ rescue: true, reason: 'off_topic' });
    expect(rescueDecision({ onTopic: true, qualifying: false })).toEqual({ rescue: true, reason: 'not_qualifying' });
    expect(rescueDecision({ onTopic: true, qualifying: true })).toEqual({ rescue: false, reason: null });
  });
});
