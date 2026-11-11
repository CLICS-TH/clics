// FAST/DEEP ROUTER in the chat route (services/router.js; app setting chat_router_enabled, forwarded as
// `router_enabled`; the sticky latch as `deep_mode`). Pinned here:
//   * OFF (the default) changes nothing a provider receives: no `thinking`, no `onReasoning`, the usual
//     ceiling, no SSE `status` — and `middleware_flags` is present with the router fields null;
//   * ON, the route is computed on the DE-IDENTIFIED message, after the rescue decision;
//   * the tier is APPLIED only when the chat provider honours `thinking`: fast -> thinking:false at
//     CHAT_MAX_TOKENS, deep -> thinking:true at CHAT_DEEP_MAX_TOKENS;
//   * a corrective retry NEVER thinks: after an applied tier (fast or deep) it is thinking:false at
//     CHAT_MAX_TOKENS — a rewrite of a reply the first call already reasoned out, kept inside the turn's
//     deadline — and the marker-only evidence call keeps EVIDENCE_LINE_MAX_TOKENS and thinking:false;
//     the flags keep describing the first call;
//   * middleware_flags (7 keys) on every success, and the SSE `done` body equals the JSON body;
//   * SSE `status` {phase:'thinking'} once, on the first reasoning signal, never after the first delta.
//
// HERMETIC: callAI and the capability queries are mocked at the seam; RAG and Supabase are stubbed.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn(),
  providerSupportsThinking: jest.fn(),
  supportsThinking: jest.fn(),
}));
jest.mock('../src/services/router', () => {
  const actual = jest.requireActual('../src/services/router');
  return { ...actual, routeTurn: jest.fn(actual.routeTurn) };
});
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, providerSupportsThinking, supportsThinking } = require('../src/services/ai');
const { routeTurn, ROUTER_LABEL } = require('../src/services/router');
const { MAX_RESCUE_ROUNDS } = require('../src/services/rescue');
const P = require('../src/lib/prompts');
const { CHAT_MAX_TOKENS, CHAT_DEEP_MAX_TOKENS, EVIDENCE_LINE_MAX_TOKENS } = require('../src/lib/turn-limits');

const GOOD = 'Start amoxicillin 1 g three times daily for 5 days (BTS, 2019).';
const NO_CITE = 'Start amoxicillin 1 g three times daily for 5 days.';
const FAST_Q = 'First-line antibiotic for CAP?';
const DEEP_Q = 'What dose of amoxicillin for CAP?';
const FLAG_KEYS = ['evidence_level', 'failed_over_from', 'reason', 'router_version', 'thinking', 'thinking_budget', 'tier'];

const r = (text, over = {}) => ({ text, tokenCount: 20, inputTokens: 10, outputTokens: 10, provider: 'local-tutor', model: 'qwen-tutor', ...over });
const send = (body = {}) => request(app).post('/chat').send({ ple_id: 'x', history: [], message: FAST_Q, language: 'en', ...body });
const routed = (body = {}) => send({ router_enabled: true, ...body });
const call = (n) => callAI.mock.calls[n][0];
const thinks = (yes = true) => {
  providerSupportsThinking.mockResolvedValue(yes);
  supportsThinking.mockImplementation((name) => yes && name === 'local-tutor');
};

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const ev = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

let warn;
beforeEach(() => {
  callAI.mockReset();
  providerSupportsThinking.mockReset();
  supportsThinking.mockReset();
  routeTurn.mockClear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('router OFF (the default): what a provider receives is unchanged', () => {
  test('no route, no capability query, no thinking / onReasoning keys, the usual ceiling; flags all null', async () => {
    callAI.mockResolvedValueOnce(r(GOOD));
    const res = await send({ message: DEEP_Q, deep_mode: true });   // deep_mode means nothing without the router
    expect(res.status).toBe(200);
    expect(routeTurn).not.toHaveBeenCalled();
    expect(providerSupportsThinking).not.toHaveBeenCalled();
    expect(callAI).toHaveBeenCalledTimes(1);
    expect(call(0)).not.toHaveProperty('thinking');
    expect(call(0)).not.toHaveProperty('onReasoning');
    expect(call(0).maxTokens).toBe(CHAT_MAX_TOKENS);
    expect(res.body.middleware_flags).toEqual({
      router_version: null, tier: null, reason: null, thinking: null, thinking_budget: null, evidence_level: null, failed_over_from: null,
    });
  });

  test('middleware_flags mirrors evidence_level and failed_over_from even with the router off', async () => {
    const MARK = P.evidenceLineFor('moderate');
    callAI.mockResolvedValueOnce(r(`${GOOD}\n\n${MARK}`, { provider: 'anthropic', failed_over_from: 'local-tutor' }));
    const res = await send({ evidence_marker: true });
    expect(res.body.evidence_level).toBe('moderate');
    expect(res.body.middleware_flags).toMatchObject({ evidence_level: 'moderate', failed_over_from: 'local-tutor', thinking: null });
    expect(res.body.failed_over_from).toBe('local-tutor');
  });

  test('an evidence-only retry with the router off carries no thinking key either', async () => {
    callAI.mockResolvedValueOnce(r(GOOD)).mockResolvedValueOnce(r('Evidence: moderate'));
    const res = await send({ evidence_marker: true });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(call(1).maxTokens).toBe(EVIDENCE_LINE_MAX_TOKENS);
    expect(call(1)).not.toHaveProperty('thinking');
  });
});

describe('router ON: the route is computed, and applied only where the provider can think', () => {
  test('the provider cannot think: routed and recorded, NOT applied — the request is the router-off one', async () => {
    thinks(false);
    callAI.mockResolvedValueOnce(r(GOOD, { provider: 'anthropic' }));
    const res = await routed({ message: DEEP_Q });
    expect(providerSupportsThinking).toHaveBeenCalledWith('chat');
    expect(call(0)).not.toHaveProperty('thinking');
    expect(call(0).maxTokens).toBe(CHAT_MAX_TOKENS);
    expect(res.body.middleware_flags).toEqual({
      router_version: ROUTER_LABEL, tier: 'deep', reason: 'dosing', thinking: null, thinking_budget: null, evidence_level: null, failed_over_from: null,
    });
  });

  test('fast: thinking:false at CHAT_MAX_TOKENS', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(GOOD));
    const res = await routed();
    expect(call(0)).toMatchObject({ thinking: false, maxTokens: CHAT_MAX_TOKENS });
    expect(res.body.middleware_flags).toMatchObject({ router_version: ROUTER_LABEL, tier: 'fast', reason: 'default', thinking: false, thinking_budget: null });
  });

  test('deep: thinking:true at CHAT_DEEP_MAX_TOKENS, and the budget recorded', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(GOOD));
    const res = await routed({ message: DEEP_Q });
    expect(call(0)).toMatchObject({ thinking: true, maxTokens: CHAT_DEEP_MAX_TOKENS });
    expect(CHAT_DEEP_MAX_TOKENS).toBeGreaterThan(CHAT_MAX_TOKENS);
    expect(res.body.middleware_flags).toMatchObject({ tier: 'deep', reason: 'dosing', thinking: true, thinking_budget: CHAT_DEEP_MAX_TOKENS });
    expect(Object.keys(res.body.middleware_flags).sort()).toEqual(FLAG_KEYS);
    // The exact rules: router-vN+<12 hex of ROUTER_RULES_SHA256> — the format the backend validates.
    expect(res.body.middleware_flags.router_version).toMatch(/^router-v\d+\+[0-9a-f]{12}$/);
  });

  test('sticky: deep_mode latches deep on a turn with no keyword', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(GOOD));
    const res = await routed({ deep_mode: true });
    expect(call(0).thinking).toBe(true);
    expect(res.body.middleware_flags).toMatchObject({ tier: 'deep', reason: 'sticky' });
  });

  test('a rescue turn is fast, whatever the message and the latch (decided AFTER the rescue decision)', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r('What would you check before choosing a dose?'));
    const res = await routed({ message: DEEP_Q, deep_mode: true, socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS });
    expect(res.body.rescue.rescuing).toBe(true);
    expect(call(0).systemPrompt).toBe(P.RIMPL_SYSTEM_PROMPT_RESCUE);
    expect(call(0)).toMatchObject({ thinking: false, maxTokens: CHAT_MAX_TOKENS });
    expect(res.body.middleware_flags).toMatchObject({ tier: 'fast', reason: 'rescue', thinking: false });
    expect(routeTurn.mock.calls[0][0]).toMatchObject({ rescuing: true, sticky: true });
  });

  test('the router reads the DE-IDENTIFIED message — the very string the model receives', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(GOOD));
    const raw = 'นายสมชาย ใจดี HN 1234567 contact dose@example.com about the plan';
    const res = await routed({ message: raw, language: 'th' });
    const seen = routeTurn.mock.calls[0][0].message;
    expect(seen).not.toMatch(/สมชาย|1234567|dose@example\.com/);
    expect(call(0).messages.at(-1).content).toContain(seen);
    // The raw e-mail would have routed deep ('dose'); its mask cannot.
    expect(res.body.middleware_flags).toMatchObject({ tier: 'fast', reason: 'default' });
    expect(JSON.stringify(res.body.middleware_flags)).not.toMatch(/สมชาย|1234567|example/);
  });

  test('the capability query failing fails the turn loudly (as callAI would), before anything is sent', async () => {
    providerSupportsThinking.mockRejectedValueOnce(new Error('AI provider "local-tutor" cannot serve "chat"'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await routed();
      expect(res.status).toBe(500);
      expect(callAI).not.toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });
});

describe('a corrective retry never thinks: thinking:false at the fast ceiling, whatever the tier', () => {
  test('deep + citation retry: thinking:false at CHAT_MAX_TOKENS, pinned; the flags still describe the deep first call', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(NO_CITE)).mockResolvedValueOnce(r(GOOD));
    const res = await routed({ message: DEEP_Q });
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(call(0)).toMatchObject({ thinking: true, maxTokens: CHAT_DEEP_MAX_TOKENS });
    expect(call(1)).toMatchObject({ provider: 'local-tutor', thinking: false, maxTokens: CHAT_MAX_TOKENS });
    expect(res.body.content).toBe(GOOD);
    expect(res.body.middleware_flags).toMatchObject({ tier: 'deep', thinking: true, thinking_budget: CHAT_DEEP_MAX_TOKENS });
  });

  test('deep + language rewrite: thinking:false at CHAT_MAX_TOKENS too', async () => {
    thinks();
    const english = 'Amoxicillin 1 g three times daily is first line for mild CAP (BTS, 2019).';
    callAI.mockResolvedValueOnce(r(english)).mockResolvedValueOnce(r('ให้ amoxicillin หนึ่งกรัมวันละสามครั้งเป็นยาตัวแรก (BTS, 2019)'));
    const res = await routed({ message: 'ขนาดยา amoxicillin สำหรับปอดอักเสบชุมชนเท่าไรครับ', language: 'th' });
    expect(res.body.language_retry).toBe(true);
    expect(call(0)).toMatchObject({ thinking: true, maxTokens: CHAT_DEEP_MAX_TOKENS });
    expect(call(1)).toMatchObject({ thinking: false, maxTokens: CHAT_MAX_TOKENS });
  });

  test('fast + citation retry: thinking:false at CHAT_MAX_TOKENS', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(NO_CITE)).mockResolvedValueOnce(r(GOOD));
    await routed();
    expect(call(1)).toMatchObject({ thinking: false, maxTokens: CHAT_MAX_TOKENS });
  });

  test('deep + evidence-only: the marker-only call keeps EVIDENCE_LINE_MAX_TOKENS and thinking:false', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(GOOD)).mockResolvedValueOnce(r('Evidence: moderate'));
    const res = await routed({ message: DEEP_Q, evidence_marker: true });
    expect(call(1)).toMatchObject({ thinking: false, maxTokens: EVIDENCE_LINE_MAX_TOKENS });
    expect(res.body.evidence_level).toBe('moderate');
    expect(res.body.middleware_flags).toMatchObject({ thinking: true, evidence_level: 'moderate' });
  });

  test('the provider that ANSWERED cannot think (a fail-over): flags say not applied, the retry sends no thinking', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(NO_CITE, { provider: 'anthropic', failed_over_from: 'local-tutor' })).mockResolvedValueOnce(r(GOOD, { provider: 'anthropic' }));
    const res = await routed({ message: DEEP_Q });
    expect(call(0).thinking).toBe(true);                 // asked of local-tutor
    expect(call(1)).not.toHaveProperty('thinking');      // the pinned retry goes to anthropic, which ignores it
    expect(call(1).maxTokens).toBe(CHAT_MAX_TOKENS);      // a retry always runs at the fast ceiling
    expect(res.body.middleware_flags).toMatchObject({ tier: 'deep', thinking: null, thinking_budget: null, failed_over_from: 'local-tutor' });
  });
});

// A callAI double that, when streamed, reports reasoning and text in the given order.
const scripted = (steps, over = {}) => async ({ onDelta, onReasoning }) => {
  let text = '';
  for (const s of steps) {
    if (s === 'R') onReasoning?.();
    else { text += s; onDelta?.(s); }
  }
  return r(text, over);
};

describe('SSE: status {phase:"thinking"} once, before any text; done = the JSON body', () => {
  const stream = (body) => routed({ stream: true, ...body });

  test('reasoning, then text: exactly one status, first; middleware_flags in done equals the plain JSON body', async () => {
    thinks();
    callAI.mockImplementationOnce(scripted(['R', 'R', 'Start amoxicillin ', 'R', '1 g three times daily for 5 days (BTS, 2019).']));
    const res = await stream({ message: DEEP_Q });
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['status', 'delta', 'delta', 'done']);
    expect(events[0].data).toEqual({ phase: 'thinking' });
    expect(typeof call(0).onReasoning).toBe('function');
    const done = events.at(-1).data;
    expect(done.status).toBe(200);

    callAI.mockImplementationOnce(scripted([GOOD]));
    const plain = await routed({ message: DEEP_Q });
    expect(done.body.middleware_flags).toEqual(plain.body.middleware_flags);
    expect(done.body.middleware_flags).toMatchObject({ tier: 'deep', thinking: true, thinking_budget: CHAT_DEEP_MAX_TOKENS });
  });

  test('never after the first content delta', async () => {
    thinks();
    callAI.mockImplementationOnce(scripted(['Start amoxicillin ', 'R', '1 g three times daily for 5 days (BTS, 2019).']));
    const events = parseSse((await stream()).text);
    expect(events.map((e) => e.event)).toEqual(['delta', 'delta', 'done']);
  });

  test('the router is on but the provider cannot think: status still reports real reasoning, no thinking key sent', async () => {
    thinks(false);
    callAI.mockImplementationOnce(scripted(['R', GOOD], { provider: 'anthropic' }));
    const events = parseSse((await stream({ message: DEEP_Q })).text);
    expect(events[0]).toEqual({ event: 'status', data: { phase: 'thinking' } });
    expect(call(0)).not.toHaveProperty('thinking');
  });

  test('router OFF: no onReasoning is passed, so no status can ever be sent', async () => {
    callAI.mockImplementationOnce(scripted(['R', GOOD]));
    const res = await send({ stream: true });
    expect(call(0)).not.toHaveProperty('onReasoning');
    expect(parseSse(res.text).map((e) => e.event)).toEqual(['delta', 'done']);
    expect(parseSse(res.text).at(-1).data.body.middleware_flags).toMatchObject({ router_version: null, thinking: null });
  });

  test('a non-streamed turn gets no onReasoning even with the router on', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(GOOD));
    await routed();
    expect(call(0)).not.toHaveProperty('onReasoning');
  });

  test('a failure after reasoning began arrives as the done event with its usual status', async () => {
    thinks();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      callAI.mockImplementationOnce(async ({ onReasoning }) => {
        onReasoning();
        throw Object.assign(new Error('local tutor AI stream: the reply ended before the server finished it'), { status: 502, code: 'stream_incomplete' });
      });
      const events = parseSse((await stream({ message: DEEP_Q })).text);
      expect(events.map((e) => e.event)).toEqual(['status', 'done']);
      expect(events[1].data.status).toBe(500);
      expect(JSON.stringify(events[1].data.body)).not.toMatch(/ended before/);   // the generic message, as before
    } finally { err.mockRestore(); }
  });

  test('a rescue turn is never streamed, so it never gets onReasoning or a status', async () => {
    thinks();
    callAI.mockImplementationOnce(scripted(['R', 'What would you check first?']));
    const res = await stream({ socratic: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(call(0)).not.toHaveProperty('onReasoning');
  });
});
