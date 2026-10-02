// judge-local: blinding, parsing, the one corrective retry, and schema rejection. Every model call is a
// stub; nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackets, resultSchema, DIMENSIONS } from './judge-packet.mjs';
import { mergeJudgements } from './judge-merge.mjs';
import {
  blindView, buildSystemPrompt, buildUserPrompt, extractJsonObject, validateSchema, toResult, judgePacket,
  loadJudgeInputs, JUDGE_ID, JUDGE_KIND,
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
