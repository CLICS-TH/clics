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
import { createHash } from 'node:crypto';

import {
  generateDesign, checkInvariants, coverage, serialise, DOMAINS, DESIGN_PATH, DEFAULT_N, DEFAULT_SEED, PILOT_N, STEP, rng,
  REPLACEMENTS, applyReplacements, activeAnchors,
} from './design.mjs';
import {
  validateFixture, validateAll, serialiseManifest, MANIFEST_PATH, FIXTURES_DIR, REFLECTION_HEADINGS, thaiShare, checkPlanted,
  checkBudget, LENGTH_CHARS_TOL, LENGTH_TARGET_EXEMPT_BATCHES, batchCueContribution, updateHeldOutLock, recordIntake, intakeAccepted, loadIntakeLog, appendOnlyViolation,
} from './validate.mjs';
import { checkCitation } from './citations.mjs';
import { planBatches, planMarkdown, serialisePlan, simulateCueGate, BATCHES_PATH, PLAN_MD_PATH, BUDGET_LEVELS, BUDGET_RANGES, needsExtraReview } from './batch-plan.mjs';
import { buildBrief, BRIEF_PATH, PIN_PATH } from './author-brief.mjs';
import { cueFeatures, cueCheck, cueFails, applyPilotFreeze, freezeApplies, PILOT_FREEZE, CUE_RELEVANT } from './cues.mjs';
import { checkSplit, splitFilter, heldOutEligible, loadAnchorSplit, reserveByDesign, allocateHeldOut, SPLIT_CELLS, cellOf,
  loadHeldOutLock, lockComplete, assertHeldOutScorable, scorableIdsArg } from './anchor-split.mjs';
import {
  knownGroups, normaliseScores, parseThreshold, loadThreshold, spearman, wilson, EVIDENCE_LEVEL,
} from './known-groups.mjs';

const require = createRequire(import.meta.url);
const { compositeOf } = require('../../../rimpl/src/lib/composite.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

const committedDesign = JSON.parse(await readFile(DESIGN_PATH, 'utf8'));
const activePilot = (design) => activeAnchors(design).filter((a) => a.pilot);

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

  test('pilot: 20 anchors anc-001..anc-020 (§7.4 replacements swapped in), both extremes, >= 3 English', () => {
    const cov = coverage(committedDesign);
    assert.equal(cov.pilot.n, PILOT_N);
    assert.ok(cov.pilot.includesMin && cov.pilot.includesMax);
    assert.ok(cov.pilot.english >= 3);
    const swap = new Map(REPLACEMENTS.map((r) => [r.excluded, r.replaced_by]));
    const ids = activePilot(committedDesign).map((a) => a.id).sort();
    assert.deepEqual(ids, Array.from({ length: 20 }, (_, k) => `anc-${String(k + 1).padStart(3, '0')}`).map((id) => swap.get(id) ?? id).sort());
  });

  test('§7.4: anc-015 is excluded, kept, and replaced by anc-101 at the same target vector and case slot', () => {
    const old = committedDesign.anchors.find((a) => a.id === 'anc-015');
    const neu = committedDesign.anchors.find((a) => a.id === 'anc-101');
    assert.equal(old.excluded.replaced_by, 'anc-101');
    assert.equal(neu.replaces, 'anc-015');
    assert.equal(neu.excluded, undefined);
    for (const k of ['pilot', 'language', 'specialty', 'case', 'tutor_mode', 'physician_turns', 'reflection', 'profile', 'dissociated_domains', 'targets', 'target_composite']) {
      assert.deepEqual(neu[k], old[k], k);
    }
    assert.equal(activeAnchors(committedDesign).length, DEFAULT_N);
    assert.equal(committedDesign.n, DEFAULT_N);
  });

  test('§7.4: replacements take the next free id, never re-exclude, and the invariants catch a bad copy', () => {
    const base = generateDesign({ replacements: [] });
    const r = { ...REPLACEMENTS[0] };
    assert.throws(() => applyReplacements(base, [{ ...r, replaced_by: 'anc-150' }]), /next free id anc-101/);
    assert.throws(() => applyReplacements(base, [r, { ...r, replaced_by: 'anc-102' }]), /already excluded/);
    const bad = applyReplacements(base, [r]);
    bad.anchors.find((a) => a.id === 'anc-101').targets = { ...bad.anchors.find((a) => a.id === 'anc-101').targets, d5: 4 };
    assert.ok(checkInvariants(bad).some((e) => /must copy targets/.test(e)));
  });

  test('ids carry no information about level, and length is decoupled from level', () => {
    const A = activeAnchors(committedDesign);
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

  test('there are fixtures, and each one has an ACTIVE design row (excluded anchors are archived)', () => {
    assert.ok(names.length > 0);
    for (const n of names) assert.ok(rows.has(n.slice(0, -5)) && !rows.get(n.slice(0, -5)).excluded, n);
  });

  test('planted-claims.json matches the fixture bytes, and no false claim carries a citation (legacy aside)', async () => {
    const { planted } = await validateAll();
    assert.deepEqual(planted, []);
  });

  test('checkPlanted rejects a false claim with a citation on its line, a missing claim, and an uncorrected one', () => {
    const doc = { transcript: [
      { role: 'physician', content: 'q' },
      { role: 'assistant', content: 'intro\n- X for everyone (ADA, 2024)\n- Y always' },
      { role: 'physician', content: 'that is wrong' },
      { role: 'assistant', content: 'corrected' },
    ] };
    const read = () => doc;
    const base = { file: 'fixtures/anc-900.json', id: 'anc-900', turn: 1, kind: 'false', corrected_in_turn: 3 };
    assert.match(checkPlanted({ claims: [{ ...base, claim: 'X for everyone', citation_on_claim: true }] }, read).join(), /may not carry a citation/);
    assert.deepEqual(checkPlanted({ claims: [{ ...base, claim: 'X for everyone', citation_on_claim: true, legacy: true }] }, read), []);
    assert.deepEqual(checkPlanted({ claims: [{ ...base, claim: 'Y always', citation_on_claim: false }] }, read), []);
    assert.match(checkPlanted({ claims: [{ ...base, claim: 'Z', citation_on_claim: false }] }, read).join(), /not found verbatim/);
    assert.match(checkPlanted({ claims: [{ ...base, claim: 'Y always', citation_on_claim: false, corrected_in_turn: 2 }] }, read).join(), /later tutor turn/);
    // An unplanted inaccuracy (found after rating, recorded not edited) has no correcting turn.
    assert.deepEqual(checkPlanted({ claims: [{ ...base, kind: 'unplanted', claim: 'Y always', citation_on_claim: false, corrected_in_turn: null }] }, read), []);
    assert.match(checkPlanted({ claims: [{ ...base, kind: 'unplanted', claim: 'Y always', citation_on_claim: false, corrected_in_turn: 3 }] }, read).join(), /null/);
  });

  test('every §7.4-excluded anchor\'s last fixture is archived byte for byte', async () => {
    const { archive } = await validateAll();
    assert.deepEqual(archive, []);
    for (const r of REPLACEMENTS) {
      const buf = await readFile(path.join(HERE, r.archived_fixture));
      assert.equal(createHash('sha256').update(buf).digest('hex'), r.sha256, r.excluded);
    }
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

describe('AUTHORING.md §1 PII table matches the production filter', async () => {
  // The table tells authors what pii-filter.js masks. It went stale once already (#114 changed the
  // filter); this pins every example to the filter as it is, so the next change turns this red.
  const { stripPii } = require('../../../rimpl/src/services/pii-filter.js');
  const md = await readFile(path.join(HERE, 'AUTHORING.md'), 'utf8');
  const spans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((x) => !x.includes('['));
  const table = md.split('\n').filter((l) => /^\s+\| /.test(l) && !/still masked|^\s+\|-/.test(l));
  const masked = table.flatMap((l) => spans(l.split('|')[1]));
  const safe = table.flatMap((l) => spans(l.split('|')[2]));
  const freed = md.match(/\*\*No longer masked after #114\*\*[\s\S]*?(?=\n\n|\n {3}vitals)/)?.[0] ?? '';

  test('the table has examples in both columns', () => {
    assert.ok(masked.length >= 10 && safe.length >= 10, `${masked.length} masked / ${safe.length} safe`);
  });
  test('every "still masked" example is masked', () => {
    for (const s of masked) assert.notEqual(stripPii(s), s, `not masked any more: ${s}`);
  });
  test('every "survives" example survives', () => {
    for (const s of safe) assert.equal(stripPii(s), s, `masked: ${s}`);
  });
  test('every "no longer masked" example survives', () => {
    const list = spans(freed).filter((s) => !s.includes('/'));
    assert.ok(list.length >= 8);
    for (const s of list) assert.equal(stripPii(s), s, `masked again: ${s}`);
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
  const pilot = activePilot(design);
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

  test('a §7.4-excluded anchor in a scores file is ignored and listed, never counted', () => {
    const old = design.anchors.find((a) => a.excluded);
    const runs = runsOf((a) => [a.targets]);
    runs.set(old.id, [{ d1: 5, d2: 5, d3: 5, d4: 5, d5: 5, d6: 5, d7: 5 }]);
    const rep = knownGroups(design, runs, { threshold: 15, pilotOnly: true });
    assert.equal(rep.n_designed, 20);
    assert.equal(rep.n_scored, 20);
    assert.deepEqual(rep.excluded_ids, [old.id]);
    assert.ok(!rep.anchors.some((a) => a.id === old.id));
  });

  test('--include-excluded reproduces the round-1 run exactly (0.685); the default drops anc-015 (0.750)', async () => {
    const doc = JSON.parse(await readFile(path.join(HERE, 'runs/pilot-local-strict-2026-10-02.json'), 'utf8'));
    const { runs } = normaliseScores(doc, { arm: 'local' });
    const fixtureShas = doc.fixtures && typeof doc.fixtures === 'object' ? doc.fixtures : null;
    const fx = (v) => Number(v).toFixed(3);
    const hist = knownGroups(design, runs, { threshold: 15, pilotOnly: true, includeExcluded: true, fixtureShas });
    assert.equal(hist.n_scored, 20);
    assert.deepEqual([fx(hist.composite.icc.icc), fx(hist.composite.icc.lower), fx(hist.composite.icc.upper)], ['0.685', '0.196', '0.879']);
    assert.equal(hist.composite.bias, 11.25);
    assert.deepEqual(hist.excluded_ids, []);
    assert.ok(hist.anchors.some((a) => a.id === 'anc-015') && !hist.anchors.some((a) => a.id === 'anc-101'));
    assert.match(hist.caveats.d5, /RUBRIC ECHO/);
    const now = knownGroups(design, runs, { threshold: 15, pilotOnly: true, fixtureShas });
    assert.equal(now.n_scored, 19);
    assert.equal(fx(now.composite.icc.icc), '0.750');
    assert.equal(now.composite.bias, 9.68);
    assert.deepEqual(now.excluded_ids, ['anc-015']);
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
  const pilot = activePilot(design);
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
        const rows = R.shuffle(activeAnchors(design)).slice(0, n);
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

  // The freeze must name exactly the PILOT anchors, and may only ever be ON for their recorded bytes.
  // Deliberately NOT "the freeze equals every committed fixture": that would turn CI red the moment
  // anc-021 lands, and the tempting fix — pasting the grown sha set into cues.mjs — would re-open the
  // freeze over the whole cohort with caps up to |r| = 0.71.
  // The freeze names the ORIGINAL pilot (as generated, before any §7.4 replacement): it records bytes
  // that existed at 359df39, so a replacement id (anc-101) can never be in it.
  const pilotIds = committedDesign.anchors.filter((a) => a.pilot && !a.replaces).map((a) => a.id).sort();
  const assertFreezeKeying = (shas) => {
    assert.deepEqual(Object.keys(PILOT_FREEZE.fixtures).sort(), pilotIds, 'PILOT_FREEZE must name exactly the pilot anchors');
    const on = freezeApplies(shas);
    for (const id of pilotIds) {
      if (shas[id] !== undefined && shas[id] !== PILOT_FREEZE.fixtures[id]) {
        assert.equal(on, false, `${id} changed since the freeze was recorded, yet the freeze still applies`);
      }
    }
    return on;
  };

  test('pilot freeze: names exactly the pilot anchors and applies only to their recorded bytes', async () => {
    const { results } = await validateAll();
    assertFreezeKeying(Object.fromEntries(results.map((x) => [x.id, x.sha256])));
  });

  test('an extra non-pilot fixture keeps the keying valid and turns the freeze OFF', () => {
    const grown = { ...PILOT_FREEZE.fixtures, 'anc-021': '1'.repeat(64) };
    assert.equal(assertFreezeKeying(grown), false);
    assert.equal(assertFreezeKeying({ ...PILOT_FREEZE.fixtures }), true);
    assert.equal(assertFreezeKeying({ ...PILOT_FREEZE.fixtures, 'anc-007': '0'.repeat(64) }), false);
  });

  test('the cue gate holds on the committed cohort (frozen pairs count once the freeze is off)', async () => {
    const { cues } = await validateAll();
    assert.deepEqual(cues.counted, [], 'a cue outside, or stronger than, the pilot freeze');
  });

  test('pilot freeze caps each pair at its recorded r', () => {
    const shas = { ...PILOT_FREEZE.fixtures };
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
  const pilotIds = activePilot(design).map((a) => a.id);

  test('no pilot anchor is eligible for held-out', () => {
    const eligible = new Set(heldOutEligible(design));
    for (const id of pilotIds) assert.ok(!eligible.has(id), id);
    assert.equal(eligible.size, activeAnchors(design).length - pilotIds.length);
    for (const r of REPLACEMENTS) assert.ok(!eligible.has(r.excluded), r.excluded);
    // An excluded anchor on the HELD-OUT side is an error. On the tuning side it is how a §7.4 exclusion
    // made after the reservation looks (the split is never rewritten, D13); see the checkSplit tests below.
    assert.ok(checkSplit(design, { held_out: [REPLACEMENTS[0].excluded], tuning: ['anc-050'] }).some((e) => /excluded/.test(e)));
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

  test('SPLIT-anchors.json is reserved by design id, reproducibly, and spans the designed range', async () => {
    const split = await loadAnchorSplit();
    assert.ok(split, 'SPLIT-anchors.json must exist before any non-pilot anchor is authored (D13)');
    // Reproducible from the seed over the GENERATED design (before any later §7.4 replacement).
    const again = reserveByDesign(generateDesign({ replacements: [] }), { seed: split.seed, heldOut: split.held_out.length });
    assert.deepEqual(again.held_out, split.held_out);
    const comp = (ids) => ids.map((id) => design.anchors.find((a) => a.id === id).target_composite);
    const eligible = heldOutEligible(design);
    const h = comp(split.held_out), e = comp(eligible);
    // Stratified: held-out reaches both ends of the range, unlike the probe's 32-62 (G0.5), and its
    // centre is the eligible pool's.
    assert.ok(Math.min(...h) <= 20 && Math.max(...h) >= 90, `held-out range ${Math.min(...h)}-${Math.max(...h)}`);
    const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
    assert.ok(Math.abs(mean(h) - mean(e)) < 3, `held-out mean ${mean(h)} vs eligible ${mean(e)}`);
    // Stratified on language × profile: each cell's held-out share is proportional (±1), and every
    // cell of 2 or more keeps a tuning anchor.
    const row = (id) => design.anchors.find((a) => a.id === id);
    for (const c of SPLIT_CELLS) {
      const n = eligible.filter((id) => cellOf(row(id)) === c).length;
      const nh = split.held_out.filter((id) => cellOf(row(id)) === c).length;
      assert.ok(Math.abs(nh - (n * split.held_out.length) / eligible.length) <= 1, `${c}: ${nh} of ${n} held out`);
      if (n >= 2) assert.ok(nh <= n - 1, `${c}: no tuning anchor left`);
    }
    // Every active anchor is in exactly one split.
    const all = new Set([...split.held_out, ...split.tuning]);
    // A §7.4 replacement made after the reservation inherits its predecessor's split (splitFilter).
    const origin = (a) => { let x = a; while (x?.replaces) x = design.anchors.find((y) => y.id === x.replaces); return x?.id; };
    for (const a of activeAnchors(design)) assert.ok(all.has(a.id) || all.has(origin(a)), `${a.id} is in neither split`);
  });

  test('reserveByDesign never holds out a pilot or excluded anchor, and depends on the seed', () => {
    const r = reserveByDesign(design, { seed: 7, heldOut: 40 });
    assert.deepEqual(checkSplit(design, r), []);
    assert.notDeepEqual(r.held_out, reserveByDesign(design, { seed: 8, heldOut: 40 }).held_out);
    assert.throws(() => reserveByDesign(design, { seed: 7, heldOut: 79 }), /held-out must be/);
  });

  test('allocateHeldOut is proportional, sums exactly, and never empties a cell of 2+ of tuning', () => {
    const got = allocateHeldOut({ 'th/coherent': 47, 'th/dissociated': 17, 'en/coherent': 11, 'en/dissociated': 5 }, 60);
    assert.deepEqual(got, { 'th/coherent': 35, 'th/dissociated': 13, 'en/coherent': 8, 'en/dissociated': 4 });
    const small = allocateHeldOut({ 'th/coherent': 10, 'th/dissociated': 2, 'en/coherent': 2, 'en/dissociated': 1 }, 12);
    assert.equal(Object.values(small).reduce((a, b) => a + b, 0), 12);
    assert.ok(small['th/dissociated'] <= 1 && small['en/coherent'] <= 1);
  });

  test('a §7.4 replacement inherits the split of the anchor it replaces', () => {
    const d = { anchors: [...design.anchors, { id: 'anc-999', replaces: 'anc-051' }] };
    const sp = { held_out: ['anc-050'], tuning: ['anc-051'] };
    assert.ok(splitFilter(d, sp, 'tuning').has('anc-999'));
    assert.ok(!splitFilter(d, sp, 'heldout').has('anc-999'));
  });

  test('held-out fixtures are bound at first scoring: a scored held-out text is never changed', async () => {
    const split = await loadAnchorSplit();
    const held = new Set(split?.held_out ?? []);
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    const runsDir = path.join(HERE, 'runs');
    for (const f of (await readdir(runsDir)).filter((x) => x.endsWith('.json'))) {
      const doc = JSON.parse(await readFile(path.join(runsDir, f), 'utf8'));
      for (const [id, sha] of Object.entries(doc?.fixtures ?? {})) {
        if (!held.has(id)) continue;
        assert.equal(manifest.fixtures?.[id]?.sha256, sha, `${id} is held-out and was scored in runs/${f}; its fixture changed after that score`);
      }
    }
  });
});

describe('known-groups.mjs — §7.6 rule and served models', () => {
  const design = committedDesign;
  const pilot = activePilot(design);

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

  test('a pilot analysis carries the d5 rubric-echo caveat; a non-pilot one does not', () => {
    // The caveat describes the ORIGINAL pilot texts; a §7.4 replacement is new text.
    const origPilot = pilot.filter((a) => !a.replaces);
    const withPilot = knownGroups(design, new Map(origPilot.map((a) => [a.id, [a.targets]])), { threshold: 15, pilotOnly: true });
    assert.match(withPilot.caveats.d5, /INFLATED BY RUBRIC ECHO/);
    const rest = design.anchors.filter((a) => !a.pilot).slice(0, 5);
    const noPilot = knownGroups(design, new Map(rest.map((a) => [a.id, [a.targets]])), { threshold: 15, onlyIds: rest.map((a) => a.id) });
    assert.equal(noPilot.caveats.d5, undefined);
    // Scored on the ORIGINAL pilot bytes → caveat; once a pilot anchor was rewritten → no caveat.
    const runs = new Map(origPilot.map((a) => [a.id, [a.targets]]));
    const original = knownGroups(design, runs, { threshold: 15, pilotOnly: true, fixtureShas: { ...PILOT_FREEZE.fixtures } });
    assert.match(original.caveats.d5, /RUBRIC ECHO/);
    const rewritten = knownGroups(design, runs, { threshold: 15, pilotOnly: true,
      fixtureShas: { ...PILOT_FREEZE.fixtures, 'anc-007': 'f'.repeat(64) } });
    assert.equal(rewritten.caveats.d5, undefined);
    const withReplacement = knownGroups(design, new Map(pilot.map((a) => [a.id, [a.targets]])), { threshold: 15, pilotOnly: true });
    assert.equal(withReplacement.caveats.d5, undefined);
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

describe('scaling to 100 — batch plan, author brief, intake', () => {
  const design = committedDesign;
  const plan = planBatches(design);
  const rows = plan.batches.flatMap((b) => b.rows);
  const nonPilot = activeAnchors(design).filter((a) => !a.pilot);

  test('batches.json and BATCH-PLAN.md are exactly what the seed generates', async () => {
    assert.equal(await readFile(BATCHES_PATH, 'utf8'), serialisePlan(plan));
    assert.equal(await readFile(PLAN_MD_PATH, 'utf8'), planMarkdown(plan) + '\n');
  });

  test('every non-pilot anchor is in exactly one batch, with its exact design attributes', () => {
    assert.equal(plan.batches.length, 8);
    for (const b of plan.batches) assert.equal(b.rows.length, 10);
    assert.deepEqual(rows.map((r) => r.id).sort(), nonPilot.map((a) => a.id).sort());
    for (const r of rows) {
      const d = design.anchors.find((a) => a.id === r.id);
      for (const k of ['language', 'specialty', 'case', 'tutor_mode', 'physician_turns', 'reflection', 'profile', 'dissociated_domains', 'targets', 'target_composite']) {
        assert.deepEqual(r[k], d[k], `${r.id} ${k}`);
      }
    }
  });

  test('each batch spans the range and carries its share of English', () => {
    for (const b of plan.batches) {
      const c = b.rows.map((r) => r.target_composite);
      assert.ok(Math.min(...c) <= 25 && Math.max(...c) >= 85, `batch ${b.batch} spans ${Math.min(...c)}-${Math.max(...c)}`);
      assert.equal(b.rows.filter((r) => r.language === 'en').length, 2, `batch ${b.batch}`);
    }
  });

  test('batches.json rows carry only split-blind fields', () => {
    const allowed = new Set(['id', 'language', 'specialty', 'case', 'tutor_mode', 'physician_turns', 'reflection', 'profile',
      'dissociated_domains', 'targets', 'target_composite', 'cue_budget', 'extra_review']);
    for (const r of rows) for (const k of Object.keys(r)) assert.ok(allowed.has(k), `${r.id}: unexpected field ${k}`);
    for (const b of plan.batches) {
      const order = b.rows.map((r) => r.id);
      const want = [...b.rows].sort((x, y) => (Boolean(x.extra_review) - Boolean(y.extra_review)) || x.id.localeCompare(y.id)).map((r) => r.id);
      assert.deepEqual(order, want, `batch ${b.batch} order depends on something other than id and extra_review`);
    }
  });

  test('the plan never reveals the split', async () => {
    const raw = await readFile(BATCHES_PATH, 'utf8') + await readFile(PLAN_MD_PATH, 'utf8') + await readFile(BRIEF_PATH, 'utf8');
    assert.doesNotMatch(raw, /held.?out|"tuning"|SPLIT-anchors/i);
  });

  test('cue budgets are balanced and do not track the target', () => {
    const pearson = (xs, ys) => { const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let p = 0, sx = 0, sy = 0; xs.forEach((x, i) => { p += (x - mx) * (ys[i] - my); sx += (x - mx) ** 2; sy += (ys[i] - my) ** 2; }); return p / Math.sqrt(sx * sy); };
    for (const [f, levels] of Object.entries(BUDGET_LEVELS)) {
      const order = [...new Set(levels)];
      const v = rows.map((r) => order.indexOf(r.cue_budget[f]));
      assert.ok(Math.abs(pearson(v, rows.map((r) => r.target_composite))) < 0.15, `${f} tracks the composite`);
      for (const lvl of order) {
        const want = rows.length * levels.filter((x) => x === lvl).length / levels.length;
        assert.ok(Math.abs(rows.filter((r) => r.cue_budget[f] === lvl).length - want) <= 1, `${f}=${lvl}`);
      }
    }
    for (const r of rows) assert.equal(r.cue_budget.rubric_echo, 0);
  });

  test('authors landing inside their budgets keep the cohort cue gate passing (simulated)', async () => {
    const { results } = await validateAll();
    const existing = results.filter((r) => r.features && r.row && !r.row.excluded).map((r) => ({ id: r.id, row: r.row, features: r.features }));
    const sim = simulateCueGate(plan, existing, { sims: 150, cueCheck });
    assert.ok(sim.fail_rate <= 0.05, `cue gate fails ${(sim.fail_rate * 100).toFixed(1)}% of simulated cohorts ${JSON.stringify(sim.pairs)}`);
  });

  test('AUTHOR-BRIEF.md is exactly what author-brief.mjs builds, and carries the governing text verbatim', async () => {
    const brief = await readFile(BRIEF_PATH, 'utf8');
    assert.equal(brief, await buildBrief());
    const md = await readFile(path.join(HERE, 'AUTHORING.md'), 'utf8');
    for (const h of ['### d1 ', '### d4 ', '### d5 ', '### d7 ', '**Planted claims']) {
      const line = md.split('\n').find((l) => l.startsWith(h));
      assert.ok(line && brief.includes(line), `brief lacks: ${h}`);
    }
    for (const h of REFLECTION_HEADINGS) assert.ok(brief.includes(h));
    assert.ok(brief.includes('`อาการ 3 ปี` → `อาการ [AGE-1]`'), 'the N ปี masking note');
  });

  test('checkBudget flags each kind of deviation', () => {
    const b = { length: 'short', ack_turns: 0, numerals: 'few', list_lines: 0, rubric_echo: 0 };
    const ok = { length: 1000, acks: 0, numbers: 1, list_lines: 0, rubric_echo: 0, echo_hits: {} };
    assert.deepEqual(checkBudget(ok, 5, b), []);
    assert.match(checkBudget({ ...ok, length: 1900 }, 5, b).join(), /length/);
    assert.match(checkBudget({ ...ok, acks: 0.4 }, 5, b).join(), /acknowledgement/);
    assert.match(checkBudget({ ...ok, numbers: 5 }, 5, b).join(), /numerals/);
    assert.match(checkBudget({ ...ok, list_lines: 3 }, 5, b).join(), /list line/);
    assert.match(checkBudget({ ...ok, rubric_echo: 1, echo_hits: { 'd5 (5): fact': 1 } }, 5, b).join(), /rubric-descriptor/);
  });

  test('batchCueContribution names the fixture that pushes a cue', () => {
    const R = rng(11);
    const base = activeAnchors(design).slice(0, 60).map((row) => ({ id: row.id, row, features: {
      length: 1400 + 200 * R.normal(), acks: 0.2, numbers: 2, list_lines: 0, rubric_echo: 0 } }));
    const top = [...base].sort((a, b) => b.row.target_composite - a.row.target_composite).slice(0, 3).map((e) => e.id);
    const pushed = base.map((e) => (top.includes(e.id) ? { ...e, features: { ...e.features, length: 6000 } } : e));
    const c = batchCueContribution(pushed, top);
    const p = c.pairs.find((x) => x.feature === 'length' && x.target === 'composite');
    assert.ok(p.worse && p.pushers.length && top.includes(p.pushers[0].id));
  });

  test('intake mode: validate.mjs --only reports a fixture and writes nothing', async () => {
    const before = await readFile(MANIFEST_PATH, 'utf8');
    const out = execFileSync(process.execPath, [path.join(HERE, 'validate.mjs'), '--only', 'anc-020'], { encoding: 'utf8' });
    assert.match(out, /anc-020\s+ok/);
    assert.equal(await readFile(MANIFEST_PATH, 'utf8'), before);
    // A design row with no fixture yet (it used to be anc-099, until batch 5 was written).
    const plan = JSON.parse(await readFile(BATCHES_PATH, 'utf8'));
    let missing = null;
    for (const r of plan.batches.flatMap((b) => b.rows)) {
      if (!(await readFile(path.join(HERE, 'fixtures', `${r.id}.json`)).then(() => true, () => false))) { missing = r.id; break; }
    }
    if (!missing) return;   // every row is written: nothing left to be missing
    let failed = false;
    try { execFileSync(process.execPath, [path.join(HERE, 'validate.mjs'), '--only', missing], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { failed = true; assert.match(String(e.stdout), new RegExp(`${missing}\\s+MISSING`)); }
    assert.ok(failed, 'a missing fixture must fail intake');
  });
});

describe('D13 on the full cohort — held-out lock and no early held-out scores', () => {
  const design = committedDesign;

  test('HELDOUT-LOCK.json: only held-out ids, and every locked sha is still the fixture on disk', async () => {
    const split = await loadAnchorSplit();
    const lock = await loadHeldOutLock();
    if (!lock) return;                      // nothing recorded yet
    const held = new Set(split.held_out);
    for (const [id, sha] of Object.entries(lock.locked)) {
      assert.ok(held.has(id), `${id} is locked but not held-out`);
      const buf = await readFile(path.join(FIXTURES_DIR, `${id}.json`));
      assert.equal(createHash('sha256').update(buf).digest('hex'), sha, `${id} is held-out and LOCKED; its fixture changed`);
    }
  });

  // Master's copy of a committed record. state: 'no-ref' (no origin/master: a plain export locally; in CI
  // the job fetches master, so this must FAIL there, never pass silently), 'absent' (master has no such
  // file yet), or 'ok' with the parsed JSON.
  const masterCopy = (rel) => {
    const git = (args) => execFileSync('git', args, { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    try { git(['rev-parse', '--verify', '--quiet', 'origin/master']); } catch { return { state: 'no-ref' }; }
    try { return { state: 'ok', json: JSON.parse(git(['show', `origin/master:scripts/calibration/anchors/${rel}`])) }; }
    catch { return { state: 'absent' }; }
  };
  const needMaster = (m, what) => {
    if (m.state !== 'no-ref') return true;
    if (process.env.CI) assert.fail(`origin/master is not readable in CI — ${what} cannot be compared with master`);
    return false;
  };

  test('a lock entry, once on master, is never changed or dropped (CI fails if origin/master is missing)', async () => {
    const m = masterCopy('HELDOUT-LOCK.json');
    if (!needMaster(m, 'the held-out lock') || m.state === 'absent') return;   // nothing locked on master yet
    const now = await loadHeldOutLock();
    for (const [id, sha] of Object.entries(m.json.locked)) assert.equal(now?.locked?.[id], sha, `${id}: locked on master, changed here`);
  });

  test('intake-log.json is append-only against master: master\'s entries are a prefix of this one', async () => {
    // Without this, a hand-written log entry could admit a held-out fixture that never ran intake
    // (budget and extra-review gates skipped), and the next writing run would lock it.
    const m = masterCopy('intake-log.json');
    if (!needMaster(m, 'the intake log') || m.state === 'absent') return;
    const now = await loadIntakeLog();
    const v = appendOnlyViolation(m.json.entries ?? [], now.entries ?? []);
    assert.equal(v, null, `intake-log.json: ${v}`);
  });

  test('appendOnlyViolation: a new trailing entry passes; an edited, dropped or reordered one fails', () => {
    const a = { batch: 1, fixtures: { 'anc-050': 'x' } }, b = { batch: 3, fixtures: { 'anc-060': 'y' } };
    assert.equal(appendOnlyViolation([a], [a, b]), null);
    assert.equal(appendOnlyViolation([], [a]), null);
    assert.match(appendOnlyViolation([a, b], [a]), /removed/);
    assert.match(appendOnlyViolation([a], [{ ...a, fixtures: { 'anc-050': 'FORGED' } }, b]), /entry 0 \(batch 1\)/);
    assert.match(appendOnlyViolation([a, b], [b, a, b]), /append-only/);
  });

  test('every locked held-out fixture passed its batch intake with those bytes (and extra-review was confirmed)', async () => {
    const lock = await loadHeldOutLock();
    if (!lock) return;
    const log = await loadIntakeLog();
    const accepted = intakeAccepted(log);
    const confirmed = new Set((log.entries ?? []).flatMap((e) => e.confirmed_extra_review ?? []));
    const plan = planBatches(design);
    const extra = new Set(plan.batches.flatMap((b) => b.rows.filter((r) => r.extra_review).map((r) => r.id)));
    for (const [id, sha] of Object.entries(lock.locked)) {
      assert.equal(accepted[id], sha, `${id} is locked but its bytes never passed intake (intake-log.json)`);
      if (extra.has(id)) assert.ok(confirmed.has(id), `${id} is extra_review and was locked without --confirm-extra-review`);
    }
  });

  test('recordIntake: refuses a failed batch and an unconfirmed extra-review row; appends on success', () => {
    const base = { batch: 6, ids: ['anc-025', 'anc-030'], shas: { 'anc-025': 'a', 'anc-030': 'b' }, extraReview: ['anc-025'], at: 't' };
    assert.match(recordIntake(null, { ...base, bad: 2, confirmed: ['anc-025'] }).errors.join(), /did not pass intake/);
    assert.match(recordIntake(null, { ...base, bad: 0, confirmed: [] }).errors.join(), /anc-025 is extra_review/);
    assert.match(recordIntake(null, { ...base, bad: 0, confirmed: ['anc-025', 'anc-030'] }).errors.join(), /not an extra_review row/);
    const ok = recordIntake({ entries: [] }, { ...base, bad: 0, confirmed: ['anc-025'] });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(intakeAccepted(ok.log), { 'anc-025': 'a', 'anc-030': 'b' });
    // A later re-record (a pre-lock fix) supersedes the earlier sha.
    const again = recordIntake(ok.log, { ...base, shas: { 'anc-025': 'a2', 'anc-030': 'b' }, bad: 0, confirmed: ['anc-025'] });
    assert.equal(intakeAccepted(again.log)['anc-025'], 'a2');
  });

  test('updateHeldOutLock locks only bytes that passed intake; anything else held-out is unrecorded', () => {
    const split = { seed: 1, held_out: ['anc-050', 'anc-051', 'anc-052'], tuning: ['anc-053'] };
    const r = (id, sha) => ({ id, sha256: sha });
    const res = [r('anc-050', 'a'), r('anc-051', 'b'), r('anc-052', 'c'), r('anc-053', 'd')];
    const out = updateHeldOutLock(split, null, res, { 'anc-050': 'a', 'anc-051': 'OLD' });
    assert.deepEqual(out.added, ['anc-050']);
    assert.deepEqual(out.unrecorded.sort(), ['anc-051', 'anc-052']);
    assert.deepEqual(Object.keys(out.lock.locked), ['anc-050']);
  });

  test('validate.mjs --record-batch refuses a batch that has not passed intake and writes nothing', async (t) => {
    // Any batch not yet recorded whose fixtures are not all written (it used to be batch 6, until batch 6
    // was written). Once every batch is recorded there is nothing left to refuse.
    const plan = JSON.parse(await readFile(BATCHES_PATH, 'utf8'));
    const recorded = new Set((await loadIntakeLog()).entries.map((e) => e.batch));
    const exists = async (id) => readFile(path.join(HERE, 'fixtures', `${id}.json`)).then(() => true, () => false);
    let n = null;
    for (const b of plan.batches) {
      if (recorded.has(b.batch)) continue;
      if ((await Promise.all(b.rows.map((r) => exists(r.id)))).includes(false)) { n = b.batch; break; }
    }
    if (n == null) { t.skip('every batch is written or recorded'); return; }
    const before = await readFile(path.join(HERE, 'intake-log.json'), 'utf8').catch(() => null);
    let failed = false;
    try { execFileSync(process.execPath, [path.join(HERE, 'validate.mjs'), '--record-batch', String(n)], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { failed = true; assert.match(String(e.stderr), /did not pass intake/); }
    assert.ok(failed, `batch ${n} was accepted`);
    assert.equal(await readFile(path.join(HERE, 'intake-log.json'), 'utf8').catch(() => null), before, 'intake-log.json changed');
  });

  test('updateHeldOutLock adds new held-out fixtures, ignores tuning, and reports a changed locked sha', () => {
    const split = { seed: 1, held_out: ['anc-050', 'anc-051'], tuning: ['anc-052'] };
    const r = (id, sha) => ({ id, sha256: sha });
    const first = updateHeldOutLock(split, null, [r('anc-050', 'a'), r('anc-052', 'c')], { 'anc-050': 'a' });
    assert.deepEqual(first.added, ['anc-050']);
    assert.deepEqual(first.lock.locked, { 'anc-050': 'a' });
    const again = updateHeldOutLock(split, first.lock, [r('anc-050', 'CHANGED'), r('anc-051', 'b')], { 'anc-051': 'b' });
    assert.deepEqual(again.changed, ['anc-050']);
    assert.deepEqual(again.added, ['anc-051']);
    assert.equal(updateHeldOutLock(null, null, [r('anc-050', 'a')]).added.length, 0);
  });

  test('assertHeldOutScorable: refuses any held-out id until all are locked, then only the locked bytes', () => {
    const split = { held_out: ['anc-050', 'anc-051'], tuning: ['anc-052'] };
    assert.doesNotThrow(() => assertHeldOutScorable(['anc-052'], { split, lock: null }));
    assert.throws(() => assertHeldOutScorable(['anc-052', 'anc-050'], { split, lock: { locked: { 'anc-050': 'a' } } }), /only 1 of 2/);
    const lock = { locked: { 'anc-050': 'a', 'anc-051': 'b' } };
    assert.ok(lockComplete(split, lock));
    assert.doesNotThrow(() => assertHeldOutScorable(['anc-050'], { split, lock, fixtureShas: { 'anc-050': 'a' } }));
    assert.throws(() => assertHeldOutScorable(['anc-050'], { split, lock, fixtureShas: { 'anc-050': 'z' } }), /locked bytes/);
  });

  test('while the lock is incomplete, no committed run or panel record holds a held-out score', async () => {
    const split = await loadAnchorSplit();
    if (lockComplete(split, await loadHeldOutLock())) return;
    const held = new Set(split.held_out);
    for (const f of (await readdir(path.join(HERE, 'runs'))).filter((x) => x.endsWith('.json'))) {
      const doc = JSON.parse(await readFile(path.join(HERE, 'runs', f), 'utf8'));
      for (const row of doc.rows ?? []) assert.ok(!held.has(row.id), `runs/${f} scores held-out ${row.id} before the lock is complete`);
    }
    // Panel packets (keys, rater files) may live anywhere: scan every committed file under anchors/
    // except the design-level records that list ids by construction.
    const ALLOWED = new Set(['fixtures', 'planted', 'design.json', 'batches.json', 'BATCH-PLAN.md', 'SPLIT-anchors.json',
      'HELDOUT-LOCK.json', 'intake-log.json', 'manifest.json', 'anchors.test.mjs']);
    const walk = async (dir, rel = '') => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (!rel && ALLOWED.has(ent.name)) continue;
        if (ent.isDirectory()) { await walk(path.join(dir, ent.name), r); continue; }
        if (!/\.(json|txt|md|csv)$/.test(ent.name)) continue;      // data and reports; code names ids in comments
        const text = await readFile(path.join(dir, ent.name), 'utf8');
        for (const id of held) assert.ok(!text.includes(id), `${r} names held-out ${id} before the lock is complete (a panel packet or score?)`);
      }
    };
    await walk(HERE);
  });

  test('no held-out id is named in any document an author reads', async () => {
    const split = await loadAnchorSplit();
    const docs = await readFile(path.join(HERE, 'AUTHORING.md'), 'utf8') + await readFile(BRIEF_PATH, 'utf8');
    for (const id of split.held_out) assert.ok(!docs.includes(id), `${id} (held-out) is named in AUTHORING.md or AUTHOR-BRIEF.md`);
  });

  test('extra-review rows: exactly the d4 <= 1 / d5 >= 4 rows, last in their batch', () => {
    const plan = planBatches(design);
    for (const b of plan.batches) {
      b.rows.forEach((r, i) => {
        assert.equal(Boolean(r.extra_review), needsExtraReview(r), r.id);
        if (r.extra_review) assert.ok(b.rows.slice(i).every((x) => x.extra_review), `${r.id} is not last in batch ${b.batch}`);
      });
    }
  });

  test('pilot-style length drift fails the simulated cue gate (the documented 96%)', async () => {
    // The documented 96% is the PLAN's property: the pilot as written plus all 80 planned rows drifting.
    // Since the simulation skips rows already written, pass only the pilot, or a nearly finished
    // cohort would leave too few simulated rows for the drift to show.
    const { results } = await validateAll();
    const existing = results.filter((r) => r.features && r.row && !r.row.excluded && r.row.pilot).map((r) => ({ id: r.id, row: r.row, features: r.features }));
    const sim = simulateCueGate(planBatches(design), existing, { sims: 100, cueCheck, lengthDrift: 5 });
    assert.ok(sim.fail_rate >= 0.8, `drift 5 fails only ${sim.fail_rate}`);
  });

  test('the tutor prompt is pinned: the pin is self-consistent and the brief carries it verbatim', async () => {
    const pin = JSON.parse(await readFile(PIN_PATH, 'utf8'));
    const { promptLabel } = require('../../../rimpl/src/lib/versions.js');
    const brief = await readFile(BRIEF_PATH, 'utf8');
    for (const m of ['natural', 'examiner']) {
      assert.equal(pin[m].prompt_version, promptLabel('chat', pin[m].text), `${m}: version does not match its text`);
      assert.ok(brief.includes(pin[m].prompt_version) && brief.includes(pin[m].text), `${m}: brief does not carry the pinned prompt`);
    }
  });
});

describe('anchor-split.mjs --check-scorable reads every id', () => {
  test('takes space-separated, comma-separated and mixed ids, stopping at the next flag', () => {
    assert.deepEqual(scorableIdsArg(['--check-scorable', 'anc-001', 'anc-002']), ['anc-001', 'anc-002']);
    assert.deepEqual(scorableIdsArg(['--check-scorable', 'anc-001,anc-002', 'anc-003']), ['anc-001', 'anc-002', 'anc-003']);
    assert.deepEqual(scorableIdsArg(['--check-scorable', 'anc-001', '--x', 'anc-009']), ['anc-001']);
    assert.deepEqual(scorableIdsArg(['--check-scorable']), []);
  });
  test('the CLI refuses a held-out id given as a later space-separated argument', async () => {
    const split = await loadAnchorSplit();
    const lock = await loadHeldOutLock();
    if (!split || lockComplete(split, lock)) return;   // only meaningful while the lock is incomplete
    const tuning = split.tuning[0], held = split.held_out[0];
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('./anchor-split.mjs', import.meta.url)), '--check-scorable', tuning, held]);
    assert.equal(r.status, 1, r.stdout.toString() + r.stderr.toString());
  });
  test('the CLI refuses an empty id list', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('./anchor-split.mjs', import.meta.url)), '--check-scorable']);
    assert.equal(r.status, 2);
  });
});

describe('batch-plan.mjs — a §7.4 replacement never reshuffles the plan', () => {
  const slotOf = (design, id) => { let a = design.anchors.find((x) => x.id === id); while (a?.replaces) a = design.anchors.find((x) => x.id === a.replaces); return a.id; };
  const slots = (design) => planBatches(design).batches.flatMap((b) => b.rows.map((r) => [slotOf(design, r.id), { batch: b.batch, id: r.id, budget: JSON.stringify(r.cue_budget) }]));
  test('every slot keeps its batch and cue budget; only a replaced slot changes id', () => {
    const before = new Map(slots(generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED, replacements: [] })));
    const after = new Map(slots(generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED })));
    assert.equal(after.size, before.size);
    const replaced = new Map(REPLACEMENTS.map((r) => [r.excluded, r.replaced_by]));
    for (const [slot, b] of before) {
      const a = after.get(slot);
      assert.ok(a, `slot ${slot} disappeared`);
      assert.equal(a.batch, b.batch, `slot ${slot} moved batch`);
      assert.equal(a.budget, b.budget, `slot ${slot} changed cue budget`);
      assert.equal(a.id, replaced.get(slot) ?? slot);
    }
  });
  test('a chained replacement (a replacement later excluded itself) lands on the last holder', () => {
    const base = generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED, replacements: [] });
    const slot = base.anchors.find((a) => !a.pilot).id;
    const chain = [
      { excluded: slot, replaced_by: 'anc-101', date: 'x', reason: 'x', archived_fixture: 'x', sha256: 'x' },
      { excluded: 'anc-101', replaced_by: 'anc-102', date: 'x', reason: 'x', archived_fixture: 'x', sha256: 'x' },
    ];
    const design = applyReplacements(base, chain);
    const ids = planBatches(design).batches.flatMap((b) => b.rows.map((r) => r.id));
    assert.ok(ids.includes('anc-102') && !ids.includes('anc-101') && !ids.includes(slot));
    assert.equal(slotOf(design, 'anc-102'), slot);
  });
});

describe('checkSplit — a §7.4 exclusion after the reservation', () => {
  const base = generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED, replacements: [] });
  const [t, h] = base.anchors.filter((a) => !a.pilot).map((a) => a.id);
  const rep = (excluded) => [{ excluded, replaced_by: 'anc-101', date: 'x', reason: 'x', archived_fixture: 'x', sha256: 'x' }];
  test('a tuning anchor excluded later stays listed; its replacement inherits tuning', () => {
    const design = applyReplacements(base, rep(t));
    assert.deepEqual(checkSplit(design, { held_out: [h], tuning: [t] }), []);
    assert.ok(splitFilter(design, { held_out: [h], tuning: [t] }, 'tuning').has('anc-101'));
  });
  test('a held-out anchor that was excluded is an error', () => {
    const design = applyReplacements(base, rep(h));
    assert.match(checkSplit(design, { held_out: [h], tuning: [t] }).join('\n'), /never excluded/);
  });
  test('a replacement listed as held-out while its predecessor is tuning is an error', () => {
    const design = applyReplacements(base, rep(t));
    assert.match(checkSplit(design, { held_out: ['anc-101'], tuning: [t] }).join('\n'), /listed as held-out/);
  });
});

describe('batch-plan.mjs — per-row length targets', () => {
  const rows = planBatches(generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED })).batches.flatMap((b) => b.rows);
  test('every row has a length_chars target inside its bin', () => {
    for (const r of rows) {
      const [lo, hi] = BUDGET_RANGES.length[r.cue_budget.length];
      assert.ok(r.cue_budget.length_chars >= lo && r.cue_budget.length_chars <= hi, `${r.id}: ${r.cue_budget.length_chars} outside ${lo}–${hi}`);
    }
  });
  test('the length targets do not track the composite target', () => {
    const xs = rows.map((r) => [r.target_composite, r.cue_budget.length_chars]);
    const m = (k) => xs.reduce((s, x) => s + x[k], 0) / xs.length;
    const [mt, ml] = [m(0), m(1)];
    let a = 0, b = 0, c = 0;
    for (const [t, l] of xs) { a += (t - mt) * (l - ml); b += (t - mt) ** 2; c += (l - ml) ** 2; }
    assert.ok(Math.abs(a / Math.sqrt(b * c)) < 0.15, `r = ${(a / Math.sqrt(b * c)).toFixed(3)}`);
  });
  test('intake returns a fixture inside its bin but off its length target', () => {
    const b = { length: 'short', length_chars: 1000, ack_turns: 0, numerals: 'few', list_lines: 0, rubric_echo: 0 };
    const f = (len) => ({ length: len, acks: 0, numbers: 0, list_lines: 0, rubric_echo: 0, echo_hits: {} });
    assert.deepEqual(checkBudget(f(1000 + LENGTH_CHARS_TOL), 4, b), []);
    assert.match(checkBudget(f(1000 + LENGTH_CHARS_TOL + 1), 4, b).join(), /target 1000/);
    assert.match(checkBudget(f(1000 - LENGTH_CHARS_TOL - 1), 4, b).join(), /target 1000/);
    assert.deepEqual(checkBudget(f(1200), 4, { ...b, length_chars: undefined }), []);   // a row without one: bin only
  });
});

describe('§7 amendment item 11 — a row excluded as not writable', () => {
  const base = generateDesign({ n: DEFAULT_N, seed: DEFAULT_SEED, replacements: [] });
  const slot = base.anchors.find((a) => !a.pilot).id;
  const x = { date: 'x', reason: 'x', archived_fixture: 'x', sha256: 'x' };
  const design = applyReplacements(base, [{ excluded: slot, replaced_by: 'anc-101', ...x }, { excluded: 'anc-101', replaced_by: null, ...x }]);
  test('is excluded with no replacement and consumes no id', () => {
    assert.equal(design.anchors.find((a) => a.id === 'anc-101').excluded.replaced_by, null);
    assert.ok(!design.anchors.some((a) => a.id === 'anc-102'));
    assert.ok(!checkInvariants(design).some((e) => /replaced exactly once|not writable/.test(e)), checkInvariants(design).join('\n'));
  });
  test('drops its slot from the plan and moves nothing else', () => {
    const plan = (d) => new Map(planBatches(d).batches.flatMap((b) => b.rows.map((r) => [r.id, `${b.batch} ${JSON.stringify(r.cue_budget)}`])));
    const before = plan(base), after = plan(design);
    assert.ok(!after.has(slot) && !after.has('anc-101'));
    for (const [id, v] of after) assert.equal(v, before.get(id), id);
    assert.equal(after.size, before.size - 1);
  });
});

describe('length targets and batches accepted before them', () => {
  test('re-running intake on an accepted pre-rule batch never asks for a locked anchor back', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = fileURLToPath(new URL('./validate.mjs', import.meta.url));
    const log = await loadIntakeLog();
    for (const b of LENGTH_TARGET_EXEMPT_BATCHES) {
      if (!log.entries.some((e) => e.batch === b)) continue;
      const out = execFileSync(process.execPath, [script, '--batch', String(b)], { encoding: 'utf8' });
      assert.doesNotMatch(out, /RETURN/, `batch ${b}`);
    }
  });
});
