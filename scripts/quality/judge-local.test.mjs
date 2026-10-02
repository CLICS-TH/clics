// judge-local: blinding, parsing, the one corrective retry, and schema rejection. Every model call is a
// stub; nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackets, resultSchema, DIMENSIONS } from './judge-packet.mjs';
import { mergeJudgements } from './judge-merge.mjs';
import {
  blindView, buildSystemPrompt, buildUserPrompt, extractJsonObject, validateSchema, toResult, judgePacket,
  loadJudgeInputs, JUDGE_ID, JUDGE_KIND, resumeConflicts, systemPromptSha,
} from './judge-local.mjs';
import { ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII, GOOD_TH_EXAMINER, entryFor, reportFor } from './test-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ITEMS = [ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII];
const bankById = new Map(ITEMS.map((i) => [i.id, i]));
const replies = {
  [ITEM_TH_EXAMINER.id]: [GOOD_TH_EXAMINER, 'ทำ ECG (ESC, 2023)\n❓ ต่อไปทำอะไร'],
  [ITEM_EN_NATURAL.id]: ['Start at eGFR 20 (KDIGO, 2022).', 'Start at eGFR 25 (KDIGO, 2022).'],
  [ITEM_RESCUE.id]: ['คุณกำลังชั่งน้ำหนักอะไรอยู่?', 'ผู้ป่วยแพ้ยาแบบไหน?'],
  [ITEM_PII.id]: ['Exclude SAH (Perry, 2011).', 'Exclude SAH first (Perry, 2011).'],
};
const CLOUD = reportFor('anthropic-claude-sonnet-4-6-x', 'anthropic', 'claude-sonnet-4-6', ITEMS.map((it) => entryFor(it, replies[it.id][0])));
const LOCAL = reportFor('local-deepseek-x', 'local', 'deepseek-v4-flash', ITEMS.map((it) => entryFor(it, replies[it.id][1])));
const RUBRIC = '# Rubric\nRUBRIC-BODY-SENTINEL: 3 = correct, 2 = minor, 1 = major, 0 = wrong.';
const { packets, key } = buildPackets([CLOUD, LOCAL], bankById, { seed: 't', rubric: RUBRIC, rubricVersion: 'rubric-t' });
const single = buildPackets([LOCAL], bankById, { seed: 't', rubric: null, rubricVersion: 'rubric-t' });
const schema = resultSchema();
const system = buildSystemPrompt({ instructions: '# Judge instructions\nJudge against key_facts.', rubric: RUBRIC, schema });

/** A model reply that is a valid answer for this packet. */
function validAnswer(p, over = {}) {
  const slots = p.replies.map((r) => r.slot);
  const s = Object.fromEntries(DIMENSIONS.map((d) => [d, p.applicable_dimensions.includes(d) ? 2 : null]));
  return JSON.stringify({
    scores: Object.fromEntries(slots.map((x) => [x, { ...s }])),
    must_flags: Object.fromEntries(slots.map((x) => [x, []])),
    preference: slots.length === 2 ? 'A' : null,
    rationale: 'Both cover the key facts.',
    ...over,
  });
}
const ok = (text) => ({ ok: true, text, ms: 5, finishReason: 'stop', promptTokens: 100, completionTokens: 50, model: 'local-x' });

test('BLINDING: the prompt carries no arm, model, label or key — whatever extra fields a packet holds', () => {
  const p = { ...packets[0], slots: { A: 'arm1', B: 'arm2' }, arm: 'arm2', label: CLOUD.label, model: 'claude-sonnet-4-6', key: key.packets };
  const view = blindView(p);
  assert.deepEqual(Object.keys(view), ['item', 'replies', 'applicable_dimensions', 'must_flag_codes']);
  const user = buildUserPrompt(p);
  for (const leak of ['arm1', 'arm2', CLOUD.label, LOCAL.label, 'claude-sonnet', 'deepseek-v4', 'anthropic', 'order_index', 'redactions', p.packet_id]) {
    assert.ok(!user.toLowerCase().includes(leak.toLowerCase()), `user prompt leaks ${leak}`);
    assert.ok(!system.toLowerCase().includes(leak.toLowerCase()), `system prompt leaks ${leak}`);
  }
  assert.ok(!user.includes('RUBRIC-BODY-SENTINEL'), 'the packet\'s embedded rubric is dropped from the user prompt');
  assert.equal(system.split('RUBRIC-BODY-SENTINEL').length - 1, 1, 'the rubric is in the system prompt exactly once');
});

test('extractJsonObject: fences, <think>, prose around it, braces inside strings; nothing parseable is an error', () => {
  const obj = { a: 1, s: 'brace } and { inside' };
  for (const t of ['```json\n' + JSON.stringify(obj) + '\n```', `<think>maybe {"a":2}</think>${JSON.stringify(obj)}`, `Here you go:\n${JSON.stringify(obj)}\nDone.`]) {
    assert.deepEqual(extractJsonObject(t), { ok: true, value: obj }, t);
  }
  assert.equal(extractJsonObject('scores: A=2').ok, false);
  assert.equal(extractJsonObject('{"a": 1,').ok, false);
});

test('a valid first reply becomes a result line that judge-merge accepts, for every packet', async () => {
  const results = [];
  for (const p of packets) {
    const { result, log } = await judgePacket(p, async () => ok(validAnswer(p)), { system, schema });
    assert.equal(log.status, 'valid');
    assert.deepEqual([result.judge_id, result.judge_kind, result.packet_id], [JUDGE_ID, JUDGE_KIND, p.packet_id]);
    results.push(result);
  }
  const merged = mergeJudgements({ key, results, packetsById: new Map(packets.map((p) => [p.packet_id, p])) });
  assert.deepEqual(merged.judges, [{ id: 'judge-local', kind: 'local-model' }]);
  // Single-reply packets: preference null, and merge accepts them too.
  const sp = single.packets[0];
  const { result } = await judgePacket(sp, async () => ok(validAnswer(sp)), { system, schema });
  assert.equal(result.preference, null);
  mergeJudgements({ key: single.key, results: [result], packetsById: new Map([[sp.packet_id, sp]]) });
});

test('invalid JSON → exactly ONE corrective retry, recorded; the conversation shows the model its own answer', async () => {
  const p = packets[0];
  const calls = [];
  const complete = async (req) => { calls.push(req); return ok(calls.length === 1 ? 'I think A is better.' : validAnswer(p)); };
  const { result, log } = await judgePacket(p, complete, { system, schema });
  assert.equal(calls.length, 2);
  assert.equal(log.status, 'valid-after-retry');
  assert.match(log.retry.reason, /no parseable JSON/);
  assert.deepEqual(log.attempts.map((a) => a.parsed), [false, true]);
  assert.equal(log.attempts[0].text, 'I think A is better.', 'the unusable reply is kept in the run log');
  assert.deepEqual(calls[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(calls[1].messages[1].content, 'I think A is better.');
  assert.match(calls[1].messages[2].content, /could not be used/);
  assert.ok(result);
  assert.equal(calls[0].temperature, 0);
});

test('still invalid after the retry → no result line, status invalid, and no third call', async () => {
  let n = 0;
  const { result, log } = await judgePacket(packets[0], async () => { n += 1; return ok('{"scores": '); }, { system, schema });
  assert.equal(n, 2);
  assert.equal(result, null);
  assert.equal(log.status, 'invalid');
});

test('schema rejection: out-of-range, not-applicable, unknown flag, unknown dimension, missing preference', async () => {
  const p = packets.find((x) => x.applicable_dimensions.length < DIMENSIONS.length);
  const na = DIMENSIONS.find((d) => !p.applicable_dimensions.includes(d));
  const app = p.applicable_dimensions[0];
  const base = JSON.parse(validAnswer(p));
  const cases = [
    [{ ...base, scores: { ...base.scores, A: { ...base.scores.A, [app]: 5 } } }, /<= 3|0-3/],
    [{ ...base, scores: { ...base.scores, A: { ...base.scores.A, [na]: 2 } } }, /must be null/],
    [{ ...base, must_flags: { A: ['MADE_UP_FLAG'], B: [] } }, /MADE_UP_FLAG|must be one of/],
    [{ ...base, scores: { ...base.scores, A: { ...base.scores.A, empathy: 3 } } }, /empathy/],
    [{ ...base, preference: undefined }, /preference/],
    [{ ...base, rationale: 42 }, /rationale must be string/],
  ];
  for (const [obj, re] of cases) {
    const { errors } = toResult(obj, p, { schema });
    assert.ok(errors.some((e) => re.test(e)), `${re} not in ${JSON.stringify(errors)}`);
  }
  // A key the model invents at top level is dropped, not fatal; the runner's own fields always win.
  const extra = toResult({ ...base, judge_id: 'deepseek', confidence: 'high' }, p, { schema });
  assert.deepEqual(extra.errors, []);
  assert.equal(extra.rec.judge_id, 'judge-local');
  assert.ok(!('confidence' in extra.rec));
  // validateSchema on its own: additionalProperties, type, enum, const.
  assert.match(validateSchema({ packet_id: 'x', judge_id: 'j', judge_kind: 'robot', scores: {}, must_flags: {}, extra: 1 }, schema).join('\n'), /judge_kind must be one of[\s\S]*extra is not allowed/);
  assert.match(validateSchema({ schema: 'other' }, schema).join('\n'), /schema must be/);
});

test('a truncated or reasoning-only reply is retried; a transport failure is not retried (use --resume)', async () => {
  const p = packets[0];
  let n = 0;
  const trunc = async () => (++n === 1 ? { ...ok(validAnswer(p)), finishReason: 'length' } : ok(validAnswer(p)));
  assert.equal((await judgePacket(p, trunc, { system, schema })).log.status, 'valid-after-retry');
  n = 0;
  const thinking = async () => (++n === 1 ? { ...ok(''), reasoningOnly: true } : ok(validAnswer(p)));
  assert.equal((await judgePacket(p, thinking, { system, schema })).log.status, 'valid-after-retry');
  n = 0;
  const down = async () => { n += 1; return { ok: false, status: 503, error: 'HTTP 503', text: '' }; };
  const r = await judgePacket(p, down, { system, schema });
  assert.deepEqual([n, r.log.status, r.result], [1, 'transport-error', null]);
});

test('runner inputs: reads the four judge-facing files only; CLI dry run sends nothing and writes nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'judge-local-'));
  writeFileSync(path.join(dir, 'packets.jsonl'), packets.map((p) => JSON.stringify(p)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'rubric.md'), RUBRIC);
  writeFileSync(path.join(dir, 'results.schema.json'), JSON.stringify(schema));
  writeFileSync(path.join(dir, 'JUDGE-INSTRUCTIONS.md'), '# Judge instructions\n');
  writeFileSync(path.join(dir, 'key.do-not-share.json'), JSON.stringify({ ...key, SENTINEL: 'KEY-FILE-SENTINEL' }));
  const inputs = await loadJudgeInputs(dir);
  assert.deepEqual(Object.keys(inputs).sort(), ['instructions', 'packets', 'rubric', 'schema']);
  const sent = [];
  const sys = buildSystemPrompt(inputs);
  for (const p of inputs.packets) await judgePacket(p, async (req) => { sent.push(req); return ok(validAnswer(p)); }, { system: sys, schema: inputs.schema });
  assert.ok(!JSON.stringify(sent).includes('KEY-FILE-SENTINEL'));
  assert.ok(!JSON.stringify(sent).includes('arm1'));

  const before = readdirSync(dir).sort();
  const env = { PATH: process.env.PATH };   // no LOCAL_AI_*: a dry run needs no endpoint
  const r = spawnSync(process.execPath, [path.join(HERE, 'judge-local.mjs'), dir, '--dry-run', '--limit', '3'], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 packet\(s\)/);
  assert.deepEqual(readdirSync(dir).sort(), before, 'a dry run writes nothing');
  const k = spawnSync(process.execPath, [path.join(HERE, 'judge-local.mjs'), path.join(dir, 'key.do-not-share.json')], { encoding: 'utf8', env, timeout: 30000 });
  assert.notEqual(k.status, 0);
  assert.match(k.stderr, /never see key\.do-not-share\.json/);
  const live = spawnSync(process.execPath, [path.join(HERE, 'judge-local.mjs'), dir, '--limit', '1'], { encoding: 'utf8', env, timeout: 30000 });
  assert.notEqual(live.status, 0, 'without LOCAL_AI_BASE_URL it refuses before sending anything');
  assert.match(live.stderr, /LOCAL_AI_BASE_URL/);
});

test('a draft verdict inside the reasoning is never picked: everything up to the LAST </think> is dropped', () => {
  // The review case: no opening tag, a draft object, then the closing tag and the real answer.
  assert.deepEqual(extractJsonObject('Draft {"preference":"A"} … </think> {"preference":"B"}'), { ok: true, value: { preference: 'B' } });
  assert.deepEqual(extractJsonObject('<think>{"v":1}</think> x <think>{"v":2}</think>\n{"v":3}'), { ok: true, value: { v: 3 } });
  // Reasoning cut off mid-way (unclosed <think>): what follows it is not an answer.
  assert.deepEqual(extractJsonObject('{"v":1}\n<think>maybe {"v":2}'), { ok: true, value: { v: 1 } });
  assert.equal(extractJsonObject('<think>only a draft {"v":2}').ok, false);
});

test('--resume refuses when the earlier run used another model or system prompt; a matching v1 meta resumes', () => {
  assert.deepEqual(resumeConflicts({ model_requested: 'm', system_prompt_sha: 'abc' }, { model_requested: 'm', system_prompt_sha: 'abc' }), []);
  assert.equal(resumeConflicts({ model_requested: 'm1', system_prompt_sha: 'abc' }, { model_requested: 'm2', system_prompt_sha: 'abc' }).length, 1);
  assert.match(resumeConflicts({ system_prompt_sha: 'abc' }, { model_requested: 'm', system_prompt_sha: 'def' })[0], /system_prompt_sha/);
  assert.deepEqual(resumeConflicts({}, { model_requested: 'm', system_prompt_sha: 'x' }), [], 'fields the earlier meta lacks are not compared');

  const dir = mkdtempSync(path.join(tmpdir(), 'judge-local-resume-'));
  writeFileSync(path.join(dir, 'packets.jsonl'), packets.map((p) => JSON.stringify(p)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'rubric.md'), RUBRIC);
  writeFileSync(path.join(dir, 'results.schema.json'), JSON.stringify(schema));
  writeFileSync(path.join(dir, 'JUDGE-INSTRUCTIONS.md'), '# Judge instructions\n');
  const out = path.join(dir, 'results-local.jsonl');
  writeFileSync(out, JSON.stringify({ packet_id: packets[0].packet_id }) + '\n');
  const sha = systemPromptSha(buildSystemPrompt({ instructions: '# Judge instructions\n', rubric: RUBRIC, schema }));
  // The v1 meta exactly as a finished run writes it (the format of the run in progress on the box).
  const v1 = (model, sysSha) => JSON.stringify({
    schema: 'clics-tutor-judge-local-run/v1', started_at: '2026-10-02T06:48:05.538Z', judge_id: 'judge-local', judge_kind: 'local-model',
    model_requested: model, endpoint: 'LOCAL_AI_BASE_URL (not recorded)', system_prompt_sha: sysSha, rubric_version: 'rubric-t',
    max_tokens: 4000, temperature: 0, concurrency: 2, finished_at: '2026-10-02T06:49:01.937Z', models_reported: [model],
    counts: { valid: 1, 'valid-after-retry': 0, invalid: 0, 'transport-error': 0 },
  });
  // --limit 0: even if the guard failed, no packet would be sent. The URL is a closed loopback port.
  const env = { PATH: process.env.PATH, LOCAL_AI_BASE_URL: 'http://127.0.0.1:9/v1', LOCAL_AI_MODEL: 'model-now' };
  const resume = () => spawnSync(process.execPath, [path.join(HERE, 'judge-local.mjs'), dir, '--resume', '--limit', '0'], { encoding: 'utf8', env, timeout: 30000 });

  writeFileSync(`${out}.meta.json`, v1('model-before', sha));
  const m = resume();
  assert.notEqual(m.status, 0);
  assert.match(m.stderr, /--resume refused[\s\S]*model_requested: earlier run "model-before", this run "model-now"/);

  writeFileSync(`${out}.meta.json`, v1('model-now', 'aaaaaaaaaaaa'));
  const p = resume();
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /system_prompt_sha/);

  writeFileSync(`${out}.meta.json`, v1('model-now', sha));
  const okRun = resume();
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.equal(JSON.parse(readFileSync(`${out}.meta.json`, 'utf8')).system_prompt_sha, sha);
});
