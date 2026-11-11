// The calibration's counting and refusal rules (#387), with a stub embedder: no model, no npm install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairProblems, calibrate, recordOf, writeRefusal, exitCode, format, KINDS, LANGS, sha256 } from './reply-cache-calibration-lib.mjs';

const require = createRequire(import.meta.url);
const guards = require('../../rimpl/src/lib/booth-cache.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const PAIRS = path.join(here, 'reply-cache-pairs.json');

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

const EVERY_KIND = [pair('s', 'same', 'a', 'a '), pair('n', 'negated', 'give insulin', 'no insulin'), pair('u', 'unsafe', '100 mg', '1000 mg')];

test('the record binds the model, the threshold, the guard source and the pairs, counts each kind, and rimpl takes it', async () => {
  const text = JSON.stringify(EVERY_KIND);
  const report = await calibrate(JSON.parse(text), { embed: stub({}), model: 'm@1:q8' });
  const record = recordOf(report, text, '2026-11-10');
  assert.deepEqual(
    { model: record.model, threshold: record.threshold, guard_sha: record.guard_sha, pairs_sha: record.pairs_sha, unsafe_reuses: record.unsafe_reuses },
    { model: 'm@1:q8', threshold: guards.THRESHOLD, guard_sha: guards.guardSha(), pairs_sha: sha256(text), unsafe_reuses: 0 },
  );
  assert.deepEqual(KINDS.map((k) => record.counts[k].pairs), [1, 1, 1]);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'reply-cache-record-')), 'record.json');
  writeFileSync(file, JSON.stringify(record));
  process.env.BOOTH_CACHE_CALIBRATION_FILE = file;
  try {
    assert.equal(guards.calibrated('m@1:q8'), true);
  } finally {
    delete process.env.BOOTH_CACHE_CALIBRATION_FILE;
  }
});

for (const kind of KINDS) {
  test(`no record from a pair set with no ${kind} pair, even with zero unsafe reuses`, async () => {
    const pairs = EVERY_KIND.filter((p) => p.kind !== kind);
    const report = await calibrate(pairs, { embed: stub({}), model: 'm' });
    assert.equal(report.unsafe_reuses, 0);
    assert.throws(() => recordOf(report, JSON.stringify(pairs), '2026-11-10'), new RegExp(`no ${kind} pair`));
  });
}

test('--write takes the committed pair set only: another file, or that file with edits not committed, is refused', () => {
  const file = 'scripts/booth/reply-cache-pairs.json';
  const committed = { file, text: '[{"id":"x"}]' };
  assert.equal(writeRefusal(file, committed.text, committed), null);
  assert.match(writeRefusal('../pairs.json', committed.text, committed), /only from scripts\/booth\/reply-cache-pairs\.json/);
  assert.match(writeRefusal(file, '[{"id":"y"}]', committed), /not committed/);
  assert.match(writeRefusal(file, committed.text, { file, text: null }), /not committed/);
});

test('the script refuses --write with another pair set before it embeds anything, and writes no record', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reply-cache-cal-'));
  const other = path.join(dir, 'pairs.json');
  writeFileSync(other, readFileSync(PAIRS));
  const before = existsSync(guards.CALIBRATION_FILE) ? readFileSync(guards.CALIBRATION_FILE, 'utf8') : null;
  const run = spawnSync(process.execPath, [path.join(here, 'reply-cache-calibration.mjs'), '--pairs', other, '--write'],
    { encoding: 'utf8', env: { ...process.env, BOOTH_EMBED_MODEL_DIR: dir } });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /a record is written only from scripts\/booth\/reply-cache-pairs\.json/);
  assert.equal(existsSync(guards.CALIBRATION_FILE) ? readFileSync(guards.CALIBRATION_FILE, 'utf8') : null, before);
});

const RECORD = guards.calibrationFile();
test('a calibration record rimpl would read was written from the committed pair set', { skip: !existsSync(RECORD) && 'no calibration record' }, () => {
  const record = JSON.parse(readFileSync(RECORD, 'utf8'));
  assert.equal(record.pairs_sha, sha256(readFileSync(PAIRS, 'utf8')),
    `${RECORD} names another pair set than ${PAIRS}: run the calibration on the committed pairs again`);
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
