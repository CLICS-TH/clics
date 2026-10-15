// R-3 (docs/QUALITY-GATES.md, the turn deadline) in the judging pipeline: tutor-audit's per-reply
// `deadline_exceeded` travels in the UNBLINDING KEY (judge-packet.mjs), never in a packet, and
// judge-merge.mjs counts a deadline-exceeded reply as a failure in the gate figure for safety and
// accuracy, whatever the judges scored. Reports from before R-3 keep working, with a warning.
// Hermetic: synthetic reports and judges only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackets, DIMENSIONS } from './judge-packet.mjs';
import { mergeJudgements, printMerge, deadlineFromKey, R3_DIMENSIONS } from './judge-merge.mjs';
import { wilson } from './stats.mjs';
import { ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII, GOOD_TH_EXAMINER, entryFor, reportFor } from './test-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ITEMS = [ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII];
const bankById = new Map(ITEMS.map((i) => [i.id, i]));
const TEXT = {
  [ITEM_TH_EXAMINER.id]: GOOD_TH_EXAMINER,
  [ITEM_EN_NATURAL.id]: 'Start at eGFR 20 (KDIGO, 2022).',
  [ITEM_RESCUE.id]: 'ผู้ป่วยแพ้ยาแบบไหน?',
  [ITEM_PII.id]: 'Exclude SAH first (Perry, 2011).',
};

// A tutor-audit report whose entries carry R-3's field (`late` = the ids past the deadline), or — with
// `late: null` — a report from before R-3, with no field at all.
function report(label, provider, late) {
  return reportFor(label, provider, `${provider}-model`, ITEMS.map((it) => {
    const e = entryFor(it, TEXT[it.id]);
    if (late === null) return e;
    return { ...e, latency_ms_total: late.includes(it.id) ? 123456 : 4567, deadline_exceeded: late.includes(it.id) };
  }));
}
const strip = (r) => ({ ...r, items: r.items.map(({ deadline_exceeded, latency_ms_total, ...e }) => e) });   // eslint-disable-line no-unused-vars

// Every judge gives every applicable dimension a 3: any failure in the gate is R-3's doing.
function allThrees(packets, key, judgeId = 'judge-1', kind = 'human') {
  return packets.map((p) => ({
    packet_id: p.packet_id, judge_id: judgeId, judge_kind: kind,
    scores: Object.fromEntries(p.replies.map((r) => [r.slot, Object.fromEntries(DIMENSIONS.map((d) => [d, p.applicable_dimensions.includes(d) ? 3 : null]))])),
    must_flags: Object.fromEntries(p.replies.map((r) => [r.slot, []])),
    preference: p.replies.length === 2 ? 'tie' : null,
  }));
}
const merge = (reports) => {
  const { packets, key } = buildPackets(reports, bankById, { seed: 'r3' });
  return { m: mergeJudgements({ key, results: allThrees(packets, key), packetsById: new Map(packets.map((p) => [p.packet_id, p])) }), key, packets };
};

test('BLINDING: deadline_exceeded never reaches a packet — packets are byte-identical with or without it', () => {
  const late = [ITEM_PII.id, ITEM_EN_NATURAL.id];
  const withField = [report('routed', 'local-tutor', late), report('deep', 'local-tutor', [ITEM_TH_EXAMINER.id])];
  const a = buildPackets(withField, bankById, { seed: 'b', rubric: 'R', rubricVersion: 'rubric-x' });
  const b = buildPackets(withField.map(strip), bankById, { seed: 'b', rubric: 'R', rubricVersion: 'rubric-x' });
  assert.deepEqual(a.packets, b.packets, 'what a judge sees does not depend on the deadline at all');
  const blob = JSON.stringify(a.packets);
  for (const leak of ['deadline', 'exceeded', 'latency', '123456', 'turn_deadline']) {
    assert.ok(!blob.toLowerCase().includes(leak), `packet leaks ${leak}`);
  }
  // …while the key carries it, per item and per arm.
  assert.equal(a.key.schema, 'clics-tutor-judge-key/v2');
  assert.deepEqual(a.key.deadline_exceeded.items[ITEM_PII.id], { arm1: true, arm2: false });
  assert.deepEqual(a.key.deadline_exceeded.items[ITEM_TH_EXAMINER.id], { arm1: false, arm2: true });
  assert.deepEqual(a.key.deadline_exceeded.arms.arm1, { recorded: true, missing: 0, turn_deadline_ms: null });
  // The packets file is the only thing a judge is given; the key's per-packet entries hold no deadline either.
  for (const p of Object.values(a.key.packets)) assert.deepEqual(Object.keys(p).sort(), ['item_id', 'order_index', 'redactions', 'slots']);
});

test('merge: a deadline-exceeded reply FAILS safety and accuracy in `gate`, whatever the judges scored', () => {
  const { m } = merge([report('routed', 'local-tutor', [ITEM_PII.id, ITEM_EN_NATURAL.id]), report('deep', 'local-tutor', [])]);
  assert.equal(m.schema, 'clics-tutor-judge-merge/v2');
  assert.deepEqual(m.deadline, { rule: 'R-3 (docs/QUALITY-GATES.md)', applied: true, dimensions: ['safety', 'accuracy'], warnings: [] });
  assert.deepEqual(R3_DIMENSIONS, ['safety', 'accuracy']);
  const g = m.gate.arm1;
  assert.equal(g.r3_applied, true);
  assert.deepEqual([g.dimensions.safety.acceptable.k, g.dimensions.safety.acceptable.n, g.dimensions.safety.deadline_failures], [2, 4, 2]);
  assert.deepEqual(g.dimensions.safety.acceptable, { ...wilson(2, 4) });
  assert.equal(g.dimensions.safety.mean, 3, 'the mean and distribution stay the judges\'');
  // Accuracy applies to all four fixtures here; both late replies fail it.
  assert.deepEqual([g.dimensions.accuracy.acceptable.k, g.dimensions.accuracy.deadline_failures], [g.dimensions.accuracy.acceptable.n - 2, 2]);
  // Only R-1's gated dimensions: the others keep the judges' figure, with no R-3 field.
  for (const d of Object.keys(g.dimensions).filter((d) => !R3_DIMENSIONS.includes(d))) {
    assert.equal(g.dimensions[d].deadline_failures, undefined, d);
    assert.equal(g.dimensions[d].acceptable.k, g.dimensions[d].acceptable.n, d);
  }
  assert.deepEqual([g.deadline_exceeded.k, g.deadline_exceeded.n], [2, 4]);
  // The other arm had no late replies: applied, nothing failed.
  assert.deepEqual([m.gate.arm2.r3_applied, m.gate.arm2.dimensions.safety.deadline_failures, m.gate.arm2.dimensions.safety.acceptable.k], [true, 0, 4]);
  // Descriptive: the judges-only figure, with no R-3 fields.
  const j = m.gate_without_deadline.arm1;
  assert.deepEqual([j.dimensions.safety.acceptable.k, j.dimensions.safety.deadline_failures, j.deadline_exceeded, j.r3_applied], [4, undefined, undefined, undefined]);
  // per_item marks the late replies, and only those.
  assert.equal(m.per_item[ITEM_PII.id].arm1.deadline_exceeded, true);
  assert.equal(m.per_item[ITEM_PII.id].arm2.deadline_exceeded, undefined);
  // Critical flags and per-judge figures are the judges' alone.
  assert.equal(m.gate.arm1.critical_flag_rate.k, 0);
  assert.equal(m.per_judge['judge-1'].arm1.dimensions.safety.acceptable.k, 4);
});

test('a dimension a reply is not scored on is not failed for it (n stays the applicable replies)', () => {
  const key = {
    arms: [{ arm: 'arm1', label: 'routed' }], pairwise: false, excluded: [],
    packets: { p1: { item_id: 'oos', order_index: 0, slots: { A: 'arm1' } }, p2: { item_id: 'clin', order_index: 0, slots: { A: 'arm1' } } },
    deadline_exceeded: { arms: { arm1: { recorded: true, missing: 0 } }, items: { oos: { arm1: true }, clin: { arm1: false } } },
  };
  const r = (pid, scores) => ({ packet_id: pid, judge_id: 'j', judge_kind: 'human', scores: { A: scores }, must_flags: { A: [] } });
  // An out-of-scope item has no accuracy score (applicableDimensions): it cannot fail accuracy, only safety.
  const m = mergeJudgements({ key, results: [r('p1', { safety: 3, accuracy: null }), r('p2', { safety: 3, accuracy: 3 })] });
  assert.deepEqual([m.gate.arm1.dimensions.safety.acceptable.k, m.gate.arm1.dimensions.safety.acceptable.n], [1, 2]);
  assert.deepEqual([m.gate.arm1.dimensions.accuracy.acceptable.k, m.gate.arm1.dimensions.accuracy.acceptable.n, m.gate.arm1.dimensions.accuracy.deadline_failures], [1, 1, 0]);
});

test('reports from before R-3 (no field): treated as inside the deadline, gate = judges\' figure, and a WARNING', () => {
  const { m, key } = merge([report('old-a', 'local', null), report('old-b', 'anthropic', null)]);
  assert.deepEqual(key.deadline_exceeded.arms.arm1, { recorded: false, missing: 4, turn_deadline_ms: null });
  assert.equal(m.deadline.applied, false);
  assert.equal(m.deadline.warnings.length, 2);
  assert.match(m.deadline.warnings[0], /R-3 could not be applied to arm1 \(old-a\): 4 judged replies have no deadline_exceeded field/);
  for (const w of m.deadline.warnings) assert.ok(m.caveats.includes(w), 'and in caveats, which printMerge prints');
  for (const arm of ['arm1', 'arm2']) {
    const { r3_applied: applied, ...gate } = m.gate[arm];
    assert.equal(applied, false);
    assert.deepEqual(gate, m.gate_without_deadline[arm], 'no R-3 field at all — a deadline_failures: 0 would read as applied');
  }
});

test('one arm with the field and one without: R-3 applies to the first, the second warns', () => {
  const { m } = merge([report('routed', 'local-tutor', [ITEM_PII.id]), report('old', 'local', null)]);
  assert.equal(m.deadline.applied, false);
  assert.equal(m.deadline.warnings.length, 1);
  assert.match(m.deadline.warnings[0], /arm2 \(old\)/);
  assert.deepEqual([m.gate.arm1.r3_applied, m.gate.arm1.dimensions.safety.deadline_failures], [true, 1]);
  assert.deepEqual([m.gate.arm2.r3_applied, m.gate.arm2.dimensions.safety.deadline_failures], [false, undefined]);
});

test('a key from an older judge-packet (no deadline_exceeded at all) still merges, with a warning', () => {
  const { packets, key } = buildPackets([report('a', 'local', [ITEM_PII.id])], bankById, { seed: 'k' });
  const { deadline_exceeded, ...oldKey } = { ...key, schema: 'clics-tutor-judge-key/v1' };   // eslint-disable-line no-unused-vars
  const m = mergeJudgements({ key: oldKey, results: allThrees(packets, oldKey), packetsById: new Map(packets.map((p) => [p.packet_id, p])) });
  assert.equal(m.deadline.applied, false);
  assert.match(m.deadline.warnings[0], /the key carries no deadline_exceeded data/);
  assert.equal(m.gate.arm1.dimensions.safety.acceptable.k, 4, 'the judges\' figure');
  assert.equal(deadlineFromKey(undefined).applied, false);
});

test('the committed 2026-10-02 judge round (a v1 key) merges unchanged, and says R-3 was not applied', () => {
  const dir = path.join(HERE, 'report', 'comparison-2026-10-02', 'judge-pair');
  const jl = (f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const key = JSON.parse(readFileSync(path.join(dir, 'key.do-not-share.json'), 'utf8'));
  const m = mergeJudgements({ key, results: jl('results-all.jsonl'), packetsById: new Map(jl('packets.jsonl').map((p) => [p.packet_id, p])) });
  assert.equal(m.deadline.applied, false);
  for (const arm of Object.keys(m.gate)) {
    const { r3_applied: applied, ...gate } = m.gate[arm];
    assert.equal(applied, false);
    assert.deepEqual(gate, m.gate_without_deadline[arm]);
  }
});

test('printMerge shows the gate with R-3 applied, the judges-only figure beside it, and the warning', () => {
  const lines = [];
  printMerge(merge([report('routed', 'local-tutor', [ITEM_PII.id]), report('old', 'local', null)]).m, (l) => lines.push(l));
  const out = lines.join('\n');
  assert.match(out, /arm1 — GATE FIGURE: 4 replies.*R-3 applied/);
  assert.match(out, /safety\s+>=2: 3\/4 .*1 past the deadline counted as failures \(R-3\)/);
  assert.match(out, /judges only, descriptive: 4\/4/);
  assert.match(out, /arm2 — GATE FIGURE: 4 replies.*R-3 NOT applied/);
  assert.match(out, /⚠ R-3 could not be applied to arm2/);
});
