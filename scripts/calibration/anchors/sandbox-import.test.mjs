// Hermetic tests for the anchor → SANDBOX import (plan item 2.7): sandbox-import-lib.mjs, and the
// import-sandbox.mjs / import-shadow.mjs CLIs in DRY-RUN only. No DB, no network, no AI — the CLI
// subprocesses run with every Supabase variable blanked, so a dry run that tried to connect fails.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  uuidv5, anchorPleId, ANCHOR_NAMESPACE, splitReflection, renderReflection, REFLECTION_HEADINGS,
  planAnchor, planImport, importManifest, mergeImportManifests, readImportManifest, verifyFixtureBytes, assertSandboxCouncil,
  medianInt, planShadow, slotIndex, PROVIDER_USED, BASE_TIME, DOMAINS,
} from './sandbox-import-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);
const { compositeOf } = require('../../../rimpl/src/lib/composite.js');
const { modelVersion } = require('../../../rimpl/src/lib/versions.js');

const PHYS = '11111111-1111-4111-8111-111111111111';
const COUNCIL = '22222222-2222-4222-8222-222222222222';
const SANDBOX = { id: COUNCIL, code: 'SANDBOX', name_en: 'Sandbox Council' };
const design = JSON.parse(await readFile(path.join(HERE, 'design.json'), 'utf8'));
const designIds = design.anchors.map((a) => a.id);
const manifest = JSON.parse(await readFile(path.join(HERE, 'manifest.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(HERE, 'HELDOUT-LOCK.json'), 'utf8'));
const split = JSON.parse(await readFile(path.join(HERE, 'SPLIT-anchors.json'), 'utf8'));

async function fixture(id) {
  const buf = await readFile(path.join(HERE, 'fixtures', `${id}.json`));
  return { id, buf, sha256: createHash('sha256').update(buf).digest('hex'), doc: JSON.parse(buf.toString('utf8')) };
}
const synthetic = (id, transcript) => ({ id, sha256: 'x'.repeat(64), doc: { ple_id: id, patient_ref: null, transcript } });

describe('UUIDv5', () => {
  test('matches the RFC 4122 / Python uuid5 reference vector', () => {
    // uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.com')
    assert.equal(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
  test('an anchor id always maps to the same version-5 PLE id, and distinct anchors to distinct ids', () => {
    assert.equal(anchorPleId('anc-021'), anchorPleId('anc-021'));
    assert.equal(anchorPleId('anc-021'), uuidv5('anc-021', ANCHOR_NAMESPACE));
    assert.match(anchorPleId('anc-021'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const all = new Set(designIds.map(anchorPleId));
    assert.equal(all.size, designIds.length);
  });
  test('the namespace is pinned (changing it would orphan every imported row)', () => {
    assert.equal(ANCHOR_NAMESPACE, '823151ec-4b0c-4bef-af46-1a6bf12c8804');
    assert.equal(anchorPleId('anc-021'), '0a29f28a-55bd-5c3c-9f9d-f328f838aab1');
  });
});

describe('fixture → rows', () => {
  test('messages: physician/assistant only, fixture order, strictly increasing created_at inside the session', async () => {
    const fx = await fixture('anc-001');
    const a = planAnchor(fx, { physicianId: PHYS, councilId: COUNCIL, slot: 0, baseMs: Date.parse(BASE_TIME) });
    const chat = fx.doc.transcript.filter((t) => t.role !== 'reflection');
    assert.deepEqual(a.messages.map((m) => [m.role, m.content]), chat.map((t) => [t.role, t.content]));
    assert.ok(a.messages.every((m) => m.role === 'physician' || m.role === 'assistant'));
    assert.ok(a.messages.every((m) => m.ple_id === a.ple_id));
    const ts = a.messages.map((m) => Date.parse(m.created_at));
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], `created_at not strictly increasing at ${i}`);
    assert.ok(ts[0] > Date.parse(a.ple.started_at));
    assert.ok(ts.at(-1) < Date.parse(a.ple.ended_at));
    assert.equal(a.ple.turn_count, chat.filter((t) => t.role === 'physician').length);
  });

  test('the ples row is a pending, test, synthetic, evaluated SANDBOX session — never cleared', async () => {
    const a = planAnchor(await fixture('anc-022'), { physicianId: PHYS, councilId: COUNCIL, slot: 3, baseMs: Date.parse(BASE_TIME) });
    assert.equal(a.ple.id, anchorPleId('anc-022'));
    assert.deepEqual(
      { is_test: a.ple.is_test, status: a.ple.status, specialty_id: a.ple.specialty_id, token_count: a.ple.token_count, ple_code: a.ple.ple_code,
        provider_used: a.ple.provider_used, privacy_review_status: a.ple.privacy_review_status, privacy_concern_open: a.ple.privacy_concern_open,
        physician_id: a.ple.physician_id, council_id: a.ple.council_id },
      { is_test: true, status: 'evaluated', specialty_id: null, token_count: 0, ple_code: null, provider_used: PROVIDER_USED,
        privacy_review_status: 'pending', privacy_concern_open: false, physician_id: PHYS, council_id: COUNCIL });
  });

  test('queue order (ended_at asc) is not anchor order, and timestamps do not depend on the selection', async () => {
    const ids = split.held_out.slice(0, 12);
    const fxs = await Promise.all(ids.map(fixture));
    const full = planImport({ fixtures: fxs, designIds, physicianId: PHYS, councilId: COUNCIL });
    assert.notDeepEqual(full.queue_order, [...ids].sort());
    const one = planImport({ fixtures: [fxs[5]], designIds, physicianId: PHYS, councilId: COUNCIL });
    assert.deepEqual(one.anchors[0].ple, full.anchors[5].ple);
    assert.deepEqual(one.anchors[0].messages, full.anchors[5].messages);
    // No two sessions overlap (one physician account owns them all).
    const spans = full.anchors.map((a) => [Date.parse(a.ple.started_at), Date.parse(a.ple.ended_at)]).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] > spans[i - 1][1]);
    assert.equal(slotIndex(designIds).size, designIds.length);
  });

  test('refuses a turn role messages cannot hold', () => {
    assert.throws(() => planAnchor(synthetic('anc-001', [{ role: 'system', content: 'x' }]), { physicianId: PHYS, councilId: COUNCIL, slot: 0, baseMs: 0 }), /physician\|assistant only/);
  });
});

describe('reflection split', () => {
  test('the headings are production\'s, verbatim (backend/src/services/reflection.js)', async () => {
    const src = await readFile(path.join(REPO, 'backend', 'src', 'services', 'reflection.js'), 'utf8');
    for (const h of Object.values(REFLECTION_HEADINGS)) assert.ok(src.includes(`\`${h}\\n\${`), `heading drifted from reflection.js: ${h}`);
  });

  test('a full three-section reflection round-trips into the three columns', async () => {
    const fx = await fixture('anc-001');
    const turn = fx.doc.transcript.at(-1);
    assert.equal(turn.role, 'reflection');
    const r = splitReflection(turn.content);
    assert.ok(r.ok, r.reason);
    assert.ok(r.columns.learned && r.columns.uncertainty && r.columns.application);
    assert.equal(renderReflection(r.columns), turn.content);
    const a = planAnchor(fx, { physicianId: PHYS, councilId: COUNCIL, slot: 0, baseMs: Date.parse(BASE_TIME) });
    assert.equal(a.reflection.ple_id, a.ple_id);
    assert.equal(a.reflection.skipped, false);
    assert.ok(Date.parse(a.reflection.submitted_at) > Date.parse(a.ple.ended_at));
  });

  test('a deliberately thin reflection keeps its missing sections NULL, as production stores them', async () => {
    const turn = (await fixture('anc-003')).doc.transcript.at(-1);
    const r = splitReflection(turn.content);
    assert.ok(r.ok, r.reason);
    assert.equal(r.columns.uncertainty, null);
    assert.equal(r.columns.application, null);
    assert.equal(renderReflection(r.columns), turn.content);
  });

  test('non-splitting reflections are refused with a reason', () => {
    const [L, U, A] = Object.values(REFLECTION_HEADINGS);
    const cases = [
      ['I learned a lot.', /none of the three headings/],
      [`Preamble\n${L}\nx`, /text before the first heading/],
      [`${U}\nx\n\n${L}\ny`, /out of production order/],
      [`${L}\nx\n\n${L}\ny`, /appears twice/],
      [`${L}\nx\n${U}\ny`, /blank line/],
      [`${L} x`, /no newline/],
      [`${L}\n\n\n${A}\ny`, /empty section/],
    ];
    for (const [content, why] of cases) {
      const r = splitReflection(content);
      assert.equal(r.ok, false, content);
      assert.match(r.reason, why, content);
    }
  });

  test('an anchor without a usable reflection gets NO reflection row and is listed, not dropped', async () => {
    const [L] = Object.values(REFLECTION_HEADINGS);
    const fxs = [
      await fixture('anc-021'),                                  // held-out, reflection in chat: no turn
      synthetic('anc-002', [{ role: 'physician', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'reflection', content: 'free text, no headings' }]),
      synthetic('anc-004', [{ role: 'physician', content: 'q' }, { role: 'reflection', content: `${L}\nx` }, { role: 'assistant', content: 'a' }]),
    ];
    const plan = planImport({ fixtures: fxs, designIds, physicianId: PHYS, councilId: COUNCIL });
    assert.equal(plan.counts.ples, 3);
    assert.equal(plan.counts.reflections, 0);
    assert.deepEqual(plan.no_reflection.map((r) => r.id), ['anc-021', 'anc-002', 'anc-004']);
    assert.match(plan.no_reflection[0].reason, /no reflection turn/);
    assert.match(plan.no_reflection[1].reason, /none of the three headings/);
    assert.match(plan.no_reflection[2].reason, /not the last turn/);
    // The PLE and its messages are still planned.
    assert.ok(plan.anchors.every((a) => a.messages.length >= 1 && a.reflection === null));
  });
});

describe('integrity refusals', () => {
  test('a tampered fixture is refused against manifest.json', async () => {
    const fx = await fixture('anc-022');
    const bad = Buffer.from(fx.buf.toString('utf8').replace('"assistant"', '"assistant" '));
    assert.throws(() => verifyFixtureBytes('anc-022', bad, { manifest, lock, heldOut: true }), /changed since validation/);
    assert.equal(verifyFixtureBytes('anc-022', fx.buf, { manifest, lock, heldOut: true }), fx.sha256);
  });

  test('a held-out fixture whose manifest entry was re-validated but whose LOCK did not move is refused', async () => {
    const fx = await fixture('anc-022');
    const bad = Buffer.from(fx.buf.toString('utf8') + '\n');
    const sha = createHash('sha256').update(bad).digest('hex');
    const m2 = { fixtures: { ...manifest.fixtures, 'anc-022': { ...manifest.fixtures['anc-022'], sha256: sha } } };
    assert.throws(() => verifyFixtureBytes('anc-022', bad, { manifest: m2, lock, heldOut: true }), /locked bytes/);
    assert.doesNotThrow(() => verifyFixtureBytes('anc-022', bad, { manifest: m2, lock, heldOut: false }));
  });

  test('the planner refuses any council that is not SANDBOX', async () => {
    const fxs = [await fixture('anc-022')];
    const tmc = { id: COUNCIL, code: 'TMC', name_en: 'Medical Council' };
    assert.throws(() => planImport({ fixtures: fxs, designIds, physicianId: PHYS, councilId: COUNCIL, council: tmc }), /not SANDBOX/);
    assert.throws(() => planImport({ fixtures: fxs, designIds, physicianId: PHYS, councilId: COUNCIL, council: null }), /does not exist/);
    assert.throws(() => assertSandboxCouncil({ ...SANDBOX, id: PHYS }, COUNCIL), /is not/);
    assert.doesNotThrow(() => planImport({ fixtures: fxs, designIds, physicianId: PHYS, councilId: COUNCIL, council: SANDBOX }));
  });

  test('ids must be UUIDs', async () => {
    const fxs = [await fixture('anc-022')];
    assert.throws(() => planImport({ fixtures: fxs, designIds, physicianId: 'P-001', councilId: COUNCIL }), /physician-id/);
    assert.throws(() => planImport({ fixtures: fxs, designIds, physicianId: PHYS, councilId: 'SANDBOX' }), /council-id/);
  });

  test('a hand-edited import manifest is refused', async () => {
    const plan = planImport({ fixtures: [await fixture('anc-022')], designIds, physicianId: PHYS, councilId: COUNCIL });
    const doc = importManifest(plan, { split: 'heldout', physicianId: PHYS, councilId: COUNCIL });
    assert.deepEqual(doc.ple_ids, [anchorPleId('anc-022')]);
    assert.deepEqual(readImportManifest(doc), [{ id: 'anc-022', ple_id: anchorPleId('anc-022') }]);
    doc.anchors['anc-022'].ple_id = PHYS;
    assert.throws(() => readImportManifest(doc), /hand-edited/);
  });

  test('an --only top-up merges into the existing manifest instead of shrinking it', async () => {
    const mk = async (ids, opts = {}) => importManifest(
      planImport({ fixtures: await Promise.all(ids.map(fixture)), designIds, physicianId: PHYS, councilId: COUNCIL }),
      { split: 'heldout', physicianId: PHYS, councilId: COUNCIL, ...opts });
    const first = await mk(['anc-022', 'anc-025']);
    const merged = mergeImportManifests(first, await mk(['anc-028']));
    assert.deepEqual(Object.keys(merged.anchors), ['anc-022', 'anc-025', 'anc-028']);
    assert.deepEqual(merged.ple_ids, ['anc-022', 'anc-025', 'anc-028'].map(anchorPleId));
    assert.deepEqual(mergeImportManifests(null, first), first);
    const other = await mk(['anc-028'], { councilId: PHYS });
    assert.throws(() => mergeImportManifests(first, other), /council_id/);
    const drift = await mk(['anc-022']);
    drift.anchors['anc-022'].sha256 = 'f'.repeat(64);
    assert.throws(() => mergeImportManifests(first, drift), /different fixture bytes/);
  });
});

describe('shadow rows: per-domain median of K', () => {
  test('medianInt', () => {
    assert.equal(medianInt([3, 5, 4]), 4);
    assert.equal(medianInt([2]), 2);
    assert.equal(medianInt([1, 1, 5, 5, 3]), 3);
    assert.throws(() => medianInt([3, 4]), /odd/);
    assert.throws(() => medianInt([]), /odd/);
  });

  const row = (id, run, v, extra = {}) => ({ id, run, scores: v && Object.fromEntries(DOMAINS.map((d, i) => [d, v[i]])), model: 'm-x', ...extra });
  const baseRun = (rows, fixtures) => ({
    probe: 'anchors-score-local', model: 'm-x', prompt_version_used: 'pis7-prompt-aaaa+local-bbbb', rubric_version: 'pis7-weights-cccc',
    consistency: 'off', repeats: 3, started_at: '2026-10-02T09:00:00.000Z', finished_at: '2026-10-02T10:00:00.000Z', fixtures, rows,
  });
  const anchors = ['anc-a', 'anc-b', 'anc-c', 'anc-d', 'anc-e'].map((id) => ({ id, ple_id: anchorPleId(id) }));
  const shas = { 'anc-a': 'sa', 'anc-b': 'sb', 'anc-c': 'sc', 'anc-d': 'sd', 'anc-e': 'se' };

  test('maps each anchor to one row: medians, production composite, production model_version, provenance', () => {
    const run = baseRun([
      row('anc-a', 1, [1, 2, 3, 4, 5, 0, 1]), row('anc-a', 2, [3, 2, 1, 4, 5, 2, 1]), row('anc-a', 3, [2, 2, 2, 3, 4, 1, 5]),
      row('anc-b', 1, [4, 4, 4, 4, 4, 4, 4]), row('anc-b', 2, [4, 4, 4, 4, 4, 4, 4]), row('anc-b', 3, null, { error: 'invalid_json' }),
      row('anc-c', 1, [3, 3, 3, 3, 3, 3, 3]), row('anc-c', 2, [3, 3, 3, 3, 3, 3, 3]),
      row('anc-d', 1, [1, 1, 1, 1, 1, 1, 1]),
    ], { 'anc-a': 'sa', 'anc-b': 'sb', 'anc-c': 'sc', 'anc-d': 'DIFFERENT' });
    const p = planShadow({ run, manifestAnchors: anchors, fixtureShas: shas, runFile: 'runs/x.json', runSha: 'f00' });
    assert.equal(p.rows.length, 1);
    const r = p.rows[0];
    const med = { d1: 2, d2: 2, d3: 2, d4: 4, d5: 5, d6: 1, d7: 1 };
    assert.deepEqual(Object.fromEntries(DOMAINS.map((d) => [d, r[d]])), med);
    assert.equal(r.composite_score, compositeOf(med));
    assert.equal(r.ple_id, anchorPleId('anc-a'));
    assert.equal(r.provider, 'local');
    assert.equal(r.model_version, modelVersion('m-x'));
    assert.equal(r.prompt_version, 'pis7-prompt-aaaa+local-bbbb');
    assert.equal(r.rubric_version, 'pis7-weights-cccc');
    assert.equal(r.error, null);
    assert.equal(r.evaluated_at, '2026-10-02T10:00:00.000Z');
    assert.deepEqual(r.domain_rationale.runs, [[1, 2, 3, 4, 5, 0, 1], [3, 2, 1, 4, 5, 2, 1], [2, 2, 2, 3, 4, 1, 5]]);
    assert.equal(r.domain_rationale.run_file_sha256, 'f00');
    assert.deepEqual(p.skipped.map((s) => s.id), ['anc-b', 'anc-c', 'anc-d', 'anc-e']);
    assert.match(p.skipped[0].reason, /unscored/);
    assert.match(p.skipped[1].reason, /even/);
    assert.match(p.skipped[2].reason, /different fixture bytes/);
    assert.match(p.skipped[3].reason, /not in run file/);
  });

  test('refuses a run that mixes served models or is not a score-local run', () => {
    const mixed = baseRun([row('anc-a', 1, [1, 1, 1, 1, 1, 1, 1]), row('anc-a', 2, [1, 1, 1, 1, 1, 1, 1], { model: 'm-y' })], {});
    assert.throws(() => planShadow({ run: mixed, manifestAnchors: anchors, fixtureShas: shas }), /mixes served models/);
    assert.throws(() => planShadow({ run: { probe: 'other' }, manifestAnchors: anchors }), /not a score-local run/);
  });
});

describe('CLIs, dry-run only, with no database configured', () => {
  const env = { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', ANTHROPIC_API_KEY: '', LOCAL_AI_BASE_URL: '', NO_COLOR: '1' };
  const run = (script, args) => {
    try { return { status: 0, out: execFileSync(process.execPath, [path.join(HERE, script), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }; }
    catch (e) { return { status: e.status ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }; }
  };
  const ids = ['--physician-id', PHYS, '--council-id', COUNCIL];

  test('import-sandbox --split heldout plans all 60 held-out anchors and writes nothing', () => {
    const r = run('import-sandbox.mjs', ids);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /split heldout, 60 anchors/);
    assert.match(r.out, /counts: 60 ples · \d+ messages/);
    assert.match(r.out, /DRY RUN — nothing written, no database contacted/);
  });

  test('import-sandbox refuses a tampered held-out fixture before planning', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'anchors-fx-'));
    try {
      await copyFile(path.join(HERE, 'fixtures', 'anc-022.json'), path.join(dir, 'anc-022.json'));
      const ok = run('import-sandbox.mjs', [...ids, '--fixtures', dir, '--only', 'anc-022']);
      assert.equal(ok.status, 0, ok.err);
      const doc = JSON.parse(await readFile(path.join(dir, 'anc-022.json'), 'utf8'));
      doc.transcript[0].content += ' (edited after the lock)';
      await writeFile(path.join(dir, 'anc-022.json'), JSON.stringify(doc, null, 2) + '\n');
      const bad = run('import-sandbox.mjs', [...ids, '--fixtures', dir, '--only', 'anc-022']);
      assert.equal(bad.status, 1);
      assert.match(bad.err, /anc-022 changed since validation/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('import-sandbox requires both ids, and --rollback dry-run deletes nothing', async () => {
    assert.equal(run('import-sandbox.mjs', ['--council-id', COUNCIL]).status, 1);
    const dir = await mkdtemp(path.join(tmpdir(), 'anchors-man-'));
    try {
      const plan = planImport({ fixtures: [await fixture('anc-022')], designIds, physicianId: PHYS, councilId: COUNCIL });
      const file = path.join(dir, 'm.json');
      await writeFile(file, JSON.stringify(importManifest(plan, { split: 'heldout', physicianId: PHYS, councilId: COUNCIL })));
      const r = run('import-sandbox.mjs', ['--rollback', file]);
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /DRY RUN — nothing deleted/);
      assert.match(r.out, new RegExp(anchorPleId('anc-022')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('import-shadow dry-run maps the committed held-out run onto an import manifest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'anchors-sh-'));
    try {
      const fxs = await Promise.all(split.held_out.slice(0, 3).map(fixture));
      const plan = planImport({ fixtures: fxs, designIds, physicianId: PHYS, councilId: COUNCIL });
      const file = path.join(dir, 'm.json');
      await writeFile(file, JSON.stringify(importManifest(plan, { split: 'heldout', physicianId: PHYS, councilId: COUNCIL })));
      const r = run('import-shadow.mjs', [path.join(HERE, 'runs', 'heldout-local-2026-10-02-merged.json'), '--manifest', file]);
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /3 shadow_evaluations row\(s\) · 0 skipped/);
      assert.match(r.out, /DRY RUN — nothing written/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// Keep the fixture dir listing honest: every committed fixture the importer would pick up is in the
// manifest (so a dry run can never be the first place a stray file shows up).
test('every fixture file the importer selects is validated', async () => {
  const files = (await readdir(path.join(HERE, 'fixtures'))).filter((f) => /^anc-\d{3}\.json$/.test(f));
  for (const f of files) {
    const id = f.slice(0, -5);
    if (design.anchors.find((a) => a.id === id)?.excluded) continue;
    assert.ok(manifest.fixtures[id], `${id} missing from manifest.json`);
  }
});
