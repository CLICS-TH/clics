'use strict';

// The vm1 cutover's go/no-go (#431, ADR 0012): every scripted readiness row, measured in ONE run of
// scripts/readiness.js inside the RIMPL container, each printed pass or fail with its evidence. The rows a
// person decides (the decisive evaluator ICC gate, a clinician's Thai read) are listed as owner-gated.
//
// SHAPE. A Row is { id, title, status: 'pass' | 'fail' | 'owner-gated', evidence, notes? }. Evidence holds
// numbers, booleans, null and short enum or id strings only. CHECKS is the registry the runner walks: a
// check is { id, title, run(ctx) } and reaches the world only through ctx (services/readiness-harness.js
// builds the real one, the tests pass fakes). A row whose ticket line names a control runs that control in
// the same call, and a control that does not behave fails the row ('control_broken').
//
// STATISTICS.
//   p95: nearest-rank (rank = ceil(0.95 n)), always reported with n. No interpolation: at n = 30 it would
//     imply a precision the data does not have (the rule scripts/probe/lib.mjs percentile follows).
//   deadline misses: the Wilson score interval, 95% two-sided (z = 1.96), judged on its UPPER bound. With
//     zero misses the bound is z²/(n + z²), which reaches 5% only at n = 73, so the concurrency check sizes
//     its turns from that and a run too short to pass on zero misses is never scheduled.
//
// SAFETY. Nothing here writes to the database: /evaluate is always sent shadow:false, ple_ids carry the
// `readiness-` prefix, and every prompt is the fictional case below. The report goes through assertSafe
// before it is printed or written.
const { isLocalProvider } = require('./provider-policy');
const { CHAT_MAX_TOKENS, CHAT_DEEP_MAX_TOKENS } = require('./turn-limits');
const { CRITERIA_DECODING, EVAL_DECODING, discussMaxTokens } = require('./decoding');
const { pis7PromptFor, chatSystemPrompt } = require('./prompts');
const { flattenForPrompt, seedWithChiefComplaint, stripArtifactDelimiters } = require('./transcript');
const { stripPii, stripHistoryPii, primeRegistry, makeRegistry } = require('../services/pii-filter');

const INSTANCES = ['local', 'local-tutor'];

// backend/src/services/rimpl-client.js DETERMINISTIC_STATUSES: an /evaluate failure with one of these goes
// to manual QA, any other is requeued. tests/readiness.test.js reads that file and fails if the two differ.
const DETERMINISTIC_STATUSES = new Set([400, 401, 403, 413, 422, 502]);

const Z95 = 1.96;
const MAX_MISS_RATE = 0.05;
const CONTEXT_SHARE = 0.8;

// ---------------------------------------------------------------------------------------------------------
// Statistics

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

function wilsonUpper(k, n, z = Z95) {
  if (!(n > 0)) return 1;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, (centre + half) / (1 + z2 / n));
}

// The fewest turns at which a run with no miss at all can pass.
function minTurnsForZeroMissPass(maxRate = MAX_MISS_RATE, z = Z95) {
  let n = 1;
  while (wilsonUpper(0, n, z) > maxRate) n += 1;
  return n;
}

// ---------------------------------------------------------------------------------------------------------
// Options: the ticket's numbers and how an override may move each. An override weaker than the ticket is
// allowed (to rehearse on a slow box) but fails every row that reads it.

const env = (name, dflt) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const OPTIONS = {
  chatSamples: { flag: '--chat-samples', ticket: 30, weaker: (v, t) => v < t },
  evalSamples: { flag: '--eval-samples', ticket: 10, weaker: (v, t) => v < t },
  chatP95Ms: { flag: '--chat-p95-ms', ticket: 15000, weaker: (v, t) => v > t },
  evalP95Ms: { flag: '--eval-p95-ms', ticket: 240000, weaker: (v, t) => v > t },
  sessions: { flag: '--sessions', ticket: 10, weaker: (v, t) => v < t },
  deadlineMs: { flag: '--deadline-ms', ticket: 15000, weaker: (v, t) => v > t },
  // The drain stand-in's width: the backend's EVAL_DRAIN_CONCURRENCY when it is in this env, else its default.
  drainConcurrency: { flag: '--drain-concurrency', ticket: () => env('EVAL_DRAIN_CONCURRENCY', 1), weaker: null },
  // How long a caller waits before the reply counts as never returned: the backend's own deadlines.
  turnTimeoutMs: { flag: '--turn-timeout-ms', ticket: () => env('RIMPL_CHAT_TIMEOUT_MS', 100000), weaker: null },
  evalTimeoutMs: { flag: '--eval-timeout-ms', ticket: () => env('RIMPL_EVAL_TIMEOUT_MS', 480000), weaker: null },
};

function ticketValue(name) {
  const t = OPTIONS[name].ticket;
  return typeof t === 'function' ? t() : t;
}

function resolveOptions(overrides = {}) {
  const out = {};
  for (const name of Object.keys(OPTIONS)) out[name] = overrides[name] ?? ticketValue(name);
  return out;
}

function weakerOverrides(opts, names) {
  return names.filter((n) => OPTIONS[n].weaker && OPTIONS[n].weaker(opts[n], ticketValue(n)));
}

// ---------------------------------------------------------------------------------------------------------
// The fictional case every prompt is built from. No patient data, here or anywhere in a run.

const CHIEF_COMPLAINT = 'กรณีสมมุติเพื่อทดสอบระบบ: ไข้ ไอมีเสมหะ 3 วัน';
const PHYSICIAN_TURNS = [
  'กรณีสมมุติเพื่อทดสอบระบบ ไม่มีข้อมูลผู้ป่วยจริง: ผู้ใหญ่มีไข้และไอมีเสมหะสามวัน ควรประเมินความรุนแรงของปอดอักเสบอย่างไร',
  'For this fictional case, which severity score would you use to decide on admission, and what finding would change that plan?',
  'ถ้าภาพรังสีทรวงอกในกรณีสมมุตินี้พบ infiltrate ที่ปอดขวาล่าง จะเลือกยาปฏิชีวนะเริ่มต้นสำหรับผู้ป่วยนอกอย่างไร',
  'In this hypothetical scenario, what follow-up interval and return precautions would you set, and why?',
  'ถ้าผู้ป่วยสมมุติรายนี้แพ้ยากลุ่ม penicillin จะปรับแผนการรักษาอย่างไร และต้องระวังอะไรเพิ่ม',
  'How would you explain the remaining diagnostic uncertainty in this fictional case, and what would make you reconsider the diagnosis?',
];
const ASSISTANT_TURN = 'ในกรณีสมมุตินี้ ควรประเมินสัญญาณชีพ ความอิ่มตัวออกซิเจน และใช้คะแนนความรุนแรงประกอบการตัดสินใจ (IDSA/ATS, 2019).';
const FOLLOW_UP = 'จากกรณีสมมุติข้างต้น ขอสรุปแนวทางการดูแลต่อ';
const REACH_PROMPT = 'Fictional readiness check, no patient data. Reply with one short sentence about hand hygiene.';
const DISCUSS_MESSAGE = 'ในกรณีสมมุตินี้ ทำไมคะแนนด้าน d2 ของ AI จึงต่ำกว่าคะแนนของผู้ตรวจ';

const physicianTurn = (i) => PHYSICIAN_TURNS[i % PHYSICIAN_TURNS.length];

// Every fictional sentence a run may send: the report must contain none of them.
const FIXTURE_TEXT = [CHIEF_COMPLAINT, ...PHYSICIAN_TURNS, ASSISTANT_TURN, FOLLOW_UP, REACH_PROMPT, DISCUSS_MESSAGE];

const syntheticTranscript = () => PHYSICIAN_TURNS.slice(0, 4).flatMap((content) => [
  { role: 'physician', content }, { role: 'assistant', content: ASSISTANT_TURN },
]);

let pleSeq = 0;
const pleId = (what) => `readiness-${what}-${process.pid}-${++pleSeq}`;

const chatBody = ({ history = [], turn = 0, ...extra } = {}) => ({
  ple_id: pleId('chat'), history, message: physicianTurn(turn), language: 'th', chief_complaint: CHIEF_COMPLAINT, ...extra,
});
const evalBody = () => ({
  ple_id: pleId('evaluate'), transcript: syntheticTranscript(), chief_complaint: CHIEF_COMPLAINT, shadow: false,
});
const criteriaBody = () => ({ transcript: syntheticTranscript(), chief_complaint: CHIEF_COMPLAINT });
const discussBody = () => {
  const scores = { d1: 3, d2: 2, d3: 3, d4: 3, d5: 2, d6: 3, d7: 3, composite_score: 56 };
  return {
    message: DISCUSS_MESSAGE, language: 'th', transcript: syntheticTranscript(), chief_complaint: CHIEF_COMPLAINT,
    ai_scores: scores, auditor_scores: { ...scores, d2: 4, composite_score: 62 },
  };
};

// ---------------------------------------------------------------------------------------------------------
// What a route's answer is worth. One table: which body proves a reply for each route.

const REPLY_SHAPES = {
  chat: (b) => typeof b?.content === 'string' && b.content.trim() !== '',
  discuss: (b) => typeof b?.content === 'string' && b.content.trim() !== '',
  criteria: (b) => ['c4', 'c5', 'c6', 'c7'].every((k) => typeof b?.[k] === 'boolean'),
  evaluate: (b) => ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].every((k) => Number.isFinite(b?.[k])),
};

// A word safe to print: a status code, an enum, a model id. Anything else becomes null.
const word = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:+\-/]{0,79}$/.test(v) ? v : null);

// res = { status, body, ms, error } from ctx.post. reason is a fixed vocabulary.
function classifyReply(shape, res) {
  if (res.error) return { ok: false, reason: res.error };
  if (res.status === 503 && ['empty_reply', 'queue_full', 'ai_unavailable', 'local_only_refused'].includes(res.body?.code)) {
    return { ok: false, reason: res.body.code };
  }
  if (res.status !== 200) return { ok: false, reason: `http_${res.status}` };
  if (!REPLY_SHAPES[shape](res.body)) return { ok: false, reason: 'no_content' };
  if (!isLocalProvider(res.body?.provider)) return { ok: false, reason: 'not_on_prem' };
  return { ok: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------------------------------------
// Judges: pure functions from measurements to a verdict.

function judgeP95(samplesMs, { minN, limitMs, inclusive }) {
  const n = samplesMs.length;
  const p95 = percentile(samplesMs, 95);
  const within = p95 != null && (inclusive ? p95 <= limitMs : p95 < limitMs);
  const reason = n < minN ? 'too_few_samples' : within ? 'ok' : 'p95_over_limit';
  return { n, min_n: minN, p95_ms: p95, limit_ms: limitMs, pass: reason === 'ok', reason };
}

// records = [{ ms, ok }]. A turn misses when it was lost or answered after the deadline.
function judgeConcurrency(records, { deadlineMs, maxMissRate = MAX_MISS_RATE, minTurns = minTurnsForZeroMissPass(maxMissRate) }) {
  const turns = records.length;
  const lost = records.filter((r) => !r.ok).length;
  const misses = records.filter((r) => !r.ok || r.ms > deadlineMs).length;
  const upper = wilsonUpper(misses, turns);
  const reason = turns < minTurns ? 'too_few_turns' : lost > 0 ? 'turns_lost' : upper > maxMissRate ? 'misses_over_bound' : 'ok';
  return { turns, min_turns: minTurns, misses, lost, miss_upper_95: Number(upper.toFixed(4)), max_miss_rate: maxMissRate, deadline_ms: deadlineMs, pass: reason === 'ok', reason };
}

// ---------------------------------------------------------------------------------------------------------
// Load drivers, shared by the latency and concurrency rows.

// The backend's evaluation drain, stood in for: `concurrency` workers, each sending one /evaluate after
// another until stop(). A failed call backs off like the drain does, so a dead box is not hammered.
function startDrain(ctx, { concurrency, timeoutMs, backoffMs = 1000 }) {
  const samples = [];
  const inFlight = new Set();
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      const ac = new AbortController();
      inFlight.add(ac);
      const res = await ctx.post('/evaluate', evalBody(), { timeoutMs, signal: ac.signal });
      inFlight.delete(ac);
      if (res.error === 'aborted') break;
      const verdict = classifyReply('evaluate', res);
      samples.push({ ms: res.ms, ...verdict });
      if (!verdict.ok && !stopped) await ctx.sleep(backoffMs);
    }
  };
  const workers = Array.from({ length: concurrency }, worker);
  return {
    samples,
    async waitFor(n) { while (!stopped && samples.length < n) await ctx.sleep(250); },
    async stop() { stopped = true; for (const ac of inFlight) ac.abort(); await Promise.all(workers); return samples; },
  };
}

// `sessions` sessions in parallel, `turns` turns each, history growing with every delivered reply.
// sendTurn({ history, turn }) resolves { ok, reply }; the driver times it. Reply text stays in memory.
async function runSessions({ sessions, turns, sendTurn, now }) {
  const records = [];
  await Promise.all(Array.from({ length: sessions }, async () => {
    const history = [];
    for (let turn = 0; turn < turns; turn++) {
      const t0 = now();
      const r = await sendTurn({ history: [...history], turn });
      records.push({ ms: now() - t0, ok: r.ok, reason: r.reason });
      if (r.ok) history.push({ role: 'physician', content: physicianTurn(turn) }, { role: 'assistant', content: r.reply });
    }
  }));
  return records;
}

const chatTurn = (ctx, timeoutMs, extra = {}) => async ({ history, turn }) => {
  const res = await ctx.post('/chat', chatBody({ history, turn, ...extra }), { timeoutMs });
  return { ...classifyReply('chat', res), reply: res.body?.content };
};

const reasons = (list) => Object.fromEntries([...new Set(list.map((r) => r.reason))].filter((r) => r !== 'ok')
  .map((r) => [r, list.filter((x) => x.reason === r).length]));

// ---------------------------------------------------------------------------------------------------------
// Prompts for the context row: the longest sandbox transcript as each model would receive it.

function evaluatorPrompt({ turns, chiefComplaint }) {
  const registry = makeRegistry();
  seedWithChiefComplaint(registry, chiefComplaint || null, []);
  return { systemPrompt: pis7PromptFor('local'), messages: [{ role: 'user', content: `TRANSCRIPT:\n${flattenForPrompt(turns, [], registry)}` }] };
}

// The next /chat turn of that session, under the largest chat system prompt a turn can carry.
function tutorPrompt({ turns, chiefComplaint }) {
  const registry = makeRegistry();
  const cc = chiefComplaint || '';
  primeRegistry([cc, ...turns.map((t) => t.content), FOLLOW_UP], registry, []);
  const cleanCc = cc ? stripPii(cc, registry, []) : '';
  const messages = stripHistoryPii(turns, [], registry)
    .map((m) => ({ role: m.role === 'physician' ? 'user' : 'assistant', content: stripArtifactDelimiters(m.content) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: FOLLOW_UP });
  const last = messages[messages.length - 1];
  last.content = `${cleanCc ? `ข้อมูลผู้ป่วยเบื้องต้น / Case (chief complaint): ${cleanCc}\n\n` : ''}${last.content}`;
  const systemPrompt = [true, false]
    .map((socratic) => chatSystemPrompt({ socratic, artifacts: true, evidenceMarker: true }))
    .sort((a, b) => b.length - a.length)[0];
  return { systemPrompt, messages };
}

const PROMPT_FOR = { local: evaluatorPrompt, 'local-tutor': tutorPrompt };

// ---------------------------------------------------------------------------------------------------------
// The rows.

const row = (check, pass, evidence, notes) => ({
  id: check.id, title: check.title, status: pass ? 'pass' : 'fail', evidence, ...(notes ? { notes } : {}),
});

async function checkReachability(ctx) {
  const evidence = {};
  let pass = true;
  for (const name of INSTANCES) {
    const inst = ctx.instances[name];
    const ready = await inst.ready();
    const chat = ready.status === 'up' ? await inst.chatOnce(REACH_PROMPT) : { ok: false, reason: 'not_reached' };
    evidence[name] = { models_status: ready.status, models_error: ready.error, model: ready.model, chat_ok: chat.ok, chat_reason: chat.reason, chat_ms: chat.ms ?? null };
    pass = pass && ready.status === 'up' && chat.ok;
  }
  return row(this, pass, evidence);
}

// Each purpose through its real route at its configured ceiling. chat-deep asks for thinking (router on,
// the sticky latch set) and must have it honoured wherever the answering provider supports it.
const PURPOSE_PROBES = [
  { id: 'chat-fast', path: '/chat', shape: 'chat', purpose: 'chat', body: () => chatBody(), maxTokens: () => CHAT_MAX_TOKENS },
  { id: 'chat-deep', path: '/chat', shape: 'chat', purpose: 'chat', body: () => chatBody({ router_enabled: true, deep_mode: true }), maxTokens: () => CHAT_DEEP_MAX_TOKENS, deep: true },
  { id: 'criteria', path: '/evaluate-criteria', shape: 'criteria', purpose: 'criteria', body: criteriaBody, maxTokens: () => CRITERIA_DECODING.maxTokens },
  { id: 'discuss', path: '/audit-discuss', shape: 'discuss', purpose: 'discuss', body: discussBody, maxTokens: () => discussMaxTokens() },
  { id: 'evaluate', path: '/evaluate', shape: 'evaluate', purpose: 'evaluate', body: evalBody, maxTokens: () => EVAL_DECODING.maxTokens },
];

async function checkInferenceShape(ctx) {
  const evidence = {};
  let pass = true;
  for (const probe of PURPOSE_PROBES) {
    const res = await ctx.post(probe.path, probe.body(), { timeoutMs: probe.purpose === 'evaluate' ? ctx.opts.evalTimeoutMs : ctx.opts.turnTimeoutMs });
    const verdict = classifyReply(probe.shape, res);
    const provider = word(res.body?.provider);
    const configured = provider && ctx.instances[provider] ? ctx.instances[provider].configured() : null;
    const floor = configured?.max_tokens_floor?.[probe.purpose] ?? 0;
    const thinkingSupported = probe.deep && provider ? ctx.supportsThinking(provider) : null;
    const thinking = probe.deep ? res.body?.middleware_flags?.thinking ?? null : null;
    const thinkingOk = !probe.deep || !thinkingSupported || thinking === true;
    evidence[probe.id] = {
      status: res.status ?? null, reason: verdict.reason, provider, ms: res.ms,
      max_tokens: Math.max(probe.maxTokens(), floor), thinking_style: word(configured?.thinking_style),
      ...(probe.deep ? { thinking_supported: thinkingSupported, thinking } : {}),
    };
    pass = pass && verdict.ok && thinkingOk;
  }
  // Control: a reply with no text, produced by the real route from a server that answers empty, must be
  // classified as a failure.
  const control = await ctx.withEndpoint('empty', () => ctx.post('/chat', chatBody(), { timeoutMs: 60000 }));
  const controlVerdict = classifyReply('chat', control);
  const controlOk = !controlVerdict.ok && controlVerdict.reason === 'empty_reply';
  evidence.control = { forced_empty_reply_status: control.status ?? null, classified_as: controlVerdict.reason, behaved: controlOk };
  return row(this, pass && controlOk, evidence, controlOk ? undefined : 'control_broken');
}

async function checkLatency(ctx) {
  const { opts } = ctx;
  const weakened = weakerOverrides(opts, ['chatSamples', 'evalSamples', 'chatP95Ms', 'evalP95Ms']);
  const drain = startDrain(ctx, { concurrency: opts.drainConcurrency, timeoutMs: opts.evalTimeoutMs });
  const chat = [];
  const send = chatTurn(ctx, opts.turnTimeoutMs);
  let history = [];
  for (let i = 0; i < opts.chatSamples; i++) {
    const turn = i % PHYSICIAN_TURNS.length;
    if (turn === 0) history = [];
    const t0 = ctx.now();
    const r = await send({ history, turn });
    chat.push({ ms: ctx.now() - t0, ok: r.ok, reason: r.reason });
    if (r.ok) history = [...history, { role: 'physician', content: physicianTurn(turn) }, { role: 'assistant', content: r.reply }];
  }
  const evalsDuringChat = drain.samples.length;
  await drain.waitFor(opts.evalSamples);
  const evals = await drain.stop();
  const chatJudge = judgeP95(chat.filter((r) => r.ok).map((r) => r.ms), { minN: opts.chatSamples, limitMs: opts.chatP95Ms, inclusive: false });
  const evalJudge = judgeP95(evals.filter((r) => r.ok).map((r) => r.ms), { minN: opts.evalSamples, limitMs: opts.evalP95Ms, inclusive: true });
  const chatErrors = chat.filter((r) => !r.ok).length;
  const evalErrors = evals.filter((r) => !r.ok).length;
  const pass = chatJudge.pass && evalJudge.pass && chatErrors === 0 && evalErrors === 0 && !weakened.length;
  return row(this, pass, {
    chat: { ...chatJudge, errors: chatErrors, error_reasons: reasons(chat) },
    evaluate: { ...evalJudge, errors: evalErrors, error_reasons: reasons(evals), completed_during_chat: evalsDuringChat },
    drain_concurrency: opts.drainConcurrency,
    weaker_than_ticket: weakened,
  });
}

async function checkConcurrency(ctx) {
  const { opts } = ctx;
  const weakened = weakerOverrides(opts, ['sessions', 'deadlineMs']);
  const minTurns = minTurnsForZeroMissPass();
  const turns = Math.ceil(minTurns / opts.sessions);

  // Control: the same driver and judge, over a stub transport. With no delay the run must pass; with a
  // delay past the deadline on every fifth turn (20% misses) it must fail.
  const stub = (delayFor) => async ({ turn }) => { await ctx.sleep(delayFor(turn)); return { ok: true, reason: 'ok', reply: ASSISTANT_TURN }; };
  const ctl = { sessions: 10, turns: Math.ceil(minTurns / 10), now: ctx.now };
  const CONTROL_DEADLINE_MS = 50;
  const clean = judgeConcurrency(await runSessions({ ...ctl, sendTurn: stub(() => 0) }), { deadlineMs: CONTROL_DEADLINE_MS });
  const delayed = judgeConcurrency(await runSessions({ ...ctl, sendTurn: stub((t) => (t % 5 === 0 ? 2 * CONTROL_DEADLINE_MS : 0)) }), { deadlineMs: CONTROL_DEADLINE_MS });
  const controlOk = clean.pass && !delayed.pass && delayed.reason === 'misses_over_bound';

  const drain = startDrain(ctx, { concurrency: opts.drainConcurrency, timeoutMs: opts.evalTimeoutMs });
  const records = await runSessions({ sessions: opts.sessions, turns, sendTurn: chatTurn(ctx, opts.turnTimeoutMs), now: ctx.now });
  const evals = await drain.stop();
  const verdict = judgeConcurrency(records, { deadlineMs: opts.deadlineMs, minTurns });
  const latencies = records.filter((r) => r.ok).map((r) => r.ms);
  return row(this, verdict.pass && controlOk && !weakened.length, {
    sessions: opts.sessions, turns_per_session: turns, ...verdict,
    p95_ms: percentile(latencies, 95), lost_reasons: reasons(records),
    drain: { concurrency: opts.drainConcurrency, evaluations_completed: evals.length, evaluation_errors: evals.filter((r) => !r.ok).length },
    control: { clean_pass: clean.pass, delayed_reason: delayed.reason, delayed_miss_upper_95: delayed.miss_upper_95, behaved: controlOk },
    weaker_than_ticket: weakened,
  }, controlOk ? undefined : 'control_broken');
}

async function checkContext(ctx) {
  const sandbox = await ctx.sandboxTranscript();
  if (!sandbox.transcript) {
    return row(this, false, { sandbox_ples: sandbox.ples ?? null, reason: sandbox.error || 'nothing_to_measure' });
  }
  const { turns } = sandbox.transcript;
  for (const t of turns) ctx.sensitive(t.content);
  if (sandbox.transcript.chiefComplaint) ctx.sensitive(sandbox.transcript.chiefComplaint);
  const evidence = { sandbox_ples: sandbox.ples, longest_transcript_turns: turns.length, max_share: CONTEXT_SHARE };
  let pass = true;
  for (const name of INSTANCES) {
    const inst = ctx.instances[name];
    const window = await inst.window();
    const counted = await inst.promptTokens(PROMPT_FOR[name](sandbox.transcript));
    const tokens = counted.tokens;
    const reason = window.tokens == null ? 'window_not_reported'
      : !(tokens > 0) ? counted.reason || 'usage_not_reported'
        : tokens > CONTEXT_SHARE * window.tokens ? 'over_share' : 'ok';
    evidence[name] = {
      prompt_tokens: tokens > 0 ? tokens : null, window_tokens: window.tokens, window_source: window.source,
      share: tokens > 0 && window.tokens ? Number((tokens / window.tokens).toFixed(3)) : null, reason,
    };
    pass = pass && reason === 'ok';
  }
  return row(this, pass, evidence);
}

// The backend fails a chat turn closed on any non-2xx, and requeues an evaluation unless its status is
// deterministic. Down here means the on-prem endpoints, both of them, refusing or answering 5xx.
async function checkFailureDown(ctx) {
  const evidence = {};
  let pass = true;
  for (const kind of ['refused', 'error']) {
    const { chat, evaluate } = await ctx.withEndpoint(kind, async () => ({
      chat: await ctx.post('/chat', chatBody(), { timeoutMs: 60000 }),
      evaluate: await ctx.post('/evaluate', evalBody(), { timeoutMs: 60000 }),
    }));
    const chatClosed = !chat.error && !(chat.status >= 200 && chat.status < 300)
      && chat.body?.content === undefined && chat.body?.provider !== 'anthropic';
    const requeued = !evaluate.error && !(evaluate.status >= 200 && evaluate.status < 300) && !DETERMINISTIC_STATUSES.has(evaluate.status);
    evidence[kind] = {
      chat_status: chat.status ?? null, chat_code: word(chat.body?.code), chat_failed_closed: chatClosed,
      evaluate_status: evaluate.status ?? null, evaluate_requeued: requeued,
    };
    pass = pass && chatClosed && requeued;
  }
  return row(this, pass, evidence);
}

// Local-only mode on, in a child RIMPL whose settings store is a loopback stand-in: one that routes chat to
// anthropic, and one that cannot be read since boot (a cold cache). Both must refuse, and nothing may reach
// the Anthropic stand-in.
const LOCAL_ONLY_CASES = [
  { id: 'routed_to_anthropic', settings: 'chat-anthropic' },
  { id: 'cold_settings_cache', settings: 'unreadable' },
];

async function checkLocalOnly(ctx) {
  const evidence = {};
  let pass = true;
  for (const c of LOCAL_ONLY_CASES) {
    const before = ctx.anthropicRequests();
    const res = await ctx.childApp(c.settings, (child) => child.post('/chat', chatBody(), { timeoutMs: 60000 }));
    const sent = ctx.anthropicRequests() - before;
    const refused = res.status === 503 && res.body?.code === 'local_only_refused' && res.body?.content === undefined;
    evidence[c.id] = { status: res.status ?? null, code: word(res.body?.code), refused, anthropic_requests: sent };
    pass = pass && refused && sent === 0;
  }
  return row(this, pass, evidence);
}

const CHECKS = [
  { id: 'reachability', title: 'Both on-prem endpoints answer /models and one chat', run: checkReachability },
  { id: 'inference-shape', title: 'Every purpose returns content at its configured ceiling and thinking style', run: checkInferenceShape },
  { id: 'context', title: 'Longest sandbox transcript plus prompt fits 80% of each served window', run: checkContext },
  { id: 'failure-down', title: 'Endpoints down: chat fails closed, evaluate requeues', run: checkFailureDown },
  { id: 'local-only', title: 'Local-only mode refuses anthropic routing and a cold settings cache', run: checkLocalOnly },
  { id: 'latency', title: 'Chat p95 < 15 s (n >= 30) under the drain; evaluate p95 <= 240 s (n >= 10)', run: checkLatency },
  { id: 'concurrency', title: '10 sessions plus the drain: misses <= 5% (Wilson upper), no turn lost', run: checkConcurrency },
];

// Decided by people, listed so the go/no-go names them. Wording from roadmap D18 and ADR 0012.
const OWNER_GATED = [
  { id: 'decisive-icc', title: 'Decisive evaluator gate: candidate vs human ICC >= 0.75 (roadmap D18), before Model Lock' },
  { id: 'clinician-thai-read', title: 'A clinician has read a Thai sample and recorded it usable (ADR 0012; QUALITY-GATES C-3)' },
];

const ROW_IDS = [...CHECKS.map((c) => c.id), ...OWNER_GATED.map((g) => g.id)];

// ---------------------------------------------------------------------------------------------------------
// The run and its report.

async function runReadiness(ctx, { only = null, onProgress = () => {} } = {}) {
  const pick = (id) => !only || only.includes(id);
  const startedAt = ctx.now();
  const rows = [];
  for (const check of CHECKS.filter((c) => pick(c.id))) {
    onProgress(check.id, 'start');
    const t0 = ctx.now();
    let result;
    try {
      result = await check.run.call(check, ctx);
    } catch (e) {
      result = row(check, false, { reason: 'check_crashed', error: word(e?.code) || word(e?.name) || 'error' });
    }
    result.evidence = { ...result.evidence, duration_s: Math.round((ctx.now() - t0) / 1000) };
    rows.push(result);
    onProgress(check.id, result.status);
  }
  for (const gate of OWNER_GATED.filter((g) => pick(g.id))) {
    rows.push({ id: gate.id, title: gate.title, status: 'owner-gated', evidence: {}, notes: 'owner-gated, not measured here' });
  }
  const measured = rows.filter((r) => r.status !== 'owner-gated');
  const failed = measured.filter((r) => r.status === 'fail').map((r) => r.id);
  return {
    schema: 'clics-readiness/1',
    verdict: measured.length && !failed.length ? 'GO' : 'NO-GO',
    failed,
    anthropic_requests: ctx.anthropicRequests(),
    duration_s: Math.round((ctx.now() - startedAt) / 1000),
    options: ctx.opts,
    rows,
  };
}

const exitCodeFor = (report) => (report.verdict === 'GO' ? 0 : 1);

function flatten(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v)
    ? flatten(v, `${prefix}${k}.`)
    : [`${prefix}${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`]));
}

function formatText(report) {
  const lines = [
    'CLICS readiness, vm1 cutover (#431)',
    `verdict: ${report.verdict}${report.failed.length ? ` (failed: ${report.failed.join(', ')})` : ''}`,
    `anthropic_requests: ${report.anthropic_requests}   duration_s: ${report.duration_s}`,
    `options: ${flatten(report.options).join(' ')}`,
    '',
  ];
  for (const r of report.rows) {
    lines.push(`[${r.status.toUpperCase()}] ${r.id}: ${r.title}`);
    if (r.notes) lines.push(`  note: ${r.notes}`);
    for (const kv of flatten(r.evidence)) lines.push(`  ${kv}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// The report must be safe to paste into an issue. Anything that looks like a key, an address or a sentence
// a run sent or read withholds the whole report.

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/i;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6_RE = /\[[0-9a-f:]+\]|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASS|AUTH|SALT|PRIVATE|CREDENTIAL)/i;
const URL_NAME_RE = /(_URL|_PROXY|_HOST)$/i;
const MIN_LITERAL = 12;

// From the env as it was before the run touched it: every secret value, and the host of every URL.
function sensitiveFromEnv(environment) {
  const out = [];
  for (const [name, value] of Object.entries(environment)) {
    const v = String(value ?? '').trim();
    if (!v) continue;
    if (SECRET_NAME_RE.test(name) && v.length >= 6) out.push({ class: 'secret', value: v });
    if (URL_NAME_RE.test(name)) {
      try { out.push({ class: 'host', value: new URL(v).hostname }); } catch { /* not a URL */ }
    }
  }
  // A two-letter compose service name ("db") would match half the words in the report.
  return out.filter((s) => s.value && (s.class !== 'host' || s.value.length >= 4));
}

function findUnsafe(text, sensitive) {
  for (const s of sensitive) if (s.value && text.includes(s.value)) return s.class;
  if (URL_RE.test(text) || IPV4_RE.test(text) || IPV6_RE.test(text)) return 'address';
  return null;
}

function assertSafe(text, sensitive) {
  const cls = findUnsafe(text, sensitive);
  if (cls) throw Object.assign(new Error(`report withheld: contained ${cls}`), { code: 'report_withheld', class: cls });
  return text;
}

const literal = (cls) => (value) => ({ class: cls, value: String(value ?? '').trim() });
const longEnough = (s) => s.value.length >= MIN_LITERAL;

module.exports = {
  CHECKS, OWNER_GATED, ROW_IDS, OPTIONS, INSTANCES, DETERMINISTIC_STATUSES, FIXTURE_TEXT, PURPOSE_PROBES,
  percentile, wilsonUpper, minTurnsForZeroMissPass, judgeP95, judgeConcurrency, classifyReply,
  resolveOptions, weakerOverrides, ticketValue, runSessions, startDrain,
  runReadiness, exitCodeFor, formatText, sensitiveFromEnv, findUnsafe, assertSafe,
  fixtureLiterals: () => FIXTURE_TEXT.map(literal('fixture')).filter(longEnough),
  textLiteral: (value) => [literal('transcript')(value)].filter(longEnough),
};
