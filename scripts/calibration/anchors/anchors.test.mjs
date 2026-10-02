// Anchor cohort: design determinism + coverage, fixture schema + blindness + PII, manifest integrity,
// and the offline known-groups analysis. Package-free — runs in the calibration CI job on a bare
// checkout (no npm install), so nothing here may pull in a node_modules dependency.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  generateDesign, checkInvariants, coverage, serialise, DOMAINS, DESIGN_PATH, DEFAULT_N, DEFAULT_SEED, PILOT_N, STEP, rng,
} from './design.mjs';
import {
  validateFixture, validateAll, serialiseManifest, MANIFEST_PATH, FIXTURES_DIR, REFLECTION_HEADINGS, thaiShare,
} from './validate.mjs';
import { checkCitation } from './citations.mjs';
import { cueFeatures, cueCheck, cueFails, applyPilotFreeze, PILOT_FREEZE, CUE_RELEVANT } from './cues.mjs';
import { checkSplit, splitFilter, heldOutEligible, loadAnchorSplit } from './anchor-split.mjs';
import {
  knownGroups, normaliseScores, parseThreshold, loadThreshold, spearman, wilson, EVIDENCE_LEVEL,
} from './known-groups.mjs';

const require = createRequire(import.meta.url);
const { compositeOf } = require('../../../rimpl/src/lib/composite.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

const committedDesign = JSON.parse(await readFile(DESIGN_PATH, 'utf8'));

describe('design.mjs', () => {
  test('is deterministic for a seed, and the seed matters', () => {
    const a = serialise(generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED }));
    const b = serialise(generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED }));
    assert.equal(a, b);
    assert.notEqual(a, serialise(generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED + 1 })));
  });

  test('committed design.json is exactly what the default seed generates', async () => {
    assert.equal(await readFile(DESIGN_PATH, 'utf8'), serialise(generateDesign()));
  });

  test('every invariant holds on the committed design', () => {
    assert.deepEqual(checkInvariants(committedDesign), []);
  });

  test('invariants hold for other seeds too (the generator, not one lucky seed)', () => {
    for (const seed of [1, 7, 20260901, 99991]) {
      assert.deepEqual(checkInvariants(generateDesign({ seed })), [], `seed ${seed}`);
    }
  });

  test('STEP is derived from production weights (composite points per level)', () => {
    assert.deepEqual(STEP, { d1: 3, d2: 4, d3: 3, d4: 3, d5: 3, d6: 2, d7: 2 });
  });

  test('coverage: full composite range, every domain x level at least twice, d1/d2 move', () => {
    const cov = coverage(committedDesign);
    assert.ok(cov.composite.min <= 20 && cov.composite.max >= 90, `${cov.composite.min}-${cov.composite.max}`);
    for (const d of DOMAINS) cov.levels[d].forEach((c, l) => assert.ok(c >= 2, `${d} level ${l}: ${c}`));
    assert.ok(cov.domainSd.d1 >= 1 && cov.domainSd.d2 >= 1);
    for (const a of committedDesign.anchors) assert.equal(a.target_composite, compositeOf(a.targets), a.id);
  });

  test('pilot: 20 anchors anc-001..anc-020, both extremes, >= 3 English', () => {
    const cov = coverage(committedDesign);
    assert.equal(cov.pilot.n, PILOT_N);
    assert.ok(cov.pilot.includesMin && cov.pilot.includesMax);
    assert.ok(cov.pilot.english >= 3);
    const ids = committedDesign.anchors.filter((a) => a.pilot).map((a) => a.id).sort();
    assert.deepEqual(ids, Array.from({ length: 20 }, (_, k) => `anc-${String(k + 1).padStart(3, '0')}`));
  });

  test('ids carry no information about level, and length is decoupled from level', () => {
    const A = committedDesign.anchors;
    const idRho = spearman(A.map((a) => Number(a.id.slice(4))), A.map((a) => a.target_composite)).rho;
    // The pilot block (ids 1-20) is a stratified sample, so the id is uninformative within each block.
    assert.ok(Math.abs(idRho) < 0.3, `id vs composite rho ${idRho}`);
    assert.ok(Math.abs(coverage(committedDesign).turnsVsComposite) < 0.3);
  });

  test('d6 = 0 never comes with a reflection', () => {
    for (const a of committedDesign.anchors) if (a.targets.d6 === 0) assert.equal(a.reflection, 'none', a.id);
  });
});

describe('fixtures', async () => {
  const names = (await readdir(FIXTURES_DIR)).filter((f) => /^anc-\d{3}\.json$/.test(f)).sort();
  const rows = new Map(committedDesign.anchors.map((a) => [a.id, a]));

  test('there are fixtures, and each one has a design row', () => {
    assert.ok(names.length > 0);
    for (const n of names) assert.ok(rows.has(n.slice(0, -5)), n);
  });

  for (const name of names) {
    test(`${name}: schema, design fit, blindness, PII, language, tutor format`, async () => {
      const raw = await readFile(path.join(FIXTURES_DIR, name), 'utf8');
      const doc = JSON.parse(raw);
      const r = validateFixture(doc, name, rows.get(name.slice(0, -5)));
      assert.deepEqual(r.errors, []);
      // Blind: no target-shaped key anywhere in the file, at any depth.
      assert.doesNotMatch(raw, /"(d[1-7]|targets?|target_composite|scores?|profile|pilot)"\s*:/);
    });
  }

  test('manifest.json matches the committed fixtures byte for byte', async () => {
    const { manifest } = await validateAll();
    assert.equal(await readFile(MANIFEST_PATH, 'utf8'), serialiseManifest(manifest));
  });


  test('reflection headings are production\'s (backend/src/services/reflection.js)', async () => {
    const src = await readFile(path.join(REPO, 'backend/src/services/reflection.js'), 'utf8');
    for (const h of REFLECTION_HEADINGS) assert.ok(src.includes(`\`${h}\\n`), `heading not in reflection.js: ${h}`);
  });
});

describe('validate.mjs catches what it claims to', () => {
  const row = { id: 'anc-999', language: 'th', tutor_mode: 'examiner', physician_turns: 4, reflection: 'none', target_composite: 50 };
  const good = () => ({
    ple_id: 'anc-999', patient_ref: null,
    transcript: [
      { role: 'physician', content: 'ผู้ป่วยชายในวัย 50 กว่า ไข้ ไอ มีเสมหะ ควร admit ไหมครับ' },
      { role: 'assistant', content: 'ใช้ CURB-65 ช่วยตัดสินใจได้ครับ (Lim et al., 2003)\n❓ ผู้ป่วยรายนี้มีภาวะสับสนหรือไม่ครับ?' },
      { role: 'physician', content: 'ไม่สับสนครับ BUN ปกติ แล้วควรให้ยาอะไรครับ' },
      { role: 'assistant', content: 'พิจารณาตาม guideline ครับ (ATS/IDSA, 2019)\n❓ มีโรคร่วมอะไรบ้างครับ?' },
      { role: 'physician', content: 'มี DM ครับ ใช้ amoxicillin ได้ไหม' },
      { role: 'assistant', content: 'ผู้ป่วยมีโรคร่วม แนะนำ amoxicillin/clavulanate ร่วมกับ macrolide ครับ (ATS/IDSA, 2019)\n❓ จะนัดติดตามเมื่อไรครับ?' },
      { role: 'physician', content: 'นัด 48 ชั่วโมงครับ ok ครับ' },
      { role: 'assistant', content: 'เหมาะสมครับ (ATS/IDSA, 2019)\n❓ อาการแบบไหนที่ต้องกลับมาก่อนนัดครับ?' },
    ],
  });

  test('a clean fixture passes', () => assert.deepEqual(validateFixture(good(), 'anc-999.json', row).errors, []));

  test('target leakage is caught', () => {
    const d = good(); d.transcript[0].content += ' (d2 should be 5)';
    assert.ok(validateFixture(d, 'anc-999.json', row).errors.some((e) => /leakage/.test(e)));
  });

  test('a PII-filter hit is caught (an age the filter masks)', () => {
    const d = good(); d.transcript[0].content = 'ผู้ป่วยชายอายุ 58 ปี ไข้ ไอ ควร admit ไหมครับ';
    assert.ok(validateFixture(d, 'anc-999.json', row).errors.some((e) => /pii-filter/.test(e)));
  });

  test('an invented citation is caught', () => {
    const d = good(); d.transcript[1].content = 'ให้ยา X ครับ (Thai Pneumonia Consensus, 2025)\n❓ ต่อไปทำอะไรครับ?';
    assert.ok(validateFixture(d, 'anc-999.json', row).errors.some((e) => /allowlist/.test(e)));
  });

  test('examiner turns must end on ❓; natural turns must not carry one', () => {
    const d = good(); d.transcript[3].content = 'พิจารณาตาม guideline ครับ (ATS/IDSA, 2019)';
    assert.ok(validateFixture(d, 'anc-999.json', row).errors.some((e) => /❓/.test(e)));
    assert.ok(validateFixture(good(), 'anc-999.json', { ...row, tutor_mode: 'natural' }).errors.some((e) => /natural/.test(e)));
  });

  test('roles, alternation, turn count and reflection placement are enforced', () => {
    const d = good(); d.transcript[2].role = 'user';
    assert.ok(validateFixture(d, 'anc-999.json', row).errors.length);
    assert.ok(validateFixture(good(), 'anc-999.json', { ...row, physician_turns: 5 }).errors.some((e) => /design says 5/.test(e)));
    const r = good(); r.transcript.push({ role: 'reflection', content: `${REFLECTION_HEADINGS[0]}\nได้เรียนรู้เรื่อง CURB-65` });
    assert.ok(validateFixture(r, 'anc-999.json', row).errors.some((e) => /reflection/.test(e)));
    assert.deepEqual(validateFixture(r, 'anc-999.json', { ...row, reflection: 'reflection_turn' }).errors, []);
  });

  test('language mismatch is caught', () => {
    assert.ok(validateFixture(good(), 'anc-999.json', { ...row, language: 'en' }).errors.some((e) => /language en/.test(e)));
    assert.ok(thaiShare('ผู้ป่วย ECG') > 0.5 && thaiShare('ECG normal') === 0);
  });

  test('citation allowlist matches real sources and rejects unknown ones', () => {
    assert.ok(checkCitation('Surviving Sepsis Campaign, 2021').ok);
    assert.ok(checkCitation('ESC, 2023').ok);
    assert.ok(!checkCitation('Surviving Sepsis Campaign, 2019').ok);
    assert.ok(!checkCitation('Made-up Society, 2024').ok);
  });
});

describe('known-groups.mjs', () => {
  const design = committedDesign;
  const pilot = design.anchors.filter((a) => a.pilot);
  const runsOf = (f) => new Map(pilot.map((a) => [a.id, f(a)]));

  test('the pre-registered threshold is read from AUTHORING.md, and is 15', async () => {
    assert.equal(await loadThreshold(), 15);
    assert.throws(() => parseThreshold('no threshold here'));
  });

  test('a scorer that returns the targets exactly: ICC ~1, no flags, zero bias', () => {
    const rep = knownGroups(design, runsOf((a) => [a.targets, a.targets, a.targets]), { threshold: 15, pilotOnly: true });
    assert.equal(rep.n_scored, 20);
    assert.equal(rep.n_missing, 0);
    assert.equal(rep.flags.n, 0);
    assert.ok(rep.composite.icc.icc > 0.99);
    assert.equal(rep.composite.bias, 0);
    assert.equal(rep.evidence_level, EVIDENCE_LEVEL);
    assert.equal(rep.retest.max_range, 0);
  });

  test('a scorer one level high everywhere: +20 composite bias, everything above 15 flagged', () => {
    const up = (t) => Object.fromEntries(DOMAINS.map((d) => [d, Math.min(5, t[d] + 1)]));
    const rep = knownGroups(design, runsOf((a) => [up(a.targets)]), { threshold: 15, pilotOnly: true });
    for (const a of rep.anchors) assert.equal(a.flagged, Math.abs(a.ai_composite - a.target_composite) > 15, a.id);
    assert.ok(rep.composite.bias > 10);
    assert.ok(rep.composite.spearman.rho > 0.9, 'rank order survives a uniform shift');
    assert.ok(rep.composite.icc.icc < rep.composite.spearman.rho, 'absolute agreement penalises the offset');
  });

  test('a scorer that ignores the transcript (constant 3s): flags the extremes, ρ undefined', () => {
    const three = Object.fromEntries(DOMAINS.map((d) => [d, 3]));
    const rep = knownGroups(design, runsOf(() => [three]), { threshold: 15, pilotOnly: true });
    assert.equal(rep.composite.spearman.rho, null);
    assert.ok(rep.flags.ids.length >= 8);
    assert.ok(rep.flags.rate.lower > 0 && rep.flags.rate.upper < 1);
  });

  test('median across runs, and test–retest range', () => {
    const a = pilot[0];
    const lo = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
    const rep = knownGroups(design, new Map([[a.id, [a.targets, lo, a.targets]]]), { threshold: 15, onlyIds: [a.id] });
    assert.deepEqual(rep.anchors[0].ai_median, a.targets);
    assert.equal(rep.anchors[0].retest_range, a.target_composite);
  });

  test('normaliseScores reads all three input shapes and counts unscored rows', () => {
    const t = pilot[0].targets;
    const sl = normaliseScores({ model: 'm', prompt_version_used: 'p', rows: [{ id: 'anc-001', run: 1, scores: t }, { id: 'anc-001', run: 2, scores: null }] });
    assert.equal(sl.runs.get('anc-001').length, 1);
    assert.equal(sl.unscored, 1);
    assert.equal(sl.provenance.prompt_version, 'p');
    const ma = normaliseScores({ rows: [{ id: 'ANC-002', local: t, cloud: null }] }, { arm: 'cloud' });
    assert.equal(ma.runs.size, 0);
    assert.equal(normaliseScores({ rows: [{ id: 'ANC-002', local: t, cloud: null }] }).runs.get('anc-002').length, 1);
    assert.equal(normaliseScores([{ id: 'anc-003', scores: t }, { id: 'anc-003', scores: t }]).runs.get('anc-003').length, 2);
  });

  test('spearman handles ties and wilson brackets the rate', () => {
    assert.equal(spearman([1, 2, 2, 3], [1, 2, 2, 3]).rho, 1);
    const w = wilson(3, 20);
    assert.ok(w.lower < 0.15 && w.upper > 0.15);
  });

  test('CLI on a synthetic scores file prints the evidence label and writes the report', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'anchors-kg-'));
    try {
      const rows = pilot.flatMap((a) => [1, 2, 3].map((run) => ({
        id: a.id, run,
        scores: Object.fromEntries(DOMAINS.map((d) => [d, Math.max(0, Math.min(5, a.targets[d] + (run === 2 ? 1 : 0)))])),
      })));
      rows.push({ id: pilot[0].id, run: 4, scores: null, error: 'unparseable' });
      const scores = path.join(dir, 'scores.json');
      const out = path.join(dir, 'report.json');
      await writeFile(scores, JSON.stringify({ probe: 'anchors-score-local', model: 'synthetic-test', prompt_version_used: 'x', rows }));
      const stdout = execFileSync(process.execPath, [path.join(HERE, 'known-groups.mjs'), '--pilot', scores, '--out', out], { encoding: 'utf8' });
      assert.match(stdout, /EVIDENCE LEVEL: screening-synthetic \(AI-authored, AI-scored\)/);
      assert.match(stdout, /PRE-REGISTERED flag: \|AI composite − target\| > 15/);
      const rep = JSON.parse(await readFile(out, 'utf8'));
      assert.equal(rep.n_scored, 20);
      assert.equal(rep.unscored, 1);
      assert.equal(rep.flags.n, 0);
      assert.equal(rep.provenance.requested_model, 'synthetic-test');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('cues.mjs — surface-cue check', () => {
  const design = committedDesign;
  const pilot = design.anchors.filter((a) => a.pilot);
  const doc = (physician, reflection) => ({ transcript: [
    ...physician.flatMap((c) => [{ role: 'physician', content: c }, { role: 'assistant', content: 'x' }]),
    ...(reflection ? [{ role: 'reflection', content: reflection }] : []),
  ] });

  test('features: acks, numbers, list lines and rubric echo are counted; reflection headings are not', () => {
    const f = cueFeatures(doc(['ok ครับ แล้ว eGFR 45 ล่ะ', '- ข้อ 1\n- ข้อ 2\nโอเคครับ'],
      `${REFLECTION_HEADINGS[1]}\nยังไม่แน่นอนเรื่อง dose`));
    assert.equal(f.acks, 1);                 // "ok" and "โอเค" over 2 turns
    assert.equal(f.numbers, 1.5);            // 45, 1, 2 over 2 turns
    assert.equal(f.list_lines, 2);
    assert.equal(f.rubric_echo, 1);          // "ไม่แน่นอน" in the body only, not in the heading
  });

  test('a planted cue is caught: acknowledgements that track the target fail the gate', () => {
    const entries = pilot.map((a) => ({ id: a.id, row: a, features: {
      length: 1000, acks: 5 - a.target_composite / 20 + (Number(a.id.slice(4)) % 3) * 0.4, numbers: 1, list_lines: 0, rubric_echo: 0 } }));
    const res = cueCheck(entries);
    assert.ok(res.failures.some((f) => f.feature === 'acks' && f.target === 'composite'));
    assert.ok(!res.failures.some((f) => f.feature === 'numbers'), 'a constant feature has no correlation');
    // A PERFECT cue (r = 1) must fail too — its Fisher-z interval is undefined, not absent.
    const perfect = cueCheck(pilot.map((a) => ({ id: a.id, row: a, features: {
      length: a.target_composite, acks: 0, numbers: 1, list_lines: 0, rubric_echo: 0 } })));
    assert.ok(perfect.failures.some((f) => f.feature === 'length' && f.target === 'composite'));
  });

  test('gate rule: fail only when the CI shows a cue beyond ±0.1, at every n', () => {
    assert.equal(cueFails({ r: 0.45, n: 20, lower: 0.02, upper: 0.74 }), false, 'CI reaches below 0.1');
    assert.equal(cueFails({ r: 0.55, n: 20, lower: 0.13, upper: 0.80 }), true);
    assert.equal(cueFails({ r: -0.55, n: 20, lower: -0.80, upper: -0.13 }), true);
    assert.equal(cueFails({ r: 0.25, n: 100, lower: 0.06, upper: 0.42 }), false);
    assert.equal(cueFails({ r: 0.30, n: 100, lower: 0.11, upper: 0.47 }), true);
    assert.equal(cueFails({ r: 0.9, n: 3, lower: null, upper: null }), false, 'no CI, no verdict');
    for (const [f, ts] of Object.entries(CUE_RELEVANT)) assert.ok(ts.includes('composite'), f);
  });

  test('null simulation: with NO true cue the whole check false-fails <= 20%, with no cliff in n', () => {
    // Real design targets, features drawn independently of them. 500 seeded sims per n. The check
    // "fails" when ANY of the 15 gated pairs fails — that is what turns CI red.
    const R = rng(20261003);
    const rate = (n) => {
      let fails = 0;
      for (let s = 0; s < 500; s++) {
        const rows = R.shuffle(design.anchors).slice(0, n);
        const entries = rows.map((row) => ({ id: row.id, row, features: {
          length: R.normal(), acks: R.normal(), numbers: R.normal(), list_lines: R.normal(), rubric_echo: R.normal() } }));
        if (cueCheck(entries).failures.length) fails++;
      }
      return fails / 500;
    };
    const r = { 30: rate(30), 49: rate(49), 50: rate(50), 100: rate(100) };
    for (const [n, v] of Object.entries(r)) assert.ok(v <= 0.20, `null false-fail rate ${v} at n=${n}`);
    assert.ok(Math.abs(r[49] - r[50]) <= 0.06, `jump between n=49 (${r[49]}) and n=50 (${r[50]})`);
    assert.ok(r[100] <= r[30], 'more data must not make noise fail more often');
  });

  test('pilot freeze: keyed to the exact pilot files, and capped at the recorded r', async () => {
    const { cues, results } = await validateAll();
    assert.deepEqual(cues.counted, [], 'a cue outside (or stronger than) the pilot freeze');
    const shas = Object.fromEntries(results.map((x) => [x.id, x.sha256]));
    // The freeze's fixture list IS the committed pilot manifest.
    assert.deepEqual(shas, PILOT_FREEZE.fixtures);
    const acks = { feature: 'acks', target: 'composite', r: PILOT_FREEZE.pairs['acks:composite'] };
    const other = { feature: 'length', target: 'composite', r: 0.6 };
    assert.deepEqual(applyPilotFreeze([acks, other], { fixtureShas: shas }).counted, [other]);
    // Stronger than recorded → counts, even inside the freeze.
    const stronger = { ...acks, r: acks.r - 0.05 };
    assert.deepEqual(applyPilotFreeze([stronger], { fixtureShas: shas }).counted, [stronger]);
    // One pilot file rewritten → freeze off.
    assert.deepEqual(applyPilotFreeze([acks], { fixtureShas: { ...shas, 'anc-007': '0'.repeat(64) } }).counted, [acks]);
    // Any extra fixture → freeze off.
    assert.deepEqual(applyPilotFreeze([acks], { fixtureShas: { ...shas, 'anc-021': '1'.repeat(64) } }).counted, [acks]);
  });
});

describe('anchor-split.mjs — the pilot is tuning-only', () => {
  const design = committedDesign;
  const pilotIds = design.anchors.filter((a) => a.pilot).map((a) => a.id);

  test('no pilot anchor is eligible for held-out', () => {
    const eligible = new Set(heldOutEligible(design));
    for (const id of pilotIds) assert.ok(!eligible.has(id), id);
    assert.equal(eligible.size, design.anchors.length - pilotIds.length);
  });

  test('a split that holds out a pilot anchor is rejected', () => {
    const bad = { held_out: [pilotIds[0], 'anc-050'], tuning: ['anc-051'] };
    assert.ok(checkSplit(design, bad).some((e) => /pilot/.test(e)));
    assert.throws(() => splitFilter(design, bad, 'heldout'), /pilot/);
    assert.deepEqual(checkSplit(design, { held_out: ['anc-050'], tuning: [...pilotIds, 'anc-051'] }), []);
  });

  test('split filter follows the probe rules (D13)', () => {
    assert.equal(splitFilter(design, null, undefined), null);
    assert.throws(() => splitFilter(design, null, 'tuning'), /does not exist/);
    const ok = { held_out: ['anc-050'], tuning: ['anc-051'] };
    assert.throws(() => splitFilter(design, ok, undefined), /name --split/);
    assert.deepEqual([...splitFilter(design, ok, 'heldout')], ['anc-050']);
  });

  test('the committed SPLIT-anchors.json, once it exists, never holds out a pilot anchor', async () => {
    const split = await loadAnchorSplit();
    if (split) assert.deepEqual(checkSplit(design, split), []);
  });
});

describe('known-groups.mjs — §7.6 rule and served models', () => {
  const design = committedDesign;
  const pilot = design.anchors.filter((a) => a.pilot);

  test('anchors with no valid score count AGAINST the proceed rule', () => {
    const runs = new Map(pilot.slice(0, 15).map((a) => [a.id, [a.targets]]));
    const rep = knownGroups(design, runs, { threshold: 15, pilotOnly: true });
    assert.equal(rep.flags.n, 0);
    assert.equal(rep.missing_ids.length, 5);
    assert.equal(rep.proceed_rule.not_expressing, 5);
    assert.equal(rep.proceed_rule.allowed, 4);
    assert.equal(rep.proceed_rule.verdict, 'exceeded');
    const sixteen = knownGroups(design, new Map(pilot.slice(0, 16).map((a) => [a.id, [a.targets]])), { threshold: 15, pilotOnly: true });
    assert.equal(sixteen.proceed_rule.verdict, 'within');
  });

  test('served model comes from the rows, not the requested model', () => {
    const t = pilot[0].targets;
    const n = normaliseScores({ model: 'requested-x', rows: [
      { id: pilot[0].id, run: 1, scores: t, model: 'served-a' },
      { id: pilot[0].id, run: 2, scores: t, model: 'served-b' },
      { id: pilot[0].id, run: 3, scores: null, model: 'served-a', error: 'invalid_scores' },
    ] });
    assert.deepEqual(n.provenance.served_models, { 'served-a': 1, 'served-b': 1 });
    assert.equal(n.provenance.requested_model, 'requested-x');
    const rep = knownGroups(design, n.runs, { threshold: 15, onlyIds: [pilot[0].id], served: n.served });
    assert.deepEqual(rep.anchors[0].served_models, ['served-a', 'served-b']);
  });

  test('a split filter restricts the designed set', () => {
    const runs = new Map(pilot.map((a) => [a.id, [a.targets]]));
    const rep = knownGroups(design, runs, { threshold: 15, allowedIds: new Set([pilot[0].id, pilot[1].id]) });
    assert.equal(rep.n_designed, 2);
  });
});

// revalidate.mjs needs zod (rimpl/node_modules), which the bare-checkout CI job does not install.
// Where rimpl deps exist it runs; on CI it is skipped and the skip reason says why.
let haveZod = true;
try { require('../../../rimpl/src/lib/pis7.js'); } catch { haveZod = false; }
describe("revalidate.mjs — replays saved replies through production's contract", { skip: haveZod ? false : 'rimpl/node_modules (zod) not installed' }, () => {
  const t = { d1: 2, d2: 3, d3: 2, d4: 1, d5: 2, d6: 1, d7: 2 };
  const reply = (o) => ({ text: JSON.stringify(o), model: 'm' });

  test('a reply production rejects is un-scored on replay; a valid one is kept', async () => {
    const { revalidateRun } = await import('./revalidate.mjs');
    const doc = { consistency: 'off', rows: [
      { id: 'anc-001', run: 1, scores: t, replies: [reply({ ...t, rationale: { d1: 'q' } })] },
      { id: 'anc-001', run: 2, scores: t, replies: [reply({ ...t, composite_score: 54 })] },
      { id: 'anc-001', run: 3, scores: t, replies: [reply({ ...t, rationale: 'a string' })] },
      { id: 'anc-002', run: 1, scores: t },
      { id: 'anc-003', run: 1, scores: null, error: 'transport 503', replies: [] },
    ] };
    const out = await revalidateRun(doc);
    assert.deepEqual(out.rows[0].scores, t);
    assert.equal(out.rows[0].changed, false);
    assert.equal(out.rows[1].scores, null);
    assert.equal(out.rows[1].error, 'invalid_scores');
    assert.equal(out.rows[1].changed, true);
    assert.equal(out.rows[2].error, 'invalid_scores');
    assert.equal(out.rows[3].revalidation, 'not_revalidatable');
    assert.deepEqual(out.rows[3].scores, t, 'unreplayable rows keep their scores and are counted');
    assert.equal(out.rows[4].error, 'transport 503');
    assert.equal(out.revalidated.not_revalidatable, 1);
    assert.equal(out.revalidated.changed, 2);
    assert.equal(doc.rows[1].scores, t, 'input is not mutated');
  });

  test('adaptive replay reproduces the rule, and an unanswered re-ask is replay_exhausted', async () => {
    const { replayRow } = await import('./revalidate.mjs');
    const ok = reply({ ...t, rationale: {} });
    const res = await replayRow({ replies: [ok, ok] }, { mode: 'adaptive', jsonRetries: 2 });
    assert.deepEqual(res.scores, t);
    assert.equal(res.consistency.calls, 2);
    const bad = reply({ ...t, extra: 1 });
    assert.equal((await replayRow({ replies: [bad] }, { mode: 'adaptive', jsonRetries: 2 })).error, 'replay_exhausted');
  });
});
