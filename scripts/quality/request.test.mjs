// The audit must send what rimpl's chat route sends. These tests pin the replicas in request.mjs to
// the production source TEXT (chat.js cannot be imported without express/zod), exercise the runner
// with a mock transport, and prove the paid arm and the dry run cannot reach the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildChatRequest, buildMessages, retryDecision, retryPrompt, retryMessages, RETRY_PROMPTS, CC_PREFIX, CHAT_MAX_TOKENS, routeLanguage,
  LANGUAGE_SUFFIX, LANGUAGE_ONLY_PROMPT, LANGUAGE_ONLY_PROMPT_TH, LANGUAGE_ONLY_PROMPT_EN, expectedReplyLanguage,
  retryReason, evidenceSplice, optionalRetrySkipped, retryMaxTokens, evidencePlacement,
} from './request.mjs';
import {
  RIMPL_FILES, RIMPL_SYSTEM_PROMPT_NATURAL, RIMPL_SYSTEM_PROMPT_EXAMINER, RIMPL_SYSTEM_PROMPT_RESCUE, ARTIFACT_GUIDANCE, promptLabel,
  EVIDENCE_GUIDANCE, EVIDENCE_RETRY_PROMPT, evidenceLineFor, EVIDENCE_LINE_MAX_TOKENS, CHAT_OPTIONAL_RETRY_CUTOFF_MS,
} from './rimpl.mjs';
import { runItem, makeAnthropicArm, productionAnthropicModel, spendOf, runQueue, carriedTokens } from './tutor-audit.mjs';
import { ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII, GOOD_TH_EXAMINER } from './test-fixtures.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const chatSrc = readFileSync(RIMPL_FILES.chatRoute, 'utf8');

test('drift guard: every replicated string and rule still appears verbatim in routes/chat.js', () => {
  for (const mode of ['socratic', 'natural']) for (const lang of ['th', 'en']) {
    assert.ok(chatSrc.includes(RETRY_PROMPTS[mode][lang]), `retry prompt ${mode}/${lang} drifted from chat.js`);
  }
  assert.ok(chatSrc.includes(CC_PREFIX), 'chief-complaint prefix drifted from chat.js buildMessages');
  assert.ok(chatSrc.includes("role: m.role === 'physician' ? 'user' : 'assistant'"), 'role mapping drifted');
  assert.ok(chatSrc.includes('content: stripArtifactDelimiters(m.content)'), 'history artifact strip drifted');
  // PII de-identification and system-prompt assembly — the exact calls request.mjs makes.
  for (const line of [
    'const registry = makeRegistry();',
    "const cleanChiefComplaint = chiefComplaint ? stripPii(chiefComplaint, registry, hints) : '';",
    'const cleanHistory = stripHistoryPii(history, hints, registry);',
    'const cleanMessage = stripPii(message, registry, hints);',
    'deidentifyTurn({ chiefComplaint: chief_complaint, history, message, hints });',
    '${cleanChiefComplaint}',
    'const history = cleanHistory.map(m => ({',
  ]) assert.ok(chatSrc.includes(line), `one-registry de-identification drifted: ${line}`);
  assert.ok(chatSrc.includes('const hints = deriveHintTokens(patient_ref);'), 'PII hint derivation drifted');
  // System prompt = mode prompt + artifact guidance + the evidence guidance for the mode, in that order.
  assert.ok(chatSrc.includes("+ (artifacts ? ARTIFACT_GUIDANCE : '')\n    + (evidence_marker ? EVIDENCE_GUIDANCE[socratic ? 'examiner' : 'natural'] : '');"),
    'ARTIFACT_GUIDANCE / EVIDENCE_GUIDANCE concatenation drifted');
  // The single corrective retry (#109): both triggers, how they combine, prompts, fence, failure rule.
  for (const line of [
    'const needCitation = !rescuing && (!hasCitation(text) || (socratic && !extractSocraticQuestion(text)));',
    "const physicianWroteThai = language === 'th' && isThaiMessage(message);",
    'const languageMismatch = physicianWroteThai && isLanguageMismatch(text, language);',
    'if ((needCitation || languageMismatch || needRescue || needEvidence) && !retrySkipped) {',
    'const needRescue = rescuing && !checkRescueReply(text).ok;',
    'rescueRetried = needRescue;',
    'rescue_retry: rescueRetried,',
    'if (languageMismatch) retryPrompt += ',
    'const keepFence = !needCitation && !needRescue && artifacts;',
    "{ role: 'assistant', content: keepFence ? text : stripArtifactDelimiters(text) },",
    'if (isAborted(err) || needCitation) throw err;',
    'languageRetried = languageMismatch;',
    'language_retry: languageRetried,',
    // The evidence marker (CCME R5): its trigger, its share of the prompt selection, the rewrite that
    // does not hold, and the two response fields — request.mjs retryDecision / retryPrompt /
    // retryReason / evidenceSplice / optionalRetrySkipped / retryMaxTokens replicate exactly these.
    'const needEvidence = evidence_marker && !rescuing && extractEvidenceLevel(text) == null;',
    '} else if (languageMismatch) {',
    'retryPrompt = EVIDENCE_RETRY_PROMPT.only[language];',
    "const reason = needCitation ? 'citation' : needRescue ? 'rescue' : languageMismatch ? 'language' : needEvidence ? 'evidence' : null;",
    // The deadline: only the two OPTIONAL retries are skipped, by elapsed time against the cutoff.
    'const elapsedMs = Date.now() - turnStartedAt;',
    "const retrySkipped = (reason === 'language' || reason === 'evidence') && elapsedMs > CHAT_OPTIONAL_RETRY_CUTOFF_MS;",
    // Evidence-only: a small line-only call, no up-front replace, the one line spliced into the first reply.
    "const evidenceOnly = reason === 'evidence';",
    "if (sse && firstShown && !evidenceOnly) { sse.send('replace', { reason }); shown = false; }",
    'maxTokens: evidenceOnly ? EVIDENCE_LINE_MAX_TOKENS : CHAT_MAX_TOKENS, signal });',
    'if (retry && evidenceOnly) {',
    'const spliced = spliceEvidenceLine(firstText, retry.text, { socratic });',
    'text = spliced.text;',
    'evidenceRetried = needEvidence;',
    'evidence_retry: evidenceRetried,',
    'evidence_level: evidence_marker && !rescuing ? extractEvidenceLevel(text) : null,',
    // PLACEMENT (evidencePlacement + runItem replicate these): the same gate as the check; applied to an
    // adopted retry, and to the first reply when it is the one returned — never to a spliced reply.
    'const placeMarker = (t) => (evidence_marker && !rescuing ? placeEvidenceLine(t, { socratic }) : null);',
    'text = placeMarker(retry.text) ?? retry.text;',
    'const firstReply = text;',
    'if (text === firstReply) {',
    'const placed = placeMarker(text);',
  ]) assert.ok(chatSrc.includes(line), `retry logic drifted from chat.js: ${line}`);
  assert.equal(chatSrc.split('placeMarker(').length - 1, 2, 'placeMarker: exactly two uses (adopted retry, first reply)');
  // The suffix rides on BOTH the citation re-answer and the Thai rewrite, and nowhere else (not rescue).
  assert.equal(chatSrc.split('if (needEvidence) retryPrompt += EVIDENCE_RETRY_PROMPT.suffix[language];').length - 1, 2,
    'the evidence suffix must be appended in exactly the citation and language branches');
  for (const str of [LANGUAGE_SUFFIX, LANGUAGE_ONLY_PROMPT_TH, LANGUAGE_ONLY_PROMPT_EN]) {
    assert.ok(chatSrc.includes(str), `language retry prompt drifted: ${str.slice(0, 40)}…`);
  }
  // The client's language label (ple-chat.js): 'th' when the message holds ANY Thai codepoint.
  const pleChat = readFileSync(path.join(HERE, '..', '..', 'physician-ui', 'public', 'js', 'ple-chat.js'), 'utf8');
  assert.ok(pleChat.includes("const language = /[\u0E00-\u0E7F]/.test(message) ? 'th' : 'en';"), 'client language rule drifted');
  // CHAT_MAX_TOKENS lives in lib/turn-limits.js (it also sizes the per-turn length cap); chat.js
  // must still take it from there and pass it as maxTokens on both the first call and the retry.
  const limitsSrc = readFileSync(path.join(HERE, '..', '..', 'rimpl', 'src', 'lib', 'turn-limits.js'), 'utf8');
  assert.ok(limitsSrc.includes("const CHAT_MAX_TOKENS = Math.max(1500, parseInt(process.env.RIMPL_CHAT_MAX_TOKENS || '4000', 10));"), 'CHAT_MAX_TOKENS drifted');
  assert.ok(chatSrc.includes("const { CHAT_MAX_TOKENS, MAX_TURN_CHARS, EVIDENCE_LINE_MAX_TOKENS, CHAT_OPTIONAL_RETRY_CUTOFF_MS } = require('../lib/turn-limits');"), 'chat.js no longer takes its limits from turn-limits');
  // At most two calls a turn: the first at the full ceiling, and the retry at the full ceiling unless
  // it is the marker-only call, which gets the small cap.
  assert.equal(chatSrc.split('maxTokens: CHAT_MAX_TOKENS,').length - 1, 1, 'chat.js must pass CHAT_MAX_TOKENS on the first call');
  assert.equal(chatSrc.split('maxTokens: evidenceOnly ? EVIDENCE_LINE_MAX_TOKENS : CHAT_MAX_TOKENS').length - 1, 1, 'chat.js must size the retry by its kind');
  assert.equal(chatSrc.split('await callAI(').length - 1, 2, 'chat.js must make at most two model calls a turn');
  assert.ok(chatSrc.includes("(socratic ? RIMPL_SYSTEM_PROMPT_EXAMINER : RIMPL_SYSTEM_PROMPT_NATURAL)"), 'mode→prompt selection drifted');
  assert.ok(chatSrc.includes('systemPrompt = RIMPL_SYSTEM_PROMPT_RESCUE'), 'rescue prompt replacement drifted');
  assert.ok(chatSrc.includes("promptLabel('chat', systemPrompt)"), 'prompt_version label drifted');
  assert.equal(CHAT_MAX_TOKENS, Math.max(1500, parseInt(process.env.RIMPL_CHAT_MAX_TOKENS || '4000', 10)));
});

test('loads without a single package — the CI quality job has no npm install', () => {
  const closure = (file, seen = new Set()) => {
    if (!seen.has(file)) {
      seen.add(file);
      for (const child of require.cache[file]?.children ?? []) closure(child.filename, seen);
    }
    return seen;
  };
  const roots = ['../../rimpl/src/services/rescue.js', '../../rimpl/src/lib/prompts.js', '../../rimpl/src/services/pii-filter.js',
    '../../rimpl/src/lib/transcript.js', '../../rimpl/src/services/post-filter.js', '../../rimpl/src/lib/versions.js'].map((p) => require.resolve(p));
  const deps = [...new Set(roots.flatMap((r) => [...closure(r)]))];
  assert.ok(deps.some((f) => f.endsWith(path.join('services', 'rescue.js'))), 'rescue.js must be in the closure');
  assert.deepEqual(deps.filter((f) => f.includes(`${path.sep}node_modules${path.sep}`)), []);
});

test('system prompt per mode is production\'s, and the rescue prompt replaces (not appends) with artifacts on', () => {
  assert.equal(buildChatRequest(ITEM_EN_NATURAL).systemPrompt, RIMPL_SYSTEM_PROMPT_NATURAL);
  assert.equal(buildChatRequest(ITEM_TH_EXAMINER).systemPrompt, RIMPL_SYSTEM_PROMPT_EXAMINER);
  assert.equal(buildChatRequest(ITEM_TH_EXAMINER, { artifacts: true }).systemPrompt, RIMPL_SYSTEM_PROMPT_EXAMINER + ARTIFACT_GUIDANCE);
  assert.equal(buildChatRequest(ITEM_RESCUE, { artifacts: true }).systemPrompt, RIMPL_SYSTEM_PROMPT_RESCUE);
  const r = buildChatRequest(ITEM_TH_EXAMINER);
  assert.equal(r.promptVersion, promptLabel('chat', RIMPL_SYSTEM_PROMPT_EXAMINER));
  assert.equal(r.socratic, true);
  assert.equal(buildChatRequest(ITEM_RESCUE).socratic, false, 'production only rescues natural-mode sessions');
});

test('messages: history mapped physician→user, chief complaint prefixed, PII stripped by rimpl\'s filter', () => {
  const r = buildChatRequest({ ...ITEM_RESCUE, chief_complaint: 'ไข้' });
  assert.equal(r.messages.length, ITEM_RESCUE.turns.length);
  assert.deepEqual(r.messages.slice(0, 2).map((m) => m.role), ['user', 'assistant']);
  assert.ok(r.messages.at(-1).content.startsWith(`${CC_PREFIX}ไข้\n\n`));
  const pii = buildChatRequest(ITEM_PII);
  assert.doesNotMatch(pii.messages[0].content, /00998877/, 'the MRN must be masked before any model sees it');
  // The bare English name has no label and no hint: production's filter lets it through. The request
  // records that as a FILTER gap, separately from anything the model then does with it.
  assert.deepEqual(pii.identifiersSent, ['John Testcase']);
  const withArtifact = buildMessages([{ role: 'assistant', content: ':::artifact{type="care_plan" title="x"}\nbody\n:::' }], 'msg', '');
  assert.equal(withArtifact[0].content.trim(), 'body', 'the fence is stripped from history, the body kept');
  assert.deepEqual(withArtifact[1], { role: 'user', content: 'msg' });
  assert.equal(routeLanguage('What is CAP? ครับ'), 'th', 'any Thai codepoint, as the client sets it');
  assert.equal(routeLanguage('What is CAP?'), 'en');
  assert.equal(expectedReplyLanguage(ITEM_EN_NATURAL), 'en');
});

const TH_MSG = 'ผู้ป่วยเจ็บหน้าอก ควรทำอย่างไรต่อไป';
const EN_REPLY_CITED = 'Do an ECG within ten minutes of arrival and measure troponin (ESC ACS, 2023).';
test('retry decision = chat.js: citation/❓ check and the language guard, combined into ONE retry', () => {
  const base = { socratic: false, rescuing: false, language: 'th', message: TH_MSG };
  assert.deepEqual(retryDecision('ตอบโดยไม่มีอ้างอิง', base), { fire: true, needCitation: true, languageMismatch: false, needRescue: false, needEvidence: false, physicianWroteThai: true });
  assert.equal(retryDecision('มีอ้างอิง (KDIGO, 2022)', base).fire, false);
  assert.equal(retryDecision('มีอ้างอิง (KDIGO, 2022)', { ...base, socratic: true }).needCitation, true, 'examiner also needs ❓');
  // Language only: Thai turn, English but cited reply -> rewrite prompt, no citation prompt.
  const lang = retryDecision(EN_REPLY_CITED, base);
  assert.deepEqual([lang.fire, lang.needCitation, lang.languageMismatch], [true, false, true]);
  assert.equal(retryPrompt(lang, base), LANGUAGE_ONLY_PROMPT);
  // Both failed -> the citation prompt with the language suffix: still a SINGLE retry.
  const both = retryDecision('Do an ECG within ten minutes of arrival and measure troponin.', base);
  assert.equal(retryPrompt(both, base), RETRY_PROMPTS.natural.th + LANGUAGE_SUFFIX);
  // Rescue: never a citation retry, but the language guard still applies (a rewrite, not an answer).
  const rescue = retryDecision('Do an ECG within ten minutes of arrival and measure troponin.', { ...base, rescuing: true });
  assert.deepEqual([rescue.needCitation, rescue.languageMismatch], [false, true]);
  // An English turn is never policed; a 'th'-labelled turn written mostly in English is not either.
  assert.equal(retryDecision(EN_REPLY_CITED, { ...base, language: 'en', message: 'Chest pain, what next?' }).fire, false);
  assert.equal(retryDecision(EN_REPLY_CITED, { ...base, message: 'Chest pain workup in the emergency department, what next? ครับ' }).languageMismatch, false);
});

test('retry messages: a citation retry strips the fence; a language-only rewrite keeps it only with artifacts on', () => {
  const fenced = 'a\n:::artifact{type="x" title="t"}\nbody\n:::';
  const opts = { socratic: true, language: 'th' };
  const cit = retryMessages([{ role: 'user', content: 'q' }], fenced, { needCitation: true, languageMismatch: false }, { ...opts, artifacts: true });
  assert.equal(cit.length, 3);
  assert.doesNotMatch(cit[1].content, /:::artifact/);
  assert.equal(cit[2].content, RETRY_PROMPTS.socratic.th);
  const langOn = retryMessages([], fenced, { needCitation: false, languageMismatch: true }, { ...opts, artifacts: true });
  assert.match(langOn[0].content, /:::artifact/);
  const langOff = retryMessages([], fenced, { needCitation: false, languageMismatch: true }, { ...opts, artifacts: false });
  assert.doesNotMatch(langOff[0].content, /:::artifact/);
});

test('runItem: retries once on a missing citation, keeps BOTH replies, judges the final one', async () => {
  const calls = [];
  const complete = async (req) => {
    calls.push(req);
    return calls.length === 1
      ? { ok: true, text: 'ควรทำ ECG ภายใน 10 นาที', ms: 10, finishReason: 'stop', completionTokens: 5, model: 'm', raw: { system_fingerprint: 'fp-1' } }
      : { ok: true, text: GOOD_TH_EXAMINER, ms: 20, finishReason: 'stop', completionTokens: 9, model: 'm', raw: { system_fingerprint: 'fp-1' } };
  };
  const e = await runItem(ITEM_TH_EXAMINER, complete, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.at(-1).content, RETRY_PROMPTS.socratic.th);
  assert.equal(e.first.text, 'ควรทำ ECG ภายใน 10 นาที');
  assert.equal(e.final.text, GOOD_TH_EXAMINER);
  assert.equal(e.final.from, 'retry');
  assert.equal(e.final.system_fingerprint, 'fp-1');
  assert.match(e.retry.reason, /no citation/);
  assert.equal(e.latency_ms_total, 30);
  assert.deepEqual(e.checks.flags.filter((f) => f.severity !== 'info'), []);
});

test('runItem: language-only retry — delivered when it succeeds, first reply KEPT when it fails', async () => {
  const thItem = { ...ITEM_EN_NATURAL, id: 'fx-th-lang', language: 'th', turns: [{ role: 'physician', content: TH_MSG }] };
  let n = 0;
  const ok = async () => (++n === 1 ? { ok: true, text: EN_REPLY_CITED, ms: 5 } : { ok: true, text: 'ตรวจคลื่นไฟฟ้าหัวใจภายในสิบนาที (ESC ACS, 2023)', ms: 7 });
  const e = await runItem(thItem, ok, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.deepEqual([n, e.retry.reason, e.retry.language, e.retry.citation, e.language_retry], [2, 'language', true, false, true]);
  assert.equal(e.final.from, 'retry');
  assert.equal(e.request.physician_wrote_thai, true);
  assert.equal(e.checks.checks.language.pass, true);
  n = 0;
  const failing = async () => (++n === 1 ? { ok: true, text: EN_REPLY_CITED, ms: 5 } : { ok: false, status: 503, error: 'HTTP 503', text: '' });
  const k = await runItem(thItem, failing, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.equal(k.final.ok, true, 'a failed language-only retry must not cost the physician the turn');
  assert.equal(k.final.text, EN_REPLY_CITED);
  assert.match(k.final.from, /^first/);
  assert.deepEqual([k.retry.ok, k.language_retry], [false, false]);
  assert.equal(k.checks.flags.find((f) => f.code === 'wrong_language')?.severity, 'critical', 'production would deliver English');
  n = 0;
  const citFail = async () => (++n === 1 ? { ok: true, text: 'ไม่มีอ้างอิง', ms: 5 } : { ok: false, status: 503, error: 'HTTP 503', text: '' });
  const c = await runItem(thItem, citFail, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.equal(c.final.ok, false, 'a failed citation retry fails the turn, as in chat.js');
});

test('runItem: no retry on a failed first call or a rescue turn; --no-retry measures first pass', async () => {
  let n = 0;
  const failing = async () => { n += 1; return { ok: false, status: 400, error: 'HTTP 400', text: '' }; };
  const e = await runItem(ITEM_EN_NATURAL, failing, { maxTokens: 4000, retry: true, artifacts: false, attempts: 3 });
  assert.equal(n, 1, 'a 400 is not retryable and the chat route does not retry a thrown call');
  assert.equal(e.final.ok, false);
  n = 0;
  const plain = async () => { n += 1; return { ok: true, text: 'แพ้ยาแบบไหน?', ms: 5 }; };
  await runItem(ITEM_RESCUE, plain, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.equal(n, 1, 'a Thai rescue reply with no citation is never retried');
  n = 0;
  await runItem(ITEM_EN_NATURAL, plain, { maxTokens: 4000, retry: false, artifacts: false, attempts: 1 });
  assert.equal(n, 1);
});

test('runItem: a transport failure (5xx / network) is retried up to --attempts and the attempts are recorded', async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? { ok: false, status: 503, error: 'HTTP 503', text: '' } : { ok: true, text: 'Start at eGFR 20 (KDIGO, 2022).', ms: 5 });
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => orig(fn, 0); // do not actually wait 5 s in a unit test
  try {
    const e = await runItem(ITEM_EN_NATURAL, flaky, { maxTokens: 4000, retry: true, artifacts: false, attempts: 2 });
    assert.equal(e.final.ok, true);
    assert.equal(e.first.transport_attempts, 2);
    assert.equal(e.first.transport_errors[0].error, 'HTTP 503');
  } finally { globalThis.setTimeout = orig; }
});

test('paid arm: body mirrors providers/anthropic.js and goes ONLY through the injected fetch', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ model: 'claude-x', content: [{ type: 'text', text: 'hi (X, 2020)' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }) };
  };
  const complete = makeAnthropicArm({ apiKey: 'test-key-not-real', model: 'claude-x', timeoutMs: 1000, fetchImpl });
  const r = await complete({ systemPrompt: 'S', messages: [{ role: 'user', content: 'q' }], maxTokens: 4000 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(JSON.parse(seen[0].init.body), { model: 'claude-x', max_tokens: 4000, system: 'S', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(r.text, 'hi (X, 2020)');
  assert.match(productionAnthropicModel(), /^claude-/);
});

const run = (args, env = {}) => spawnSync(process.execPath, [path.join(HERE, 'tutor-audit.mjs'), ...args], {
  encoding: 'utf8', timeout: 30000,
  env: { PATH: process.env.PATH, ...env },   // no LOCAL_AI_*, no ANTHROPIC_API_KEY inherited
});

test('CLI: --arm anthropic refuses without --allow-paid (even as a dry run)', () => {
  const r = run(['--arm', 'anthropic', '--dry-run', '--limit', '1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /allow-paid/);
});

test('CLI: --dry-run needs no endpoint, prints the de-identified request, and writes nothing', () => {
  const r = run(['--dry-run', '--ids', 'adv-en-pii-echo-english,th-cardio-stemi']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 requests sent/);
  assert.match(r.stdout, /chat-prompt-[0-9a-f]{8}/);
  assert.match(r.stdout, /\[MRN-1\]/);
  assert.match(r.stdout, /identifiers reaching the model: John Testcase/);
  assert.doesNotMatch(r.stdout, /report written|report {2}\//);
});

/* ------------------------------------------------------------- --max-usd */

test('runItem records the retry call\'s input tokens too (the 2026-10-02 paid run did not)', async () => {
  let n = 0;
  const complete = async () => (++n === 1
    ? { ok: true, text: 'ควรทำ ECG ภายใน 10 นาที', ms: 1, promptTokens: 600, completionTokens: 50 }
    : { ok: true, text: GOOD_TH_EXAMINER, ms: 1, promptTokens: 700, completionTokens: 80 });
  const e = await runItem(ITEM_TH_EXAMINER, complete, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.deepEqual([e.retry.prompt_tokens, e.retry.completion_tokens], [700, 80]);
  assert.deepEqual(spendOf([e], { inPerMtok: 3, outPerMtok: 15 }), { in_tokens: 1300, out_tokens: 130, usd: (1300 * 3 + 130 * 15) / 1e6 });
});

test('spendOf: first + retry at the given prices; an old report without retry input counts 0 for it', () => {
  const items = [
    { first: { prompt_tokens: 1000, completion_tokens: 1000 }, retry: null },
    { first: { prompt_tokens: 1000, completion_tokens: 0 }, retry: { completion_tokens: 2000 } },
  ];
  const s = spendOf(items, { inPerMtok: 3, outPerMtok: 15 });
  assert.deepEqual([s.in_tokens, s.out_tokens], [2000, 3000]);
  assert.ok(Math.abs(s.usd - 0.051) < 1e-12);
});

test('runQueue: once recorded spend reaches the ceiling no further item starts; in-flight ones finish', async () => {
  const prices = { inPerMtok: 0, outPerMtok: 1e6 };           // 1 output token = $1, for readable arithmetic
  for (const concurrency of [1, 2, 3]) {
    const items = [];
    const todo = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    const runOne = async (id) => {
      await new Promise((r) => setTimeout(r, 1));
      items.push({ id, first: { prompt_tokens: 0, completion_tokens: 1 }, retry: null });   // $1 per item
    };
    const shouldStop = () => spendOf(items, prices).usd >= 3;
    const { stopped, started } = await runQueue(todo, runOne, { concurrency, shouldStop });
    assert.equal(stopped, true);
    assert.equal(items.length, started, 'every started item finished');
    assert.ok(items.length >= 3 && items.length <= 3 + concurrency - 1, `c=${concurrency}: ran ${items.length}`);
  }
  const all = await runQueue(['a', 'b'], async () => {}, { concurrency: 2 });
  assert.deepEqual(all, { stopped: false, started: 2 }, 'no ceiling: everything runs');
});

test('CLI: the paid arm refuses without a spend ceiling, and the ceiling refuses without prices', () => {
  const noCap = run(['--arm', 'anthropic', '--allow-paid', '--limit', '1']);
  assert.notEqual(noCap.status, 0);
  assert.match(noCap.stderr, /--max-usd/);
  const noPrice = run(['--arm', 'anthropic', '--allow-paid', '--limit', '1', '--max-usd', '1.5']);
  assert.notEqual(noPrice.status, 0);
  assert.match(noPrice.stderr, /usd-per-mtok-in/);
  // Prices that would disable or distort the ceiling: zero, per-1k-token slips, absurdly high, swapped.
  const bad = [
    [['0', '0'], /sanity band 0\.05–200/],
    [['3', '0'], /usd-per-mtok-out 0 is outside the sanity band/],
    [['0.003', '0.015'], /sanity band 0\.05–200 USD per MILLION/],
    [['3', '15000'], /outside the sanity band/],
    [['15', '3'], /below --usd-per-mtok-in.*swapped/],
  ];
  const outs = [noCap.stderr, noPrice.stderr];
  for (const [[pin, pout], re] of bad) {
    const r = run(['--arm', 'anthropic', '--allow-paid', '--limit', '1', '--max-usd', '5', '--usd-per-mtok-in', pin, '--usd-per-mtok-out', pout]);
    assert.notEqual(r.status, 0, `${pin}/${pout} must refuse`);
    assert.match(r.stderr, re, `${pin}/${pout}`);
    outs.push(r.stderr);
  }
  // Every refusal comes before the API-key check: nothing could have been sent.
  assert.doesNotMatch(outs.join('\n'), /ANTHROPIC_API_KEY/);
});

test('--resume: tokens billed to a failed attempt that is re-run are carried forward, not dropped', () => {
  const prior = {
    replaced_attempts_tokens: { in_tokens: 100, out_tokens: 10 },
    items: [
      { final: { ok: true }, first: { prompt_tokens: 5000, completion_tokens: 5000 }, retry: null },        // kept, counted as an item
      { final: { ok: false }, first: { prompt_tokens: 700, completion_tokens: 900 }, retry: { prompt_tokens: 1600, completion_tokens: 0 } },
    ],
  };
  assert.deepEqual(carriedTokens(prior), { in_tokens: 100 + 700 + 1600, out_tokens: 10 + 900 });
  assert.deepEqual(carriedTokens(null), { in_tokens: 0, out_tokens: 0 });
});

test('rescue retry = chat.js: a rescue reply that breaks the rules fires ONE rewrite retry with RESCUE_RETRY_PROMPT', async () => {
  const { RESCUE_RETRY_PROMPT } = await import('./rimpl.mjs');
  const base = { socratic: true, rescuing: true, language: 'en', message: 'dose?' };
  const ans = retryDecision('Rivaroxaban 20 mg once daily (ROCKET AF, 2011).', base);
  assert.deepEqual([ans.fire, ans.needRescue, ans.needCitation], [true, true, false]);
  assert.equal(retryMessages([{ role: 'user', content: 'q' }], 'x', ans, base).at(-1).content, RESCUE_RETRY_PROMPT.en);
  const th = retryDecision('ให้ 20 mg วันละครั้ง', { ...base, language: 'th', message: 'ขนาดยาเท่าไร' });
  assert.equal(retryMessages([], 'x', th, { ...base, language: 'th' }).at(-1).content.startsWith(RESCUE_RETRY_PROMPT.th), true);
  assert.equal(retryDecision('What are you weighing here?', base).fire, false);
  assert.equal(retryDecision('Rivaroxaban 20 mg once daily (ROCKET AF, 2011).', { ...base, rescuing: false, socratic: false }).needRescue, false);
  assert.ok(chatSrc.includes("retryPrompt = language === 'th' ? RESCUE_RETRY_PROMPT.th : RESCUE_RETRY_PROMPT.en;"), 'rescue retry prompt choice drifted');
});

/* ------------------------------------------------------- evidence marker (CCME R5) */

const MARK = evidenceLineFor('moderate');
const EN_CITED = 'Do an ECG within ten minutes of arrival and measure troponin (ESC ACS, 2023).';

test('evidence marker: the guidance is appended per mode, after artifacts, never on a rescue item', () => {
  assert.equal(buildChatRequest(ITEM_EN_NATURAL, { evidenceMarker: true }).systemPrompt, RIMPL_SYSTEM_PROMPT_NATURAL + EVIDENCE_GUIDANCE.natural);
  assert.equal(buildChatRequest(ITEM_TH_EXAMINER, { evidenceMarker: true, artifacts: true }).systemPrompt,
    RIMPL_SYSTEM_PROMPT_EXAMINER + ARTIFACT_GUIDANCE + EVIDENCE_GUIDANCE.examiner);
  const rescue = buildChatRequest(ITEM_RESCUE, { evidenceMarker: true });
  assert.equal(rescue.systemPrompt, RIMPL_SYSTEM_PROMPT_RESCUE);
  assert.equal(rescue.evidenceMarker, false, 'chat.js never checks the marker on a rescue turn');
  assert.equal(buildChatRequest(ITEM_EN_NATURAL).evidenceMarker, false, 'off by default, as the setting is');
  assert.equal(buildChatRequest(ITEM_EN_NATURAL).systemPrompt, RIMPL_SYSTEM_PROMPT_NATURAL);
});

test('evidence marker: decision, prompt, reason and call size replicate chat.js', () => {
  const base = { socratic: false, rescuing: false, language: 'en', message: 'Chest pain, what next?', evidenceMarker: true };
  const only = retryDecision(EN_CITED, base);
  assert.deepEqual([only.fire, only.needEvidence, only.needCitation, only.languageMismatch], [true, true, false, false]);
  assert.equal(retryReason(only), 'evidence');
  assert.equal(retryPrompt(only, base), EVIDENCE_RETRY_PROMPT.only.en);
  assert.equal(retryPrompt(only, { ...base, language: 'th' }), EVIDENCE_RETRY_PROMPT.only.th);
  assert.equal(retryMaxTokens(only, 4000), EVIDENCE_LINE_MAX_TOKENS, 'the marker-only call is small');
  assert.equal(retryDecision(`${EN_CITED}\n${MARK}`, base).fire, false);
  assert.equal(retryDecision(`${EN_CITED}\nEvidence: low.`, base).fire, false, 'a near-compliant short form is read, not re-asked');
  assert.equal(retryReason(retryDecision(`${EN_CITED}\n${MARK}`, base)), null);
  assert.equal(retryDecision(EN_CITED, { ...base, evidenceMarker: false }).fire, false, 'off: never fires');
  assert.equal(retryDecision(EN_CITED, { ...base, rescuing: true }).needEvidence, false, 'never on a rescue turn');
  // Folded into the other retries as a suffix, at the full ceiling.
  const cit = retryDecision('Do an ECG within ten minutes.', base);
  assert.equal(retryPrompt(cit, base), RETRY_PROMPTS.natural.en + EVIDENCE_RETRY_PROMPT.suffix.en);
  assert.equal(retryMaxTokens(cit, 4000), 4000);
  const th = { ...base, language: 'th', message: TH_MSG };
  const all3 = retryDecision('Do an ECG within ten minutes.', th);
  assert.equal(retryPrompt(all3, th), RETRY_PROMPTS.natural.th + LANGUAGE_SUFFIX + EVIDENCE_RETRY_PROMPT.suffix.th);
  const langEv = retryDecision(EN_CITED, th);
  assert.equal(retryPrompt(langEv, th), LANGUAGE_ONLY_PROMPT + EVIDENCE_RETRY_PROMPT.suffix.th);
  assert.equal(retryMaxTokens(langEv, 4000), 4000);
  // The marker-only call sees the reply with its fence intact when artifacts are on, like a rewrite.
  const fenced = `${EN_CITED}\n:::artifact{type="x" title="t"}\nbody\n:::`;
  assert.match(retryMessages([], fenced, only, { ...base, artifacts: true })[0].content, /:::artifact/);
});

test('evidence marker: evidenceSplice = chat.js splice (one line into the FIRST reply, nothing else)', () => {
  const base = { socratic: false, rescuing: false, language: 'en', message: 'Chest pain, what next?', evidenceMarker: true };
  const only = retryDecision(EN_CITED, base);
  assert.deepEqual(evidenceSplice(only, EN_CITED, 'Evidence: moderate', base), { text: `${EN_CITED}\n\n${MARK}`, level: 'moderate' });
  // A whole rewrite that dropped the artifact cannot get through: only the line is taken.
  const first = `${EN_CITED}\n:::artifact{type="differential" title="DDx"}\n| a | b |\n:::`;
  assert.equal(evidenceSplice(only, first, `Rewritten without the table.\n${MARK}`, base).text, `${first}\n\n${MARK}`);
  assert.equal(evidenceSplice(only, EN_CITED, 'no line here', base), null, 'no line: the first reply stands');
  assert.equal(evidenceSplice(only, EN_CITED, `${MARK}\n${MARK}`, base), null, 'two lines: the first reply stands');
  const ex = { ...base, socratic: true };
  const exOnly = retryDecision(`${EN_CITED}\n❓ What next?`, ex);
  assert.equal(evidenceSplice(exOnly, `${EN_CITED}\n❓ What next?`, MARK, ex).text, `${EN_CITED}\n\n${MARK}\n❓ What next?`);
  // A near-miss in the first reply is removed, so the result holds one evidence statement.
  const nm = retryDecision(`${EN_CITED}\nEvidence level: high`, base);
  assert.equal(retryReason(nm), 'evidence', 'a near-miss is not a level: the check fires');
  assert.equal(evidenceSplice(nm, `${EN_CITED}\nEvidence level: high`, MARK, base).text, `${EN_CITED}\n\n${MARK}`);
  // Never for a citation or language retry: those replies are used whole.
  assert.equal(evidenceSplice(retryDecision('no cite', base), 'no cite', MARK, base), null);
});

test('evidence marker: evidencePlacement = chat.js placeMarker (off, rescue, misplaced, placed)', () => {
  const nat = { evidenceMarker: true, socratic: false };
  const ex = { evidenceMarker: true, socratic: true };
  assert.equal(evidencePlacement(`${MARK}\n${EN_CITED}`, nat), `${EN_CITED}\n\n${MARK}`);
  assert.equal(evidencePlacement(`${EN_CITED}\n❓ What next?\n${MARK}`, ex), `${EN_CITED}\n\n${MARK}\n❓ What next?`);
  assert.equal(evidencePlacement(`${EN_CITED}\nLevel of evidence: high\n${MARK}`, nat), `${EN_CITED}\n\n${MARK}`);
  assert.equal(evidencePlacement(`${EN_CITED}\n${MARK}`, nat), null, 'placed: left as it is');
  assert.equal(evidencePlacement(`${MARK}\n${EN_CITED}`, { ...nat, evidenceMarker: false }), null, 'off: never');
  // A rescue item's request carries evidenceMarker false (buildChatRequest), so a rescue turn is never touched.
  const rescueReq = buildChatRequest(ITEM_RESCUE, { evidenceMarker: true });
  assert.equal(evidencePlacement(`${MARK}\nWhat are you weighing?`, rescueReq), null);
});

test('deadline: optionalRetrySkipped = chat.js retrySkipped (only language/evidence, only past the cutoff)', () => {
  assert.equal(CHAT_OPTIONAL_RETRY_CUTOFF_MS, 50000, 'the default the harness runs with');
  const base = { socratic: false, rescuing: false, language: 'en', message: 'Chest pain, what next?', evidenceMarker: true };
  const ev = retryDecision(EN_CITED, base);
  assert.equal(optionalRetrySkipped(ev, 50001), true);
  assert.equal(optionalRetrySkipped(ev, 50000), false, 'strictly past it');
  const th = { ...base, language: 'th', message: TH_MSG };
  assert.equal(optionalRetrySkipped(retryDecision(`${EN_CITED}\n${MARK}`, th), 60000), true, 'language-only');
  assert.equal(optionalRetrySkipped(retryDecision('Do an ECG within ten minutes.', base), 90000), false, 'a citation retry is required');
  assert.equal(optionalRetrySkipped(retryDecision('Rivaroxaban 20 mg (ROCKET AF, 2011).', { ...base, rescuing: true, socratic: true }), 90000), false, 'a rescue retry is required');
});

test('runItem --evidence-marker: line spliced when given, first reply kept unchanged when not', async () => {
  const calls = [];
  let n = 0;
  const give = async (req) => { calls.push(req); return ++n === 1 ? { ok: true, text: 'Start at eGFR 20 (KDIGO, 2022).', ms: 5 } : { ok: true, text: 'Evidence: moderate', ms: 2 }; };
  const e = await runItem(ITEM_EN_NATURAL, give, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1, evidenceMarker: true });
  assert.equal(n, 2);
  assert.equal(calls[1].maxTokens, EVIDENCE_LINE_MAX_TOKENS);
  assert.equal(e.request.evidence_marker, true);
  assert.match(e.retry.reason, /evidence marker/);
  assert.equal(e.final.text, `Start at eGFR 20 (KDIGO, 2022).\n\n${MARK}`);
  assert.deepEqual([e.final.from, e.evidence_retry, e.evidence_level, e.evidence_moved], ['first + spliced evidence line', true, 'moderate', false]);
  assert.equal(e.retry.text, 'Evidence: moderate', 'the line-only answer is kept for the record');
  assert.equal(e.checks.checks.evidence_marker.pass, true);
  assert.equal(e.checks.checks.evidence_marker_placement.pass, true);
  n = 0;
  const useless = async () => { n += 1; return { ok: true, text: 'Start at eGFR 20 (KDIGO, 2022).', ms: 5 }; };
  const k = await runItem(ITEM_EN_NATURAL, useless, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1, evidenceMarker: true });
  assert.equal(n, 2, 'still at most two calls');
  assert.match(k.final.from, /^first \(the evidence retry gave no single line/);
  assert.equal(k.final.text, 'Start at eGFR 20 (KDIGO, 2022).');
  assert.deepEqual([k.evidence_retry, k.evidence_level], [false, null]);
  assert.equal(k.checks.flags.find((f) => f.code === 'no_evidence_marker')?.severity, 'minor');
  n = 0;
  const failing = async () => (++n === 1 ? { ok: true, text: 'Start at eGFR 20 (KDIGO, 2022).', ms: 5 } : { ok: false, status: 400, error: 'HTTP 400', text: '' });
  const f = await runItem(ITEM_EN_NATURAL, failing, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1, evidenceMarker: true });
  assert.equal(f.final.ok, true, 'a failed evidence-only retry keeps the deliverable first reply');
  assert.match(f.final.from, /evidence retry failed/);
  // Off: no check, no retry, no field.
  n = 0;
  const off = await runItem(ITEM_EN_NATURAL, useless, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.equal(n, 1);
  assert.deepEqual([off.request.evidence_marker, off.evidence_level, off.checks.checks.evidence_marker], [false, null, undefined]);
});

test('runItem --evidence-marker: a misplaced marker is MOVED with no model call (first reply and adopted retry)', async () => {
  let n = 0;
  const misplaced = async () => { n += 1; return { ok: true, text: `${MARK}\nStart at eGFR 20 (KDIGO, 2022).`, ms: 5 }; };
  const m = await runItem(ITEM_EN_NATURAL, misplaced, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1, evidenceMarker: true });
  assert.equal(n, 1, 'no retry: the first reply carries a valid level');
  assert.equal(m.first.text, `${MARK}\nStart at eGFR 20 (KDIGO, 2022).`, 'the first reply is recorded as produced');
  assert.equal(m.final.text, `Start at eGFR 20 (KDIGO, 2022).\n\n${MARK}`);
  assert.deepEqual([m.final.from, m.evidence_moved, m.evidence_retry, m.evidence_level],
    ['first + evidence line moved (no model call)', true, false, 'moderate']);
  assert.equal(m.checks.checks.evidence_marker_placement.pass, true);
  // An adopted citation re-answer with its marker above the prose: moved, and the retry's own text kept.
  n = 0;
  const adopted = async () => (++n === 1 ? { ok: true, text: 'Start at eGFR 20.', ms: 5 } : { ok: true, text: `${MARK}\nStart at eGFR 20 (KDIGO, 2022).`, ms: 5 });
  const a = await runItem(ITEM_EN_NATURAL, adopted, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1, evidenceMarker: true });
  assert.equal(n, 2);
  assert.equal(a.final.text, `Start at eGFR 20 (KDIGO, 2022).\n\n${MARK}`);
  assert.deepEqual([a.final.from, a.evidence_moved, a.evidence_retry], ['retry + evidence line moved (no model call)', true, true]);
  assert.equal(a.retry.text, `${MARK}\nStart at eGFR 20 (KDIGO, 2022).`);
  // Off: the misplaced marker the model wrote anyway is left alone.
  n = 0;
  const off = await runItem(ITEM_EN_NATURAL, misplaced, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.deepEqual([off.final.text, off.evidence_moved], [`${MARK}\nStart at eGFR 20 (KDIGO, 2022).`, false]);
});

test('runItem: an optional retry past the cutoff is skipped and recorded, as chat.js skips it', async () => {
  let n = 0;
  const slowFirst = async () => { n += 1; return { ok: true, text: 'Start at eGFR 20 (KDIGO, 2022).', ms: 60000 }; };
  const e = await runItem(ITEM_EN_NATURAL, slowFirst, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1, evidenceMarker: true });
  assert.equal(n, 1, 'no second call');
  assert.deepEqual(e.retry_skipped, { reason: 'evidence', elapsed_ms: 60000 });
  assert.equal(e.retry, null);
  assert.match(e.final.from, /evidence retry skipped/);
  // A required (citation) retry is never skipped.
  n = 0;
  const slowNoCite = async () => (++n === 1 ? { ok: true, text: 'Start at eGFR 20.', ms: 60000 } : { ok: true, text: 'Start at eGFR 20 (KDIGO, 2022).', ms: 5 });
  const c = await runItem(ITEM_EN_NATURAL, slowNoCite, { maxTokens: 4000, retry: true, artifacts: false, attempts: 1 });
  assert.equal(n, 2);
  assert.equal(c.retry_skipped, null);
});

test('CLI: --dry-run --evidence-marker shows the guidance on, and a different prompt version', () => {
  const plain = run(['--dry-run', '--ids', 'th-cardio-stemi']);
  const marked = run(['--dry-run', '--ids', 'th-cardio-stemi', '--evidence-marker']);
  assert.equal(marked.status, 0, marked.stderr);
  assert.match(marked.stdout, /evidence marker on/);
  assert.match(marked.stdout, /\+ EVIDENCE_GUIDANCE/);
  assert.match(marked.stdout, /0 requests sent/);
  const label = (out) => out.match(/chat-prompt-[0-9a-f]{8}/)?.[0];
  assert.notEqual(label(marked.stdout), label(plain.stdout));
});
