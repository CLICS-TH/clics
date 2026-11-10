// The calibration's counting and refusal rules (#387), with a stub embedder: no model, no npm install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pairProblems, calibrate, recordOf, exitCode, format, KINDS, LANGS, sha256 } from './reply-cache-calibration-lib.mjs';

const require = createRequire(import.meta.url);
const guards = require('../../rimpl/src/lib/booth-cache.js');

const unit = (i) => Array.from({ length: 16 }, (_, k) => (k === i ? 1 : 0));
const at = (c) => unit(0).map((_, k) => (k === 0 ? c : k === 1 ? Math.sqrt(1 - c * c) : 0));
/** An embedder that gives each text the vector the test chose. */
const stub = (vectors) => async (text) => vectors[text] ?? unit(9);
const pair = (id, kind, a, b, lang = 'en') => ({ id, lang, kind, a, b, note: 'test' });

test('a negated pair above the threshold is not reused, which the bare threshold would reuse', async () => {
  const pairs = [pair('neg', 'negated', 'start insulin', "don't start insulin")];
  const report = await calibrate(pairs, { embed: stub({ 'start insulin': unit(0), "don't start insulin": at(0.97) }), model: 'm' });
  assert.equal(report.unsafe_reuses, 0);
  assert.equal(report.bare_unsafe_reuses, 1);
  assert.deepEqual(report.bare_unsafe.map((r) => r.id), ['neg']);
  assert.equal(exitCode(report), 0);
});

test('a same-meaning pair at the threshold or above is reused; below it is not', async () => {
  const pairs = [pair('close', 'same', 'start insulin', 'start  insulin'), pair('far', 'same', 'give fluids', 'give  fluids')];
  const vectors = { 'start insulin': unit(0), 'start  insulin': at(0.96), 'give fluids': unit(0), 'give  fluids': at(0.94) };
  const report = await calibrate(pairs, { embed: stub(vectors), model: 'm' });
  assert.deepEqual(report.rows.map((r) => [r.id, r.reused]), [['close', true], ['far', false]]);
  assert.equal(report.same_reuse_rate, 0.5);
});

test('an unsafe pair the guards cannot tell apart is an unsafe reuse: exit 1, listed with its cosine, and no record', async () => {
  const pairs = [pair('drug', 'unsafe', 'give atropine IV', 'give adrenaline IV')];
  const report = await calibrate(pairs, { embed: stub({ 'give atropine IV': unit(0), 'give adrenaline IV': at(0.98) }), model: 'm' });
  assert.equal(report.unsafe_reuses, 1);
  assert.equal(report.unsafe[0].id, 'drug');
  assert.ok(Math.abs(report.unsafe[0].cosine - 0.98) < 1e-9);
  assert.equal(exitCode(report), 1);
  assert.throws(() => recordOf(report, '[]', '2026-11-10'), /1 unsafe reuse/);
  assert.match(format(report), /UNSAFE REUSES 1\n {2}drug {2}cosine 0\.9800/);
});

test('both directions are tried, and a dose change is never reused even at cosine 1', async () => {
  const pairs = [pair('dose', 'unsafe', 'doxycycline 100 mg', 'doxycycline 1000 mg')];
  const report = await calibrate(pairs, { embed: stub({}), model: 'm' });
  assert.equal(report.rows[0].cosine, 1);
  assert.equal(report.rows[0].reused, false);
  assert.equal(report.unsafe_reuses, 0);
});

test('answers are embedded and cued from their de-identified text', async () => {
  const seen = [];
  const pairs = [pair('p', 'same', 'call Somchai', 'call  Somchai')];
  await calibrate(pairs, { embed: async (t) => { seen.push(t); return unit(0); }, deidentify: (t) => t.replace('Somchai', '[NAME-1]'), model: 'm' });
  assert.deepEqual(seen, ['call [NAME-1]', 'call  [NAME-1]']);
});

test('the record binds the model, the threshold, the guard source and the pairs, and counts zero unsafe reuses', async () => {
  const text = JSON.stringify([pair('p', 'same', 'a', 'a ')]);
  const report = await calibrate(JSON.parse(text), { embed: stub({}), model: 'm@1:q8' });
  const record = recordOf(report, text, '2026-11-10');
  assert.deepEqual(
    { model: record.model, threshold: record.threshold, guard_sha: record.guard_sha, pairs_sha: record.pairs_sha, unsafe_reuses: record.unsafe_reuses },
    { model: 'm@1:q8', threshold: guards.THRESHOLD, guard_sha: guards.guardSha(), pairs_sha: sha256(text), unsafe_reuses: 0 },
  );
});

test('a malformed pair set is named line by line', () => {
  assert.deepEqual(pairProblems([]), ['the pair set is not a non-empty array']);
  const problems = pairProblems([pair('x', 'similar', 'a', ''), pair('x', 'same', 'a', 'b', 'fr')]);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /kind must be/);
  assert.match(problems.join('\n'), /b must be 1-500/);
  assert.match(problems.join('\n'), /lang must be/);
  assert.match(problems.join('\n'), /duplicate id/);
});

test('the committed pair set is well formed and covers every kind in both languages', () => {
  const pairs = JSON.parse(readFileSync(new URL('./reply-cache-pairs.json', import.meta.url), 'utf8'));
  assert.deepEqual(pairProblems(pairs), []);
  for (const kind of KINDS) for (const lang of LANGS) {
    assert.ok(pairs.filter((p) => p.kind === kind && p.lang === lang).length >= 8, `${lang} ${kind} has at least 8 pairs`);
  }
});
