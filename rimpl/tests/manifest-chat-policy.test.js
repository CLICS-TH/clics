// The model manifest describes the chat route; this suite holds the description to the route's behaviour.
//
// lib/manifest.js records three things about /chat that chat.js does not read from a table of its own
// (its expressions are pinned as TEXT by the quality harness, scripts/quality/request.test.mjs):
//   * the system-prompt label of every variant (lib/prompts.js chatSystemPrompt, which chat.js DOES call);
//   * the router's tier -> thinking / ceiling, and the retry that never thinks (lib/turn-limits.js
//     TIER_POLICY / RETRY_POLICY);
//   * no temperature sent (lib/decoding.js CHAT_DECODING).
// Each is checked here by running the route, so a change to chat.js that the manifest would misreport
// fails CI. HERMETIC: callAI and the capability queries are mocked at the seam; RAG and Supabase stubbed.
jest.mock('../src/services/ai', () => ({
  callAI: jest.fn(),
  providerSupportsThinking: jest.fn(),
  supportsThinking: jest.fn(),
}));
jest.mock('../src/services/rag', () => ({ ragLookup: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/lib/supabase', () => ({
  supabase: { from: jest.fn(() => ({})), rpc: jest.fn().mockResolvedValue({ data: [], error: null }) },
}));

const request = require('supertest');
const app = require('../src/index');
const { callAI, providerSupportsThinking, supportsThinking } = require('../src/services/ai');
const { MAX_RESCUE_ROUNDS } = require('../src/services/rescue');
const P = require('../src/lib/prompts');
const { TIER_POLICY, RETRY_POLICY, CHAT_MAX_TOKENS, CHAT_DEEP_MAX_TOKENS } = require('../src/lib/turn-limits');
const { CHAT_DECODING } = require('../src/lib/decoding');
const M = require('../src/lib/manifest');

const committed = M.readManifest();
const GOOD = 'Start amoxicillin 1 g three times daily for 5 days (BTS, 2019).\n❓ What would change your choice?';
const NO_CITE = 'Start amoxicillin 1 g three times daily for 5 days.';
const FAST_Q = 'First-line antibiotic for CAP?';
const DEEP_Q = 'What dose of amoxicillin for CAP?';
const r = (text) => ({ text, tokenCount: 20, inputTokens: 10, outputTokens: 10, provider: 'local-tutor', model: 'qwen-tutor' });
const send = (body = {}) => request(app).post('/chat').send({ ple_id: 'x', history: [], message: FAST_Q, language: 'en', ...body });
const call = (n) => callAI.mock.calls[n][0];
const thinks = () => {
  providerSupportsThinking.mockResolvedValue(true);
  supportsThinking.mockImplementation((name) => name === 'local-tutor');
};

let warn;
beforeEach(() => {
  callAI.mockReset();
  providerSupportsThinking.mockReset();
  supportsThinking.mockReset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('prompt labels: every manifest variant is what /chat stamps', () => {
  test('the committed manifest is present and is this build\'s (else every comparison below is moot)', () => {
    expect(committed.file).toBe('present');
    expect(M.canonicalJson(committed.manifest.expected.code)).toBe(M.canonicalJson(M.expectedCode()));
  });

  const variants = M.CHAT_PROMPT_VARIANTS.filter((v) => !['rescue', 'booth', 'booth+grill', 'booth+typed'].includes(v.name));
  test.each(variants.map((v) => [v.name, v.opts]))('%s', async (name, opts) => {
    callAI.mockResolvedValue(r(`${GOOD}\n\n${P.evidenceLineFor('moderate')}`));
    const res = await send({ socratic: opts.socratic, artifacts: opts.artifacts, evidence_marker: opts.evidenceMarker });
    expect(res.status).toBe(200);
    expect(call(0).systemPrompt).toBe(P.chatSystemPrompt(opts));
    expect(res.body.prompt_version).toBe(committed.manifest.expected.code.prompts.chat[name].label);
  });

  test('rescue — the prompt that replaces all of the above', async () => {
    callAI.mockResolvedValue(r('What would you check before choosing a dose?'));
    const res = await send({ socratic: true, artifacts: true, evidence_marker: true, rescue_active: true, rescue_rounds: MAX_RESCUE_ROUNDS });
    expect(res.body.rescue.rescuing).toBe(true);
    expect(call(0).systemPrompt).toBe(P.RIMPL_SYSTEM_PROMPT_RESCUE);
    expect(res.body.prompt_version).toBe(committed.manifest.expected.code.prompts.chat.rescue.label);
  });

  test('booth — the prompt that replaces all of the above on a kiosk turn, at its own ceiling', async () => {
    callAI.mockResolvedValue(r('{"strength":"An ECG first is reasonable.","weigh":"","safety":""}'));
    const res = await send({ socratic: true, artifacts: true, evidence_marker: true, booth_mode: true });
    expect(call(0).systemPrompt).toBe(P.RIMPL_SYSTEM_PROMPT_BOOTH);
    expect(res.body.prompt_version).toBe(committed.manifest.expected.code.prompts.chat.booth.label);
    expect(call(0).maxTokens).toBe(committed.manifest.expected.code.decoding.chat.booth.max_tokens);
  });

  test('booth+grill — the kiosk prompt when the next step\'s bank is sent, at the booth ceiling', async () => {
    callAI.mockResolvedValue(r('{"strength":"Reasonable.","weigh":"","safety":"","variant_id":"v1","bridge":"","option_ids":["a","b","c"]}'));
    const bank = {
      variants: [{ id: 'v1', question: { th: 'ขั้นต่อไป', en: 'Next' } }],
      options: ['best', 'reasonable', 'weaker'].map((tier, i) => ({ id: 'abc'[i], tier, label: { th: 'ก', en: 'a' }, line: { th: 'ข', en: 'b' } })),
    };
    const res = await send({ booth_mode: true, booth_bank: bank });
    expect(call(0).systemPrompt).toBe(P.RIMPL_SYSTEM_PROMPT_BOOTH_GRILL);
    expect(res.body.prompt_version).toBe(committed.manifest.expected.code.prompts.chat['booth+grill'].label);
    expect(call(0).maxTokens).toBe(committed.manifest.expected.code.decoding.chat.booth.max_tokens);
  });

  test('booth+typed — the kiosk prompt when the last answer was typed, at the booth ceiling', async () => {
    callAI.mockResolvedValue(r('{"strength":"Reasonable.","weigh":"","safety":"","tier":"best"}'));
    const bank = {
      variants: [{ id: 'v1', question: { th: 'ขั้นนี้', en: 'This' } }],
      options: ['best', 'reasonable', 'weaker'].map((tier, i) => ({ id: 'abc'[i], tier, label: { th: 'ก', en: 'a' }, line: { th: 'ข', en: 'b' } })),
    };
    const res = await send({ booth_mode: true, booth_typed: { current: bank } });
    expect(call(0).systemPrompt).toBe(P.RIMPL_SYSTEM_PROMPT_BOOTH_TYPED);
    expect(res.body.prompt_version).toBe(committed.manifest.expected.code.prompts.chat['booth+typed'].label);
    expect(call(0).maxTokens).toBe(committed.manifest.expected.code.decoding.chat.booth.max_tokens);
  });

  test('twelve variants, twelve distinct labels', () => {
    const labels = Object.values(committed.manifest.expected.code.prompts.chat).map((e) => e.label);
    expect(labels).toHaveLength(12);
    expect(new Set(labels).size).toBe(12);
  });
});

describe('thinking policy: TIER_POLICY / RETRY_POLICY are what the route sends', () => {
  test('the policy is built from the ceilings chat.js uses', () => {
    expect(TIER_POLICY).toEqual({ fast: { thinking: false, maxTokens: CHAT_MAX_TOKENS }, deep: { thinking: true, maxTokens: CHAT_DEEP_MAX_TOKENS } });
    expect(RETRY_POLICY).toEqual({ thinking: false, maxTokens: CHAT_MAX_TOKENS });
  });

  test.each([['fast', FAST_Q], ['deep', DEEP_Q]])('%s tier: the first call', async (tier, message) => {
    thinks();
    callAI.mockResolvedValueOnce(r(GOOD));
    const res = await send({ router_enabled: true, message });
    expect(res.body.middleware_flags.tier).toBe(tier);
    expect(call(0)).toMatchObject({ thinking: TIER_POLICY[tier].thinking, maxTokens: TIER_POLICY[tier].maxTokens });
  });

  test('the corrective retry after a DEEP first call never thinks, at the fast ceiling', async () => {
    thinks();
    callAI.mockResolvedValueOnce(r(NO_CITE)).mockResolvedValueOnce(r(GOOD));
    const res = await send({ router_enabled: true, message: DEEP_Q });
    expect(res.status).toBe(200);
    expect(callAI).toHaveBeenCalledTimes(2);
    expect(call(0)).toMatchObject({ thinking: true });
    expect(call(1)).toMatchObject({ thinking: RETRY_POLICY.thinking, maxTokens: RETRY_POLICY.maxTokens });
  });

  test('the manifest records the same policy at the code-default ceilings', () => {
    const t = committed.manifest.expected.code.thinking;
    expect(t.tiers.fast.thinking).toBe(TIER_POLICY.fast.thinking);
    expect(t.tiers.deep.thinking).toBe(TIER_POLICY.deep.thinking);
    expect(t.retry.thinking).toBe(RETRY_POLICY.thinking);
    // This suite runs with no RIMPL_CHAT_* env, so the resolved ceilings are the code defaults.
    expect(t.tiers.fast.max_tokens).toBe(CHAT_MAX_TOKENS);
    expect(t.tiers.deep.max_tokens).toBe(CHAT_DEEP_MAX_TOKENS);
  });
});

describe('temperature: CHAT_DECODING says none is sent, and none is', () => {
  test('first call and retry', async () => {
    callAI.mockResolvedValueOnce(r(NO_CITE)).mockResolvedValueOnce(r(GOOD));
    await send();
    expect(callAI).toHaveBeenCalledTimes(2);
    for (const n of [0, 1]) expect(call(n).temperature ?? null).toBe(CHAT_DECODING.temperature);
    expect(committed.manifest.expected.code.decoding.chat.temperature).toBe(CHAT_DECODING.temperature);
  });
});
