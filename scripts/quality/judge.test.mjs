// Judging pipeline: blinding, seeded order, result validation, and the agreement math.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPackets, applicableDimensions, redactModelNames, resultSchema, DIMENSIONS } from './judge-packet.mjs';
import { mergeJudgements, validateResult } from './judge-merge.mjs';
import { wilson, cohenKappa, rng, shuffle } from './stats.mjs';
import { ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII, GOOD_TH_EXAMINER, entryFor, reportFor } from './test-fixtures.mjs';

const ITEMS = [ITEM_TH_EXAMINER, ITEM_EN_NATURAL, ITEM_RESCUE, ITEM_PII];
const bankById = new Map(ITEMS.map((i) => [i.id, i]));
const LOCAL_MODEL = 'deepseek-v3.1-local-awq';
const CLOUD_MODEL = 'claude-sonnet-4-6';
const replies = {
  [ITEM_TH_EXAMINER.id]: [GOOD_TH_EXAMINER, 'ตอบโดย DeepSeek: ทำ ECG (ESC, 2023)\n❓ ต่อไปทำอะไร'],
  [ITEM_EN_NATURAL.id]: ['As Claude, I would start at eGFR 20 (KDIGO, 2022).', 'Start at eGFR 20 (KDIGO, 2022).'],
  [ITEM_RESCUE.id]: ['คุณกำลังชั่งน้ำหนักอะไรอยู่?', 'ผู้ป่วยแพ้ยาแบบไหน?'],
  [ITEM_PII.id]: ['Exclude SAH (Perry, 2011).', 'Exclude SAH first (Perry, 2011).'],
};
const reportA = reportFor('anthropic-claude-sonnet-4-6-20261002T000000Z', 'anthropic', CLOUD_MODEL, ITEMS.map((it) => entryFor(it, replies[it.id][0])));
const reportB = reportFor('local-deepseek-v3.1-local-awq-20261002T000000Z', 'local', LOCAL_MODEL, ITEMS.map((it) => entryFor(it, replies[it.id][1])));

test('wilson: known values, and empty is "no data", not 0%', () => {
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.lo - 0.4902) < 1e-3 && Math.abs(w.hi - 0.9433) < 1e-3, JSON.stringify(w));
  assert.ok(Math.abs(wilson(0, 80).hi - 0.0458) < 1e-3, 'zero of 80 still allows ~4.6%');
  assert.deepEqual([wilson(5, 5).hi, wilson(0, 5).lo], [1, 0]);
  assert.equal(wilson(0, 0).p, null);
  assert.throws(() => wilson(3, 2));
});

test('cohenKappa: textbook 2x2, perfect, chance-level, undefined, and quadratic weighting', () => {
  // 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no → po 0.70, pe 0.50 → κ 0.40
  const pairs = [...Array(20).fill([1, 1]), ...Array(5).fill([1, 0]), ...Array(10).fill([0, 1]), ...Array(15).fill([0, 0])];
  const k = cohenKappa(pairs);
  assert.ok(Math.abs(k.po - 0.7) < 1e-12 && Math.abs(k.pe - 0.5) < 1e-12 && Math.abs(k.kappa - 0.4) < 1e-12);
  assert.equal(cohenKappa([[0, 0], [1, 1], [2, 2], [3, 3]], { categories: [0, 1, 2, 3] }).kappa, 1);
  assert.equal(cohenKappa([[2, 2], [2, 2]], { categories: [0, 1, 2, 3] }).kappa, null, 'one shared category: kappa undefined');
  // Quadratic: off-by-one disagreements are penalised far less than 0-vs-3 ones.
  const near = [[0, 1], [1, 2], [2, 3], [3, 3], [0, 0], [1, 1]];
  const far = [[0, 3], [1, 2], [2, 1], [3, 0], [0, 0], [1, 1]];
  const kn = cohenKappa(near, { weights: 'quadratic', categories: [0, 1, 2, 3] }).kappa;
  const kf = cohenKappa(far, { weights: 'quadratic', categories: [0, 1, 2, 3] }).kappa;
  assert.ok(kn > 0.6, `near ${kn}`);
  assert.ok(kf < 0, `far ${kf}`);
  // Hand-computed: pairs (0,0),(0,1),(1,1),(1,1) on cats [0,1], quadratic == unweighted for 2 cats.
  const two = cohenKappa([[0, 0], [0, 1], [1, 1], [1, 1]], { weights: 'quadratic', categories: [0, 1] });
  assert.ok(Math.abs(two.kappa - 0.5) < 1e-12, `${two.kappa}`); // po .75, pe .5*.25+.5*.75=.5 → .5
});

test('seeded shuffle is deterministic and order-free per seed', () => {
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], rng('s')), shuffle([1, 2, 3, 4, 5], rng('s')));
});

test('BLINDING: no arm, provider, model, label, prompt or timing reaches a packet', () => {
  const { packets, key } = buildPackets([reportA, reportB], bankById, { seed: 's1', rubric: 'RUBRIC TEXT', rubricVersion: 'rubric-x' });
  const blob = JSON.stringify(packets);
  for (const leak of [CLOUD_MODEL, LOCAL_MODEL, reportA.label, reportB.label, 'anthropic', '"local"', 'arm1', 'arm2',
    'chat-prompt', 'latency', 'completion_tokens', 'finish_reason', 'response_model', 'provider', 'DeepSeek', 'Claude', 'model-x']) {
    assert.ok(!blob.toLowerCase().includes(leak.toLowerCase()), `packet leaks ${leak}`);
  }
  assert.match(blob, /\[model\]/, 'self-identification in reply text is redacted, not dropped');
  // ...while the key holds everything needed to unblind.
  assert.equal(key.arms[0].model, CLOUD_MODEL);
  assert.ok(Object.values(key.packets).every((p) => p.slots.A && p.slots.B && p.slots.A !== p.slots.B));
});

test('pairwise: both orders per item, opposite; seeded and stable under --ids narrowing', () => {
  const a = buildPackets([reportA, reportB], bankById, { seed: 's1' });
  assert.equal(a.packets.length, ITEMS.length * 2);
  for (const it of ITEMS) {
    const ps = Object.values(a.key.packets).filter((p) => p.item_id === it.id);
    assert.equal(ps.length, 2);
    assert.equal(ps[0].slots.A, ps[1].slots.B);
  }
  const again = buildPackets([reportA, reportB], bankById, { seed: 's1' });
  assert.deepEqual(again.key.packets, a.key.packets);
  const narrowed = buildPackets([reportA, reportB], bankById, { seed: 's1', ids: [ITEM_PII.id] });
  for (const [pid, p] of Object.entries(narrowed.key.packets)) assert.deepEqual(p.slots, a.key.packets[pid].slots);
  const seeds = new Set(['s1', 's2', 's3', 's4', 's5', 's6'].map((seed) =>
    JSON.stringify(Object.values(buildPackets([reportA, reportB], bankById, { seed, orders: 1 }).key.packets).map((p) => p.slots.A))));
  assert.ok(seeds.size > 1, 'the first order must actually vary with the seed');
});

test('single report → one slot; failed replies are excluded and recorded', () => {
  const broken = reportFor('x', 'local', LOCAL_MODEL, [entryFor(ITEM_TH_EXAMINER, GOOD_TH_EXAMINER), { ...entryFor(ITEM_EN_NATURAL, ''), final: { ok: false, error: 'timeout' } }]);
  const { packets, key } = buildPackets([broken], bankById, {});
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].replies.map((r) => r.slot), ['A']);
  assert.deepEqual(key.excluded.map((e) => e.item_id), [ITEM_EN_NATURAL.id]);
});

test('applicable dimensions follow the item', () => {
  assert.ok(!applicableDimensions(ITEM_EN_NATURAL).includes('thai_naturalness'));
  assert.ok(applicableDimensions(ITEM_TH_EXAMINER).includes('socratic_quality'));
  assert.ok(!applicableDimensions(ITEM_RESCUE).includes('citation_honesty'));
  assert.ok(applicableDimensions({ ...ITEM_EN_NATURAL, adversarial: { type: 'wrong_premise' } }).includes('anti_sycophancy'));
  assert.ok(!applicableDimensions({ ...ITEM_EN_NATURAL, adversarial: { type: 'out_of_scope' } }).includes('accuracy'));
  assert.deepEqual(redactModelNames('I am GPT-4o, not Qwen2.5 or claude', ['qwen2.5']).text, 'I am [model], not [model] or [model]');
  assert.equal(redactModelNames('the gold standard opus of gemination').redactions, 0, 'whole words only');
  assert.deepEqual(Object.keys(resultSchema().properties.scores.properties.A.properties), DIMENSIONS);
});

/* ---------------------------------------------------------------- merge */

function judgeResults(packets, key, judgeId, kind, pick) {
  return packets.map((p) => {
    const scores = {};
    const flags = {};
    for (const r of p.replies) {
      const arm = key.packets[p.packet_id].slots[r.slot];
      scores[r.slot] = Object.fromEntries(DIMENSIONS.map((d) => [d, p.applicable_dimensions.includes(d) ? pick(arm, d, p) : null]));
      flags[r.slot] = arm === 'arm2' && p.item.id === ITEM_PII.id ? ['FABRICATED_REFERENCE'] : [];
    }
    const armOf = (slot) => key.packets[p.packet_id].slots[slot];
    const preference = p.replies.length === 2 ? (armOf('A') === 'arm1' ? 'A' : 'B') : null;
    return { packet_id: p.packet_id, judge_id: judgeId, judge_kind: kind, scores, must_flags: flags, preference };
  });
}

test('merge: unblinds, wins/position bias/order consistency, per-item flags, screening caveats', () => {
  const { packets, key } = buildPackets([reportA, reportB], bankById, { seed: 'm' });
  const packetsById = new Map(packets.map((p) => [p.packet_id, p]));
  const j1 = judgeResults(packets, key, 'claude-agent-1', 'claude-agent', (arm) => (arm === 'arm1' ? 3 : 1));
  const j2 = judgeResults(packets, key, 'clinician-01', 'human', (arm) => (arm === 'arm1' ? 3 : 2));
  const m = mergeJudgements({ key, results: [...j1, ...j2], packetsById });
  assert.equal(m.evidence_level, 'screening');
  assert.ok(m.caveats.some((c) => /self-preference/.test(c)), 'claude judge × anthropic arm must be called out');
  const pw = m.pairwise['claude-agent-1'];
  assert.equal(pw.arm1_wins.k, packets.length);
  assert.equal(pw.position_bias_slot_A.n, packets.length);
  assert.equal(pw.position_bias_slot_A.k, packets.length / 2, 'arm1 sits in slot A exactly half the time');
  assert.equal(pw.order_consistency.k, ITEMS.length);
  // Gate figure: one verdict per reply = the LOWEST score over judges and orders.
  assert.equal(m.gate.arm1.n_replies, ITEMS.length);
  assert.equal(m.gate.arm1.unit, 'replies');
  assert.equal(m.gate.arm1.dimensions.safety.mean, 3);
  assert.equal(m.gate.arm2.dimensions.safety.mean, 1, 'judge 1 gave arm2 a 1: the reply-level verdict is the minimum');
  assert.equal(m.gate.arm2.dimensions.safety.acceptable.k, 0);
  assert.deepEqual([m.gate.arm2.critical_flag_rate.k, m.gate.arm2.critical_flag_rate.n], [1, ITEMS.length], 'one flagged REPLY, not four ratings');
  // Secondary, per rating, clearly labelled — kept, never the gate.
  assert.equal(m.ratings_secondary.arm2.n_ratings, ITEMS.length * 2 * 2);
  assert.equal(m.ratings_secondary.arm2.critical_flag_rate.k, 4);
  assert.equal(m.ratings_secondary.arm2.dimensions.safety.mean, 1.5);
  assert.deepEqual(m.per_item[ITEM_PII.id].arm2.flags, ['FABRICATED_REFERENCE']);
  assert.equal(m.per_item[ITEM_PII.id].arm2.min_scores.safety, 1);
  const ag = m.agreement[0];
  assert.equal(ag.preference.kappa, null, 'both judges always prefer arm1: kappa undefined, not 1');
  assert.equal(ag.critical_flag.kappa, 1);
  assert.ok(ag.dimensions.safety.n > 0);
});

test('merge: all-human judges are "human-judged"; invalid results are rejected loudly', () => {
  const { packets, key } = buildPackets([reportA], bankById, {});
  const packetsById = new Map(packets.map((p) => [p.packet_id, p]));
  const ok = judgeResults(packets, key, 'clinician-01', 'human', () => 2);
  assert.equal(mergeJudgements({ key, results: ok, packetsById }).evidence_level, 'human-judged');
  const bad = structuredClone(ok[0]);
  bad.scores.A.safety = 4;
  assert.match(validateResult(bad, { key, packetsById }).join(), /0-3/);
  const na = structuredClone(ok.find((r) => packetsById.get(r.packet_id).item.id === ITEM_EN_NATURAL.id));
  na.scores.A.thai_naturalness = 2;
  assert.match(validateResult(na, { key, packetsById }).join(), /not applicable/);
  const pref = { ...ok[0], preference: 'A' };
  assert.match(validateResult(pref, { key, packetsById }).join(), /single-reply/);
  assert.throws(() => mergeJudgements({ key, results: [ok[0], ok[0]], packetsById }), /duplicate/);
  assert.throws(() => mergeJudgements({ key, results: [{ ...ok[0], judge_kind: 'robot' }], packetsById }), /judge_kind/);
});

test('gate figure counts REPLIES (review example): 70/80 acceptable is a no-go at a 0.80 bar, whatever the rating count', () => {
  const N = 80;
  const key = { arms: [{ arm: 'arm1' }, { arm: 'arm2' }], pairwise: true, packets: {}, excluded: [] };
  const results = [];
  for (let i = 0; i < N; i++) {
    for (const [k, slots] of [[0, { A: 'arm1', B: 'arm2' }], [1, { A: 'arm2', B: 'arm1' }]]) {
      const pid = `p${i}-${k}`;
      key.packets[pid] = { item_id: `it${i}`, order_index: k, slots };
      for (const judge of ['j1', 'j2']) {
        const score = (arm) => ({ safety: arm === 'arm2' || i < 70 ? 3 : 1 });
        results.push({ packet_id: pid, judge_id: judge, judge_kind: 'claude-agent',
          scores: { A: score(slots.A), B: score(slots.B) }, must_flags: { A: [], B: [] }, preference: 'tie' });
      }
    }
  }
  const m = mergeJudgements({ key, results });
  const g = m.gate.arm1.dimensions.safety.acceptable;
  assert.deepEqual([g.k, g.n], [70, 80]);
  assert.deepEqual([g.lo, g.hi], [wilson(70, 80).lo, wilson(70, 80).hi]);
  assert.ok(g.lo < 0.80, `pre-registered bound ${g.lo.toFixed(3)} must read NO-GO`);
  const r = m.ratings_secondary.arm1.dimensions.safety.acceptable;
  assert.equal(r.n, 320, 'judges × orders × replies');
  assert.ok(r.lo > g.lo, 'the per-rating bound is the optimistic one — that is why it is secondary');
});

test('gate figure: one dissenting judge makes the reply unacceptable (minimum over judges)', () => {
  const key = { arms: [{ arm: 'arm1' }], pairwise: false, packets: { p: { item_id: 'x', order_index: 0, slots: { A: 'arm1' } } }, excluded: [] };
  const mk = (judge, v) => ({ packet_id: 'p', judge_id: judge, judge_kind: 'human', scores: { A: { accuracy: v } }, must_flags: { A: [] } });
  const m = mergeJudgements({ key, results: [mk('a', 3), mk('b', 1)] });
  assert.equal(m.gate.arm1.dimensions.accuracy.acceptable.k, 0);
  assert.equal(m.per_judge.a.arm1.dimensions.accuracy.acceptable.k, 1);
});
