// EVIDENCE MARKER in the chat route (CCME R5; app setting chat_evidence_marker, forwarded as
// `evidence_marker`). Pinned here:
//   * OFF (the default) changes nothing: same system prompt, same single call, evidence_level null;
//   * ON appends EVIDENCE_GUIDANCE for the mode — never on a rescue turn;
//   * a missing / ambiguous marker is folded into the EXISTING single corrective retry (<= 2 calls);
//   * evidence-only: SPLICE, DON'T ADOPT — a small call asks for the line alone, and that one line is
//     written into the FIRST reply, which otherwise survives byte for byte (artifact included);
//   * combined failures (citation + evidence, language + evidence) keep the full re-answer / rewrite;
//   * streaming: natural appends a plain delta (no replace); examiner replaces with the spliced reply;
//     the `done` body equals the non-streamed JSON.
//
// HERMETIC: callAI is mocked at the seam; RAG and Supabase are stubbed; nothing leaves the process.
jest.mock('../src/services/ai', () => ({ callAI: jest.fn() }));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI } = require('../src/services/ai');
const P = require('../src/lib/prompts');
const { promptLabel } = require('../src/lib/versions');
const { MAX_RESCUE_ROUNDS } = require('../src/services/rescue');
const { QueueFullError } = require('../src/services/providers/runtime');
const { CHAT_MAX_TOKENS, EVIDENCE_LINE_MAX_TOKENS } = require('../src/lib/turn-limits');

const MARK = P.evidenceLineFor('moderate');
const EN = 'Amoxicillin 1 g three times daily for 5 days is first line for low-severity CAP (BTS, 2019).';
const EN_NO_CITE = 'Amoxicillin 1 g three times daily for 5 days is first line for low-severity CAP.';
const EN_M = `${EN}\n${MARK}`;
const Q = '❓ How would a penicillin allergy change your choice?';
const TH = 'ผู้ป่วยปอดอักเสบชุมชนความรุนแรงต่ำควรได้รับ amoxicillin หนึ่งกรัมวันละสามครั้งเป็นเวลาห้าวัน (BTS, 2019)';
const TH_MSG = 'ผู้ป่วยปอดอักเสบชุมชนแบบผู้ป่วยนอก ควรเริ่มยาปฏิชีวนะตัวไหนก่อนครับ';
const FENCE = (body) => `:::artifact{type="differential" title="DDx"}\n${body}\n:::`;
const DDX = '| Dx | Feature |\n|---|---|\n| CAP | fever, consolidation |\n| PE | pleuritic pain |';

const r = (text, i = 10, o = 10) => ({ text, tokenCount: i + o, inputTokens: i, outputTokens: o, provider: 'local', model: 'm' });
const send = (body = {}) => request(app).post('/chat')
  .send({ ple_id: 'x', history: [], message: 'First-line for CAP?', language: 'en', ...body });
const on = (body = {}) => send({ evidence_marker: true, ...body });
const call = (n) => callAI.mock.calls[n][0];
const lastAsk = (n = 1) => call(n).messages.at(-1).content;

let warn;
beforeEach(() => { callAI.mockReset(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe('setting OFF (the default): nothing changes', () => {
  test('no guidance, one call for a cited reply without a marker, evidence_level null', async () => {
    callAI.mockResolvedValueOnce(r(EN));
    const res = await send();
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0).systemPrompt).toBe(P.RIMPL_SYSTEM_PROMPT_NATURAL);
    expect(res.body).toMatchObject({ evidence_level: null, evidence_retry: false });
    expect(res.body.prompt_version).toBe(promptLabel('chat', P.RIMPL_SYSTEM_PROMPT_NATURAL));
  });

  test('a marker the model wrote anyway is not reported: the field means "checked", and nothing was', async () => {
    callAI.mockResolvedValueOnce(r(EN_M));
    expect((await send()).body.evidence_level).toBeNull();
  });
});

describe('setting ON: the guidance and the check', () => {
  test('the guidance is appended per mode, after any artifact guidance', async () => {
    callAI.mockResolvedValue(r(`${EN}\n${MARK}\n${Q}`));
    await on();
    await on({ socratic: true });
    await on({ artifacts: true });
    await on({ socratic: true, artifacts: true });
    const sys = callAI.mock.calls.map((c) => c[0].systemPrompt);
    expect(sys[0]).toBe(P.RIMPL_SYSTEM_PROMPT_NATURAL + P.EVIDENCE_GUIDANCE.natural);
    expect(sys[1]).toBe(P.RIMPL_SYSTEM_PROMPT_EXAMINER + P.EVIDENCE_GUIDANCE.examiner);
    expect(sys[2]).toBe(P.RIMPL_SYSTEM_PROMPT_NATURAL + P.ARTIFACT_GUIDANCE + P.EVIDENCE_GUIDANCE.natural);
    expect(sys[3]).toBe(P.RIMPL_SYSTEM_PROMPT_EXAMINER + P.ARTIFACT_GUIDANCE + P.EVIDENCE_GUIDANCE.examiner);
  });

  test('a reply carrying one marker: one call, the level is reported, no retry', async () => {
    callAI.mockResolvedValueOnce(r(EN_M));
    const res = await on();
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ content: EN_M, evidence_level: 'moderate', evidence_retry: false });
  });

  test.each([
    ['not graded', P.evidenceLineFor('not_graded'), 'not_graded'],
    ['the short pre-scope form', 'ระดับหลักฐาน: สูง (Evidence: high)', 'high'],
    ['a bare English form', 'Evidence: low', 'low'],
    ['italic + trailing full stop', '*Evidence: expert opinion*.', 'expert'],
  ])('%s is read without a retry', async (_n, line, level) => {
    callAI.mockResolvedValueOnce(r(`${EN}\n${line}`));
    const res = await on();
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.evidence_level).toBe(level);
  });

  test('examiner: the marker just above the ❓ line reads, and the ❓ is still extracted', async () => {
    callAI.mockResolvedValueOnce(r(`${EN}\n${MARK}\n${Q}`));
    const res = await on({ socratic: true });
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(res.body.evidence_level).toBe('moderate');
    expect(res.body.socratic_question).toBe('How would a penicillin allergy change your choice?');
  });
});

describe('marker the ONLY failure: SPLICE, DON\'T ADOPT', () => {
  test('a small call asks for the LINE alone; the canonical line is appended to the FIRST reply', async () => {
    callAI.mockResolvedValueOnce(r(EN, 100, 40)).mockResolvedValueOnce(r('Evidence: moderate', 160, 9));
    const res = await on();
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(lastAsk()).toBe(P.EVIDENCE_RETRY_PROMPT.only.en);
    expect(call(1).maxTokens).toBe(EVIDENCE_LINE_MAX_TOKENS);
    expect(call(0).maxTokens).toBe(CHAT_MAX_TOKENS);
    expect(call(1).messages.at(-2)).toEqual({ role: 'assistant', content: EN });
    expect(call(1).systemPrompt).toBe(call(0).systemPrompt);   // same instructions, same label
    expect(call(1).provider).toBe('local');                       // pinned, as every retry is
    expect(res.body).toMatchObject({ content: EN_M, evidence_level: 'moderate', evidence_retry: true, language_retry: false });
    expect(res.body.token_count).toBe(140 + 169);                 // the small call is billed as usual
    expect(res.body.input_tokens).toBe(260);
    expect(res.body.context_tokens).toBe(140);                    // = the FIRST call's in + out
  });

  test('with artifacts ON, a full rewrite that DROPPED the DDx block cannot reach the physician', async () => {
    const first = `${EN}\n${FENCE(DDX)}`;
    // The model ignores "line only" and returns a whole rewrite without the artifact, plus a marker.
    callAI.mockResolvedValueOnce(r(first)).mockResolvedValueOnce(r(`Amoxicillin is first line (BTS, 2019).\n${MARK}`));
    const res = await on({ artifacts: true });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(call(1).messages.at(-2).content).toBe(first);         // it saw the fence intact
    expect(res.body.content).toBe(`${first}\n${MARK}`);           // first reply byte for byte, + one line
    expect(res.body.content).toContain(':::artifact{type="differential" title="DDx"}');
    expect(res.body.evidence_level).toBe('moderate');
  });

  test('a Thai turn gets the Thai (bilingual) line-only prompt, and the Thai reply is kept as is', async () => {
    callAI.mockResolvedValueOnce(r(TH)).mockResolvedValueOnce(r('ระดับหลักฐาน: ปานกลาง'));
    const res = await on({ language: 'th', message: TH_MSG });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(lastAsk()).toBe(P.EVIDENCE_RETRY_PROMPT.only.th);
    expect(res.body).toMatchObject({ content: `${TH}\n${MARK}`, evidence_level: 'moderate', evidence_retry: true, language_retry: false });
  });

  test('examiner: the line goes directly above the ❓, which stays the last line', async () => {
    callAI.mockResolvedValueOnce(r(`${EN}\n${Q}`)).mockResolvedValueOnce(r(`${MARK}\n❓ And then?`));
    const res = await on({ socratic: true });
    expect(res.body.content).toBe(`${EN}\n${MARK}\n${Q}`);
    expect(res.body.socratic_question).toBe('How would a penicillin allergy change your choice?');
  });

  test('two markers in the first reply (ambiguous) are replaced by the one line', async () => {
    callAI.mockResolvedValueOnce(r(`${EN}\n${MARK}\n${P.evidenceLineFor('high')}`)).mockResolvedValueOnce(r('Evidence: low'));
    const res = await on();
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body).toMatchObject({ content: `${EN}\n${P.evidenceLineFor('low')}`, evidence_level: 'low' });
  });

  test.each([
    ['no marker', 'I would rather not grade this.'],
    ['two markers', `${MARK}\n${P.evidenceLineFor('high')}`],
    ['a self-contradicting marker', 'ระดับหลักฐาน: สูง (Evidence: low)'],
    ['an empty answer', ''],
  ])('%s in the answer: the first reply goes out UNCHANGED, the call still billed', async (_n, answer) => {
    callAI.mockResolvedValueOnce(r(EN, 100, 40)).mockResolvedValueOnce(r(answer, 160, 9));
    const res = await on();
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body).toMatchObject({ content: EN, evidence_level: null, evidence_retry: false });
    expect(res.body.token_count).toBe(140 + 169);
    expect(res.body.context_tokens).toBe(140);
    expect(warn.mock.calls.at(-1)[0]).toMatch(/evidence retry gave no single evidence line/);
    expect(warn.mock.calls.at(-1)[0]).not.toContain('Amoxicillin');
  });

  test('the small call failing (queue_full) keeps the first reply: 200, logged by code only', async () => {
    callAI.mockResolvedValueOnce(r(EN, 100, 40)).mockRejectedValueOnce(new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 }));
    const res = await on();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content: EN, evidence_level: null, evidence_retry: false, token_count: 140 });
    expect(warn.mock.calls[0][0]).toMatch(/evidence retry failed \(queue_full\)/);
  });
});

describe('combined failures keep the full re-answer / rewrite (never a third call)', () => {
  test('citation AND marker missing: the citation re-answer plus the marker suffix, full ceiling', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE)).mockResolvedValueOnce(r(EN_M));
    const res = await on();
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(lastAsk()).toBe('Please answer the original question again, fully and helpfully: include at least one (Source, Year) citation. Engage with the question — do not decline, and do not append a follow-up question.'
      + P.EVIDENCE_RETRY_PROMPT.suffix.en);
    expect(call(1).maxTokens).toBe(CHAT_MAX_TOKENS);
    expect(res.body).toMatchObject({ content: EN_M, evidence_level: 'moderate', evidence_retry: true });
  });

  test('citation AND marker missing, and the re-answer still lacks the marker: the re-answer is returned', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE)).mockResolvedValueOnce(r(EN));
    const res = await on();
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(res.body).toMatchObject({ content: EN, evidence_level: null, evidence_retry: true });
  });

  test('citation + marker: a failed retry still fails closed (the first reply had no citation)', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE)).mockRejectedValueOnce(new QueueFullError({ provider: 'local', lane: 'interactive', maxQueue: 4, retryAfterMs: 30000 }));
    expect((await on()).status).toBe(503);
  });

  test('citation + language + marker on a Thai turn: one prompt carrying all three asks', async () => {
    callAI.mockResolvedValueOnce(r(EN_NO_CITE)).mockResolvedValueOnce(r(`${TH}\n${MARK}`));
    const res = await on({ language: 'th', message: TH_MSG });
    expect(callAI).toHaveBeenCalledTimes(2);
    const ask = lastAsk();
    expect(ask.endsWith(' และเขียนคำตอบทั้งหมดเป็นภาษาไทย (Write the whole reply in Thai.)' + P.EVIDENCE_RETRY_PROMPT.suffix.th)).toBe(true);
    expect(ask).toMatch(/\(แหล่ง, ปี\)/);
    expect(res.body).toMatchObject({ language_retry: true, evidence_retry: true, evidence_level: 'moderate' });
  });

  test('language + marker: the Thai rewrite plus the marker suffix; a Thai rewrite without the marker is still returned', async () => {
    callAI.mockResolvedValueOnce(r(EN)).mockResolvedValueOnce(r(TH));
    const res = await on({ language: 'th', message: TH_MSG });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(lastAsk()).toMatch(/^กรุณาเขียนคำตอบก่อนหน้านี้ใหม่เป็นภาษาไทย/);
    expect(lastAsk().endsWith(P.EVIDENCE_RETRY_PROMPT.suffix.th)).toBe(true);
    expect(call(1).maxTokens).toBe(CHAT_MAX_TOKENS);
    // The language fix is the one that matters: delivered, with the missing marker visible as null.
    expect(res.body).toMatchObject({ content: TH, language_retry: true, evidence_retry: true, evidence_level: null });
  });
});

describe('never on a rescue turn', () => {
  test('the rescue prompt replaces the guidance, a marker-less question is fine, evidence_level null', async () => {
    callAI.mockResolvedValueOnce(r('What would you check before choosing a dose for this patient?'));
    const res = await on({ socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0).systemPrompt).toBe(P.RIMPL_SYSTEM_PROMPT_RESCUE);
    expect(res.body).toMatchObject({ evidence_level: null, evidence_retry: false });
    expect(res.body.prompt_version).toBe(promptLabel('chat', P.RIMPL_SYSTEM_PROMPT_RESCUE));
  });

  test('a rescue rewrite never carries the marker suffix', async () => {
    callAI.mockResolvedValueOnce(r('Rivaroxaban 20 mg once daily (ROCKET AF, 2011).')).mockResolvedValueOnce(r('What are you weighing here?'));
    await on({ socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(lastAsk()).not.toMatch(/evidence-level/);
  });
});

describe('streaming', () => {
  const streamed = (text, i = 10, o = 10) => async ({ onDelta }) => { onDelta?.(text); return r(text, i, o); };
  const parseSse = (t) => t.split('\n\n').filter(Boolean).map((b) => ({
    event: /^event: (.+)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? 'null'),
  }));
  // The same turn, not streamed, for comparing a `done` body with the plain JSON (natural mode).
  const sameAsJson = async (doneBody, mocks) => {
    callAI.mockReset();
    for (const m of mocks) callAI.mockImplementationOnce(m);
    const json = (await on()).body;
    const { superseded_draft: _d, superseded_reason: _r, ...rest } = doneBody;
    return [rest, json];
  };

  test('NATURAL: the line arrives as a plain appended delta — no replace, nothing superseded', async () => {
    callAI.mockImplementationOnce(streamed(EN, 100, 40)).mockImplementationOnce(streamed('Evidence: moderate', 160, 9));
    const ev = parseSse((await on({ stream: true })).text);
    expect(ev.map((e) => e.event)).toEqual(['delta', 'delta', 'done']);
    expect(ev[0].data.text + ev[1].data.text).toBe(EN_M);
    expect(ev[1].data.text).toBe(`\n${MARK}`);
    const done = ev.at(-1).data;
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ content: EN_M, evidence_level: 'moderate', evidence_retry: true, superseded_draft: null, superseded_reason: null });
    expect(call(1).onDelta).toBeUndefined();   // the small call is never streamed
    const [doneBody, json] = await sameAsJson(done.body, [streamed(EN, 100, 40), streamed('Evidence: moderate', 160, 9)]);
    expect(doneBody).toEqual(json);
  });

  test('EXAMINER: replace with the whole spliced reply (❓ stays last); the draft is recorded', async () => {
    const first = `${EN}\n${Q}`;
    callAI.mockImplementationOnce(streamed(first)).mockImplementationOnce(streamed('Evidence: moderate'));
    const ev = parseSse((await on({ stream: true, socratic: true })).text);
    expect(ev.map((e) => e.event)).toEqual(['delta', 'replace', 'delta', 'done']);
    expect(ev[1].data).toEqual({ reason: 'evidence' });
    expect(ev[2].data.text).toBe(`${EN}\n${MARK}\n${Q}`);
    const done = ev.at(-1).data;
    expect(done.body).toMatchObject({ content: `${EN}\n${MARK}\n${Q}`, superseded_draft: first, superseded_reason: 'evidence' });
    callAI.mockReset();
    callAI.mockImplementationOnce(streamed(first)).mockImplementationOnce(streamed('Evidence: moderate'));
    const json = (await on({ socratic: true })).body;
    const { superseded_draft: _d, superseded_reason: _r, ...doneBody } = done.body;
    expect(doneBody).toEqual(json);
  });

  test('no usable line: delta, done — the screen is never cleared and the first reply stands', async () => {
    callAI.mockImplementationOnce(streamed(EN)).mockImplementationOnce(streamed('no marker here'));
    const ev = parseSse((await on({ stream: true })).text);
    expect(ev.map((e) => e.event)).toEqual(['delta', 'done']);
    expect(ev.at(-1).data.body).toMatchObject({ content: EN, evidence_level: null, evidence_retry: false, superseded_draft: null });
  });

  test('a COMBINED failure still replaces the draft as before (citation + evidence)', async () => {
    callAI.mockImplementationOnce(streamed(EN_NO_CITE)).mockImplementationOnce(streamed(EN_M));
    const ev = parseSse((await on({ stream: true })).text);
    expect(ev.map((e) => e.event)).toEqual(['delta', 'replace', 'delta', 'done']);
    expect(ev[1].data).toEqual({ reason: 'citation' });
    expect(ev.at(-1).data.body).toMatchObject({ content: EN_M, superseded_draft: EN_NO_CITE, superseded_reason: 'citation' });
  });
});
