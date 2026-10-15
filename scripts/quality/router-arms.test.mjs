// The router arms of tutor-audit.mjs (local-tutor-fast / -deep / -routed) and request.mjs's mirror of the
// chat.js router wiring. HERMETIC: every model call is a mock `complete`; the CLI tests refuse before any
// request (they are given no reachable endpoint), and the dry run sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildChatRequest, routeFor, tierOptions, retryThinking, middlewareFlags, retryDecision, ROUTER_MODES, stickyLatch,
  CHAT_MAX_TOKENS, CHAT_DEEP_MAX_TOKENS,
} from './request.mjs';
import { routeTurn, ROUTER_LABEL, EVIDENCE_LINE_MAX_TOKENS } from './rimpl.mjs';
import { loadBank } from './bank.mjs';
import { runItem, routerSummary, deadlineSummary, ARMS, armThinkingProblem, localComplete, TURN_DEADLINE_DEFAULT_MS } from './tutor-audit.mjs';
import { ITEM_EN_NATURAL, ITEM_TH_EXAMINER, ITEM_RESCUE, GOOD_TH_EXAMINER } from './test-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ITEM_DOSE = { ...ITEM_EN_NATURAL, id: 'fx-dose', turns: [{ role: 'physician', content: 'What dose of amoxicillin for CAP in adults?' }] };
const ITEM_MAIL = { ...ITEM_EN_NATURAL, id: 'fx-mail', turns: [{ role: 'physician', content: 'Please e-mail dose@example.com about the plan.' }] };
const CITED = 'Start at eGFR 20 (KDIGO, 2022).';

/* ----------------------------------------------------------- request.mjs */

test('router off (every arm before the router): no route, no thinking field, the fast ceiling', () => {
  const r = buildChatRequest(ITEM_DOSE);
  assert.deepEqual([r.router, r.route, r.tierApplied, r.deep, r.maxTokens, r.thinkingField], ['off', null, false, false, CHAT_MAX_TOKENS, {}]);
  assert.deepEqual(middlewareFlags(r), {
    router_version: null, tier: null, reason: null, thinking: null, thinking_budget: null, evidence_level: null, failed_over_from: null,
  });
});

test('routed = production\'s routeTurn on the DE-IDENTIFIED message', () => {
  const r = buildChatRequest(ITEM_DOSE, { router: 'routed', thinkingSupported: true });
  assert.deepEqual(r.route, { tier: 'deep', reason: 'dosing', version: ROUTER_LABEL });
  assert.deepEqual([r.tierApplied, r.deep, r.maxTokens, r.thinkingField], [true, true, CHAT_DEEP_MAX_TOKENS, { thinking: true }]);
  // The raw e-mail holds "dose"; the PII filter masks it before the router reads the message.
  const m = buildChatRequest(ITEM_MAIL, { router: 'routed', thinkingSupported: true });
  assert.deepEqual([m.route.tier, m.route.reason], ['fast', 'default']);
  assert.match(m.messages.at(-1).content, /\[EMAIL-1\]/);
  assert.deepEqual(routeFor('routed', { cleanMessage: 'What dose?', historyLength: 0, socratic: false, rescuing: false }), routeTurn({ message: 'What dose?' }));
});

test('the tier is applied only when the provider honours thinking (production: providerSupportsThinking)', () => {
  const r = buildChatRequest(ITEM_DOSE, { router: 'routed', thinkingSupported: false });
  assert.deepEqual(r.route.tier, 'deep', 'routed and recorded…');
  assert.deepEqual([r.tierApplied, r.maxTokens, r.thinkingField], [false, CHAT_MAX_TOKENS, {}], '…but not applied');
  assert.deepEqual(middlewareFlags(r), {
    router_version: ROUTER_LABEL, tier: 'deep', reason: 'dosing', thinking: null, thinking_budget: null, evidence_level: null, failed_over_from: null,
  });
});

test('forced arms: every non-rescue item gets the forced tier; a rescue item stays fast', () => {
  const fast = buildChatRequest(ITEM_DOSE, { router: 'fast', thinkingSupported: true });
  assert.deepEqual([fast.route, fast.thinkingField, fast.maxTokens], [{ tier: 'fast', reason: 'forced', version: null }, { thinking: false }, CHAT_MAX_TOKENS]);
  const deep = buildChatRequest(ITEM_EN_NATURAL, { router: 'deep', thinkingSupported: true });
  assert.deepEqual([deep.route.tier, deep.thinkingField, deep.maxTokens], ['deep', { thinking: true }, CHAT_DEEP_MAX_TOKENS]);
  const rescue = buildChatRequest(ITEM_RESCUE, { router: 'deep', thinkingSupported: true });
  assert.deepEqual([rescue.route, rescue.thinkingField], [{ tier: 'fast', reason: 'rescue', version: null }, { thinking: false }]);
  const routedRescue = buildChatRequest(ITEM_RESCUE, { router: 'routed', thinkingSupported: true });
  assert.deepEqual(routedRescue.route, { tier: 'fast', reason: 'rescue', version: ROUTER_LABEL });
  assert.throws(() => buildChatRequest(ITEM_DOSE, { router: 'sometimes' }), /router mode must be one of/);
  assert.deepEqual(ROUTER_MODES, ['off', 'routed', 'fast', 'deep']);
});

test('tierOptions / retryThinking / middlewareFlags = chat.js', () => {
  const deep = tierOptions({ tier: 'deep' }, { thinkingSupported: true, maxTokens: 4000, deepMaxTokens: 8000 });
  assert.deepEqual(deep, { tierApplied: true, deep: true, maxTokens: 8000, thinkingField: { thinking: true } });
  assert.deepEqual(tierOptions(null, { thinkingSupported: true }), { tierApplied: false, deep: false, maxTokens: CHAT_MAX_TOKENS, thinkingField: {} });
  const req = buildChatRequest(ITEM_EN_NATURAL, { router: 'deep', thinkingSupported: true, evidenceMarker: true });
  const base = { socratic: false, rescuing: false, language: 'en', message: 'x', evidenceMarker: true };
  assert.equal(retryDecision('no citation here', base).needCitation, true);
  assert.deepEqual(retryThinking(req), { thinking: false }, 'a full retry after a deep first call does not think');
  assert.deepEqual(retryThinking(buildChatRequest(ITEM_EN_NATURAL, { router: 'fast', thinkingSupported: true })), { thinking: false });
  assert.deepEqual(retryThinking(buildChatRequest(ITEM_EN_NATURAL)), {}, 'router off: no field');
  assert.deepEqual(retryThinking(buildChatRequest(ITEM_EN_NATURAL, { router: 'deep', thinkingSupported: false })), {}, 'tier not applied: no field');
  assert.deepEqual(middlewareFlags(req, { evidenceLevel: 'low' }), {
    router_version: null, tier: 'deep', reason: 'forced', thinking: true, thinking_budget: CHAT_DEEP_MAX_TOKENS, evidence_level: 'low', failed_over_from: null,
  });
});

/* -------------------------------------------------------------- runItem */

const recorder = (replies) => {
  const calls = [];
  const complete = async (req) => {
    calls.push(req);
    const r = replies[calls.length - 1] ?? replies.at(-1);
    return typeof r === 'function' ? r(req) : r;
  };
  return { calls, complete };
};
const opts = (over = {}) => ({ maxTokens: CHAT_MAX_TOKENS, retry: true, artifacts: false, attempts: 1, thinkingSupported: true, stream: true, ...over });

test('deep arm: first call streamed at the deep ceiling with thinking:true; the citation retry is thinking:false at the FAST ceiling, not streamed', async () => {
  const { calls, complete } = recorder([
    { ok: true, text: 'ควรทำ ECG ภายใน 10 นาที', ms: 30, streamed: true, ttft_reasoning_ms: 4.2, ttft_content_ms: 21.7, reasoning: 'abc' },
    { ok: true, text: GOOD_TH_EXAMINER, ms: 20 },
  ]);
  const e = await runItem(ITEM_TH_EXAMINER, complete, opts({ router: 'deep' }));
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0].maxTokens, calls[0].thinking, calls[0].stream], [CHAT_DEEP_MAX_TOKENS, true, true]);
  assert.deepEqual([calls[1].maxTokens, calls[1].thinking, 'stream' in calls[1]], [CHAT_MAX_TOKENS, false, false]);
  assert.deepEqual([e.first.streamed, e.first.ttft_reasoning_ms, e.first.ttft_content_ms, e.first.reasoning_chars], [true, 4, 22, 3]);
  assert.equal('reasoning' in e.first, false, 'the reasoning text is never kept');
  assert.deepEqual([e.request.router, e.request.max_tokens, e.request.thinking], ['deep', CHAT_DEEP_MAX_TOKENS, true]);
  assert.deepEqual(e.middleware_flags, {
    router_version: null, tier: 'deep', reason: 'forced', thinking: true, thinking_budget: CHAT_DEEP_MAX_TOKENS, evidence_level: null, failed_over_from: null,
  });
});

test('routed arm with the evidence marker: the marker-only retry is small and never thinks', async () => {
  const { calls, complete } = recorder([{ ok: true, text: CITED, ms: 5, streamed: true }, { ok: true, text: 'Evidence: moderate', ms: 2 }]);
  const e = await runItem(ITEM_DOSE, complete, opts({ router: 'routed', evidenceMarker: true }));
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0].thinking, calls[0].maxTokens], [true, CHAT_DEEP_MAX_TOKENS]);
  assert.deepEqual([calls[1].thinking, calls[1].maxTokens], [false, EVIDENCE_LINE_MAX_TOKENS]);
  assert.deepEqual([e.middleware_flags.tier, e.middleware_flags.reason, e.middleware_flags.evidence_level], ['deep', 'dosing', 'moderate']);
});

test('a rescue item is never streamed and is fast in every router arm', async () => {
  for (const router of ['fast', 'deep', 'routed']) {
    const { calls, complete } = recorder([{ ok: true, text: 'แพ้ยาแบบไหน?', ms: 5 }]);
    const e = await runItem(ITEM_RESCUE, complete, opts({ router }));
    assert.equal('stream' in calls[0], false, router);
    assert.deepEqual([calls[0].thinking, calls[0].maxTokens, e.middleware_flags.tier, e.middleware_flags.reason], [false, CHAT_MAX_TOKENS, 'fast', 'rescue'], router);
  }
});

test('the old arms are unchanged: no stream, no thinking field, the fast ceiling, flags all null', async () => {
  const { calls, complete } = recorder([{ ok: true, text: CITED, ms: 5 }]);
  const e = await runItem(ITEM_EN_NATURAL, complete, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.deepEqual(calls[0], { systemPrompt: calls[0].systemPrompt, messages: calls[0].messages, maxTokens: 4000 });
  assert.equal(e.first.streamed, undefined);
  assert.equal(e.middleware_flags.tier, null);
});

/* -------------------------------------------------------- routerSummary */

test('routerSummary: deep share with its Wilson interval, reasons, TTFT p50/p95 of the streamed first calls', () => {
  const entry = (tier, reason, first, total = 100) => ({ middleware_flags: { tier, reason }, first: { ok: true, ...first }, final: { ok: true }, latency_ms_total: total });
  const items = [
    entry('fast', 'default', { streamed: true, ttft_reasoning_ms: null, ttft_content_ms: 600 }),
    entry('fast', 'default', { streamed: true, ttft_reasoning_ms: null, ttft_content_ms: 800 }),
    entry('deep', 'dosing', { streamed: true, ttft_reasoning_ms: 500, ttft_content_ms: 30000 }),
    entry('fast', 'rescue', { streamed: false }),            // a rescue turn: routed, not streamed
    { middleware_flags: { tier: null }, first: { ok: true }, final: { ok: true }, latency_ms_total: 5 },   // router off
  ];
  const s = routerSummary(items);
  assert.equal(s.n, 4);
  assert.deepEqual([s.deep.k, s.deep.n], [1, 4]);
  assert.ok(s.deep.lo > 0 && s.deep.hi < 1);
  assert.deepEqual(s.reasons, { default: 2, dosing: 1, rescue: 1 });
  assert.equal(s.streamed, 3);
  assert.deepEqual(s.ttft_first_ms, { n: 3, p50: 600, p95: 800 }, 'min(status, text): the deep turn counts at its 500 ms status');
  assert.deepEqual(s.ttft_content_ms, { n: 3, p50: 800, p95: 30000 });
  assert.deepEqual(s.ttft_content_fast_ms, { n: 2, p50: 600, p95: 800 });
  assert.deepEqual(s.ttft_content_deep_ms, { n: 1, p50: 30000, p95: 30000 });
  assert.deepEqual(routerSummary([]).ttft_first_ms, { n: 0, p50: null, p95: null });
});

/* --------------------------------------------------------------- arms */

test('ARMS: three router arms on local-tutor, streamed, needing thinking; the old arms untouched', () => {
  assert.deepEqual(Object.keys(ARMS), ['local', 'anthropic', 'local-tutor-fast', 'local-tutor-deep', 'local-tutor-routed']);
  for (const [arm, router] of [['local-tutor-fast', 'fast'], ['local-tutor-deep', 'deep'], ['local-tutor-routed', 'routed']]) {
    assert.deepEqual(ARMS[arm], { provider: 'local-tutor', prefix: 'LOCAL_TUTOR_AI_', router, thinking: true, stream: true });
  }
  assert.deepEqual([ARMS.local.router, ARMS.local.stream, ARMS.anthropic.router], ['off', false, 'off']);
});

test('armThinkingProblem: a router arm refuses without a thinking style; other arms never', () => {
  const cfg = (thinkingStyle) => ({ prefix: 'LOCAL_TUTOR_AI_', thinkingStyle });
  assert.match(armThinkingProblem('local-tutor-routed', cfg('none')), /needs LOCAL_TUTOR_AI_THINKING_STYLE/);
  assert.match(armThinkingProblem('local-tutor-deep', cfg(null)), /is not a style/);
  assert.equal(armThinkingProblem('local-tutor-fast', cfg('chat_template_kwargs')), null);
  assert.equal(armThinkingProblem('local', cfg('none')), null);
});

test('localComplete: streamed when the call asks, else the plain completion', async () => {
  const seen = [];
  const complete = localComplete({ model: 'm' }, {
    streamImpl: async (_cfg, req) => { seen.push(['stream', req.maxTokens]); return { ok: true }; },
    plainImpl: async (_cfg, req) => { seen.push(['plain', req.maxTokens]); return { ok: true }; },
  });
  await complete({ maxTokens: 1, stream: true });
  await complete({ maxTokens: 2 });
  assert.deepEqual(seen, [['stream', 1], ['plain', 2]]);
});

/* ---------------------------------------------------------------- CLI */

const run = (args, env = {}) => spawnSync(process.execPath, [path.join(HERE, 'tutor-audit.mjs'), ...args], {
  encoding: 'utf8', timeout: 30000,
  env: { PATH: process.env.PATH, ...env },   // no LOCAL_*, no key inherited
});

test('CLI: an unknown arm refuses, naming the arms', () => {
  const r = run(['--arm', 'local-tutor-sometimes', '--dry-run']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /local-tutor-routed/);
});

test('CLI: a router arm with no tutor endpoint refuses before anything is sent', () => {
  const r = run(['--arm', 'local-tutor-routed', '--limit', '1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /LOCAL_TUTOR_AI_BASE_URL is not set/);
});

test('CLI: a router arm with an endpoint but no LOCAL_TUTOR_AI_THINKING_STYLE refuses before anything is sent', () => {
  const env = { LOCAL_TUTOR_AI_BASE_URL: 'http://127.0.0.1:9/v1', LOCAL_TUTOR_AI_MODEL: 'never-called' };
  const r = run(['--arm', 'local-tutor-deep', '--limit', '1'], env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs LOCAL_TUTOR_AI_THINKING_STYLE/);
  assert.doesNotMatch(r.stdout, /report /);
});

test('CLI: --dry-run of a router arm prints each route and tier, and sends nothing', () => {
  const r = run(['--dry-run', '--arm', 'local-tutor-routed', '--ids', 'th-cardio-stemi']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /router routed · router-v1\+[0-9a-f]{12} ·/);
  assert.match(r.stdout, /turn deadline 100000 ms/);
  assert.match(r.stdout, /tier (fast|deep) \(\w+\) · thinking (true|false) · max_tokens \d+/);
  assert.match(r.stdout, /0 requests sent/);
  const d = run(['--dry-run', '--arm', 'local-tutor-deep', '--ids', 'th-cardio-stemi']);
  assert.match(d.stdout, new RegExp(`tier deep \\(forced\\) · thinking true · max_tokens ${CHAT_DEEP_MAX_TOKENS}`));
});

/* ------------------------------------------------------- the sticky latch */

const ITEM_LATCH = {
  ...ITEM_EN_NATURAL, id: 'fx-latch',
  turns: [
    { role: 'physician', content: 'What dose of amoxicillin for CAP?' },
    { role: 'assistant', content: 'Amoxicillin 1 g three times daily (BTS, 2019).' },
    { role: 'physician', content: 'Thanks. And what follow-up do you suggest?' },
  ],
};

test('sticky latch (routed): an earlier physician turn that went deep with thinking makes this turn deep "sticky"', () => {
  const on = buildChatRequest(ITEM_LATCH, { router: 'routed', thinkingSupported: true });
  assert.equal(on.sticky, true);
  assert.deepEqual([on.route.tier, on.route.reason, on.thinkingField, on.maxTokens], ['deep', 'sticky', { thinking: true }, CHAT_DEEP_MAX_TOKENS]);
  // The backend latches only when thinking was applied (middleware_flags.thinking === true).
  const noThink = buildChatRequest(ITEM_LATCH, { router: 'routed', thinkingSupported: false });
  assert.deepEqual([noThink.sticky, noThink.route.reason], [false, 'default']);
  // A forced arm forces every turn; the latch is a 'routed' thing.
  assert.equal(buildChatRequest(ITEM_LATCH, { router: 'fast', thinkingSupported: true }).sticky, false);
  // Only PHYSICIAN turns latch (an assistant reply mentioning a dose routed nothing).
  const assistantOnly = { ...ITEM_LATCH, turns: [{ role: 'physician', content: 'Hello' }, { role: 'assistant', content: 'The dose is 1 g.' }, ITEM_LATCH.turns[2]] };
  assert.equal(buildChatRequest(assistantOnly, { router: 'routed', thinkingSupported: true }).sticky, false);
  // Single-turn items have nothing to latch on.
  assert.equal(buildChatRequest(ITEM_DOSE, { router: 'routed', thinkingSupported: true }).sticky, false);
});

test('stickyLatch routes each earlier turn on its DE-IDENTIFIED text, as production saw it then', () => {
  // A raw e-mail holding "dose" in an earlier turn is masked before it is routed: no latch.
  const masked = { ...ITEM_LATCH, turns: [{ role: 'physician', content: 'Please e-mail dose@example.com.' }, ITEM_LATCH.turns[1], ITEM_LATCH.turns[2]] };
  assert.equal(buildChatRequest(masked, { router: 'routed', thinkingSupported: true }).sticky, false);
  assert.equal(stickyLatch([{ role: 'physician', content: 'ขนาดยาเท่าไร' }], { thinkingSupported: true }), true);
  assert.equal(stickyLatch([{ role: 'physician', content: 'ขนาดยาเท่าไร' }], { thinkingSupported: false }), false);
});

test('the bank: the latch changes the tier of exactly the two multi-turn items the review measured', async () => {
  // A bank edit that adds or removes a latching item changes this list on purpose.
  const bank = await loadBank();
  const changed = bank.items.filter((it) => {
    const routed = buildChatRequest(it, { router: 'routed', thinkingSupported: true });
    assert.equal(typeof routed.cleanMessage, 'string');
    const unlatched = routeTurn({ message: routed.cleanMessage, socratic: routed.socratic, rescuing: routed.rescuing, sticky: false });
    return routed.route.tier !== unlatched.tier;
  }).map((it) => it.id).sort();
  assert.deepEqual(changed, ['adv-en-language-switch-to-english', 'mt-th-paeds-asthma-ics']);
  assert.equal(bank.items.filter((it) => it.mode !== 'rescue').length, 74);
});

/* -------------------------------------------------------- the turn deadline */

test('deadline: a turn whose first call + retry runs past it is flagged deadline_exceeded, its reply kept', async () => {
  assert.equal(TURN_DEADLINE_DEFAULT_MS, 100000);
  const slow = () => recorder([{ ok: true, text: 'ควรทำ ECG ภายใน 10 นาที', ms: 70000, streamed: true }, { ok: true, text: GOOD_TH_EXAMINER, ms: 40000 }]);
  let { complete } = slow();
  const e = await runItem(ITEM_TH_EXAMINER, complete, opts({ router: 'deep' }));
  assert.deepEqual([e.latency_ms_total, e.deadline_exceeded], [110000, true]);
  assert.equal(e.final.text, GOOD_TH_EXAMINER, 'kept for inspection');
  ({ complete } = slow());
  assert.equal((await runItem(ITEM_TH_EXAMINER, complete, opts({ router: 'deep', turnDeadlineMs: 150000 }))).deadline_exceeded, false, 'the local stack\'s 150 s');
  ({ complete } = recorder([{ ok: true, text: CITED, ms: 100000 }]));
  assert.equal((await runItem(ITEM_EN_NATURAL, complete, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 })).deadline_exceeded, false, 'strictly past it; and every arm gets the flag');
});

test('deadlineSummary: k/n with its Wilson interval, over every item', () => {
  const s = deadlineSummary([{ deadline_exceeded: true }, { deadline_exceeded: false }, { deadline_exceeded: false }, {}], 150000);
  assert.equal(s.turn_deadline_ms, 150000);
  assert.deepEqual([s.exceeded.k, s.exceeded.n], [1, 4]);
  assert.ok(s.exceeded.lo > 0 && s.exceeded.hi < 1);
  // The R-3 bar in numbers: at n = 80 only 0/80 has a Wilson upper bound <= 5%.
  const at = (k) => deadlineSummary(Array.from({ length: 80 }, (_, i) => ({ deadline_exceeded: i < k }))).exceeded.hi;
  assert.ok(at(0) <= 0.05 && at(1) > 0.05, `0/80 -> ${at(0)}, 1/80 -> ${at(1)}`);
});

test('routerSummary: status shown on a FAST turn (the model reasoned anyway), and the deadline figure', () => {
  const entry = (tier, first, exceeded = false) => ({ middleware_flags: { tier, reason: 'x' }, first: { ok: true, streamed: true, ...first }, final: { ok: true }, latency_ms_total: 1, deadline_exceeded: exceeded });
  const s = routerSummary([
    entry('fast', { ttft_reasoning_ms: 300, ttft_content_ms: 900 }),   // ignored enable_thinking=false
    entry('fast', { ttft_reasoning_ms: null, ttft_content_ms: 500 }),
    entry('deep', { ttft_reasoning_ms: 200, ttft_content_ms: 40000 }, true),
  ]);
  assert.deepEqual([s.status_on_fast.k, s.status_on_fast.n], [1, 2]);
  assert.deepEqual([s.deadline_exceeded.k, s.deadline_exceeded.n], [1, 3]);
});
