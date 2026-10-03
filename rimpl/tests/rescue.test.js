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
  countExchanges, shouldAssess, rescueExhausted, rescueDecision, checkRescueReply, RESCUE_AFTER_EXCHANGES,
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
const post = (body) => request(app).post('/chat').send({ ple_id: 'x', language: 'en', ...body });

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

  test('a session already in rescue is re-assessed EVERY round, so it can be seen recovering', () => {
    const h = fourExchanges();
    expect(shouldAssess({ history: h })).toBe(true);
    // This used to be false, and that was the bug: a rescued session was assessed exactly once, so
    // nothing could observe it returning to a qualifying conversation. The rescue then never ended
    // and "did it recover?" had no answer in the data. The protocol applies the rescue each round.
    expect(shouldAssess({ history: h, rescueActive: true })).toBe(true);
  });

  test('qualifying is the one latch that stays — it is the only one that is monotonic', () => {
    const h = fourExchanges();
    // A session that has shown reflective synthesis does not stop having shown it, so there is
    // nothing left to re-ask and a long good session never pays for another classifier call.
    expect(shouldAssess({ history: h, alreadyQualified: true })).toBe(false);
    expect(shouldAssess({ history: h, rescueActive: true, alreadyQualified: true })).toBe(false);
  });

  test('examiner mode entered for some other reason is not a rescue', () => {
    expect(shouldAssess({ history: fourExchanges(), socraticActive: true })).toBe(false);
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

// The rescue is a LOOP, not a one-shot. The instruction sheet describes a bounded, non-leading
// intervention applied each round until the conversation returns to being a learning episode.
//
// It used to run exactly once. On the round it fired the session got the rescue prompt; every round
// after that fell through to the general examiner prompt, which cites and answers — a different
// instrument entirely. Nothing post-checked those rounds, and because the session was never
// re-assessed, nothing could observe it recovering: the rescue simply ran until the session ended.
// Module-scope: the bounded-rescue block below asserts the same prompt is still in force at the cap.
const RESCUE_MARKER = /Ask ONE or TWO open questions/;

describe('a rescue that has already fired keeps applying, and can end', () => {
  const rescued = (over) => ({ history: fourExchanges(), message: 'q', rescue_active: true, ...over });

  test('a later round is assessed at all — which is what makes recovery observable', async () => {
    mockTurn({ criteria: SHALLOW, reply: 'What would change your mind?' });
    await post(rescued());
    expect(callAI).toHaveBeenCalledTimes(2);                 // classifier THEN reply
    expect(callAI.mock.calls[0][0].purpose).toBe('criteria');
  });

  test('a later round still not qualifying is generated from the RESCUE prompt', async () => {
    mockTurn({ criteria: SHALLOW, reply: 'What would change your mind?' });
    const res = await post(rescued());
    expect(callAI.mock.calls[1][0].systemPrompt).toMatch(RESCUE_MARKER);
    expect(res.body.rescue).toMatchObject({ rescuing: true, recovered: false });
  });

  test('a later round is POST-CHECKED, so a breach on any round is countable', async () => {
    // A reply that diagnoses and asks three questions. On the old code this round was invisible.
    mockTurn({ criteria: SHALLOW, reply: 'This is an MI. What next? Why? And then?' });
    const res = await post(rescued());
    expect(res.body.rescue.reply_check).toMatchObject({ ok: false });
  });

  test('the activation POINT does not move — a later round is not a new activation', async () => {
    mockTurn({ criteria: SHALLOW, reply: 'What would change your mind?' });
    const res = await post(rescued());
    expect(res.body.rescue.activated).toBe(false);
    expect(res.body.rescue.rescuing).toBe(true);
  });

  test('when the conversation qualifies again the rescue ENDS, and says so', async () => {
    mockTurn({ criteria: QUALIFYING, reply: 'Metformin is first-line (ADA, 2024).' });
    const res = await post(rescued());
    expect(res.body.rescue).toMatchObject({ recovered: true, rescuing: false, qualifying: true });
    // Back to a normal answering turn — the scaffold is not supposed to outlive the problem.
    expect(callAI.mock.calls[1][0].systemPrompt).not.toMatch(RESCUE_MARKER);
  });

  test('a session that has already qualified is never re-assessed, however long it runs', async () => {
    mockTurn({ reply: 'Metformin is first-line (ADA, 2024).' });
    await post({ history: fourExchanges(), message: 'q', rescue_active: true, already_qualified: true });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(callAI.mock.calls[0][0].purpose).toBe('chat');
  });

  test('the classifier cost is reported, so it can be charged to the study and not the physician', async () => {
    callAI.mockReset();
    callAI.mockResolvedValueOnce({ text: JSON.stringify(SHALLOW), tokenCount: 10, inputTokens: 900, outputTokens: 40, provider: 'anthropic', model: 'm' });
    callAI.mockResolvedValue({ text: 'What would change your mind?', tokenCount: 100, provider: 'anthropic', model: 'm' });
    const res = await post(rescued());
    // These tokens were always returned and always thrown away. Invisible was tolerable at one call
    // per session; at one per round it is spend nobody can account for.
    expect(res.body.rescue.assessment).toMatchObject({ input_tokens: 900, output_tokens: 40, provider: 'anthropic' });
  });

  test('a REFUSED reply still reports the classifier cost on the 422, so the study is charged for it', async () => {
    callAI.mockReset();
    callAI.mockResolvedValueOnce({ text: JSON.stringify(SHALLOW), tokenCount: 10, inputTokens: 900, outputTokens: 40, provider: 'anthropic', model: 'm' });
    callAI.mockRejectedValueOnce(Object.assign(new Error('model declined the request (refusal)'), {
      code: 'refused', category: 'general_harms', inputTokens: 1500, outputTokens: 2, model: 'claude-sonnet-5-5',
      usage: { inputTokens: 1500, outputTokens: 2, provider: 'anthropic' },
    }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(rescued());
    warn.mockRestore();
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'refused', input_tokens: 1500, output_tokens: 2,
      assessment: { input_tokens: 900, output_tokens: 40, provider: 'anthropic' } });
  });
});

// Bounding the cost of re-assessing every round, and not losing spend that was already billed.
describe('the rescue loop is bounded', () => {
  test('after enough fruitless rounds it stops paying to re-ask', () => {
    // Per-round re-assessment is what makes recovery observable, but on its own it is unbounded: a
    // session that never qualifies buys an ever-larger classifier call on every turn, and under a
    // paid-classifier / free-local-chat deployment nothing else is spending, so no budget stops it.
    const h = fourExchanges();
    expect(shouldAssess({ history: h, rescueActive: true, rescueRounds: 0 })).toBe(true);
    expect(shouldAssess({ history: h, rescueActive: true, rescueRounds: 7 })).toBe(true);
    expect(shouldAssess({ history: h, rescueActive: true, rescueRounds: 8 })).toBe(false);
    expect(shouldAssess({ history: h, rescueActive: true, rescueRounds: 99 })).toBe(false);
  });

  test('hitting the cap ends the rescue on the RESCUE prompt, and says why', async () => {
    // The version of this test that shipped asserted only `rescue === null` while its comment
    // claimed the rescue prompt stayed in force. It did not: the prompt is only set inside the
    // assess block, so at the cap the turn fell through to the general examiner prompt — the exact
    // instrument swap the per-round rescue exists to prevent, reappearing silently at round nine.
    mockTurn({ reply: 'Metformin is first-line (ADA, 2024).' });
    const res = await post({ history: fourExchanges(), message: 'q', rescue_active: true, rescue_rounds: 20 });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);                       // no classifier call: nothing to pay for
    expect(callAI.mock.calls[0][0].systemPrompt).toMatch(RESCUE_MARKER);
    expect(res.body.rescue).toMatchObject({
      rescuing: true,          // this turn still ran under the rescue constraint
      exhausted: true,         // and it is the last one that will
      recovered: false,
      assessment: { input_tokens: 0, output_tokens: 0 },
    });
  });

  test('an exhausted round is still post-checked — the constraint applies to the last turn too', async () => {
    mockTurn({ reply: 'This is diabetic ketoacidosis. Start insulin.' });
    const res = await post({ history: fourExchanges(), message: 'q', rescue_active: true, rescue_rounds: 20 });
    expect(res.body.rescue.reply_check).not.toBeNull();
    expect(res.body.rescue.reply_check.ok).toBe(false);
  });

  test('the cap does not fire on a session that was never in rescue', () => {
    expect(rescueExhausted({ rescueActive: false, rescueRounds: 99 })).toBe(false);
    expect(rescueExhausted({ rescueActive: true, rescueRounds: 7 })).toBe(false);
    expect(rescueExhausted({ rescueActive: true, rescueRounds: 8 })).toBe(true);
  });

  test('a classifier reply that was BILLED but unparseable still reports its cost', async () => {
    // The call is paid for before the parse fails. Dropping it loses the spend from the study's
    // accounting, and under an active rescue the next turn buys another one — so real cost can
    // drift arbitrarily above what was recorded.
    callAI.mockReset();
    callAI.mockResolvedValueOnce({ text: 'not json at all', tokenCount: 10, inputTokens: 700, outputTokens: 30, provider: 'anthropic', model: 'm' });
    callAI.mockResolvedValue({ text: 'Metformin is first-line (ADA, 2024).', tokenCount: 100, provider: 'anthropic', model: 'm' });
    const res = await post({ history: fourExchanges(), message: 'q', rescue_active: true });

    expect(res.status).toBe(200);                    // the physician still gets their turn
    expect(res.body.rescue.assessment).toMatchObject({ input_tokens: 700, output_tokens: 30 });
    // The assessment itself is unusable, so it must not look like a decision was made.
    expect(res.body.rescue).toMatchObject({ rescuing: false, activated: false, qualifying: null });
  });
});

test('a classifier that answers in prose does NOT rescue the physician', async () => {
  // parseJsonObject returns {} when it finds no JSON — by design, and harmless for callers that read
  // {} as "no answer". Here {} read as all four elements ABSENT, which is indistinguishable from a
  // genuine "not yet a learning episode", so a chatty classifier reply rescued a session that may
  // have been perfectly fine. Per-round assessment turned that from a one-off into every turn.
  callAI.mockReset();
  callAI.mockResolvedValueOnce({ text: 'I think this conversation is going quite well so far.', tokenCount: 10, inputTokens: 500, outputTokens: 20, provider: 'anthropic', model: 'm' });
  callAI.mockResolvedValue({ text: 'Metformin is first-line (ADA, 2024).', tokenCount: 100, provider: 'anthropic', model: 'm' });
  const res = await post({ history: fourExchanges(), message: 'q' });

  expect(res.status).toBe(200);
  expect(res.body.rescue?.rescuing ?? false).toBe(false);
  expect(callAI.mock.calls[1][0].systemPrompt).not.toMatch(/Ask ONE or TWO open questions/);
});
