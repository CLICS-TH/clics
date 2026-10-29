import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, report, quantile } from './purge-summary.mjs';

const PURGE = fileURLToPath(new URL('./purge-event.mjs', import.meta.url));
const NONE = { min: null, p25: null, median: null, p75: null, max: null, mean: null, sd: null };
const row = (over) => ({ status: 'scored', spend_usd: '0.090000', composite: null, ranked: true,
  created_at: '2026-11-05T02:30:00Z', d1: null, d2: null, d3: null, d4: null, d5: null, d6: null, d7: null, ...over });

test('an empty event summarizes to zeros and no spread', () => {
  const s = summarize([]);
  assert.deepEqual(s, {
    plays: 0, scored: 0, unavailable: 0, abandoned: 0, started: 0, ranked_scored: 0, spend_usd: 0,
    first_play: null, last_play: null, spread: NONE,
    domain_mean: { d1: null, d2: null, d3: null, d4: null, d5: null, d6: null, d7: null },
  });
  assert.match(report('NFCME-2026', s), /plays 0 {2}scored 0/);
});

test('one scored play gives every spread figure its composite and an SD of 0', () => {
  const s = summarize([row({ composite: '61.25', d1: 3, d2: 4, d3: 3, d4: 2, d5: 3, d6: 2, d7: 3 })]);
  assert.deepEqual(s.spread, { min: 61.3, p25: 61.3, median: 61.3, p75: 61.3, max: 61.3, mean: 61.3, sd: 0 });
  assert.equal(s.first_play, '2026-11-05T09:30:00+07:00');
  assert.equal(s.last_play, s.first_play);
  assert.deepEqual([s.plays, s.scored, s.ranked_scored, s.spend_usd], [1, 1, 1, 0.09]);
});

test('the spread matches hand-computed values, and only scored plays enter it', () => {
  // Scored composites 40, 50, 60, 80. Interpolated p25 = 40 + 0.75*10 = 47.5, median = 55, p75 = 60 + 0.25*20 = 65.
  // Mean 57.5. Population variance (306.25 + 56.25 + 6.25 + 506.25) / 4 = 218.75, so SD 14.79.
  const s = summarize([
    row({ composite: 60, d1: 3, d2: 4, created_at: '2026-11-07T20:15:00.123Z' }),
    row({ composite: 40, d1: 1, d2: 4, ranked: false }),
    row({ composite: 80, d1: 5, d2: 4 }),
    row({ composite: 50, d1: 2, d2: 4, created_at: '2026-11-05T01:00:00Z' }),
    row({ status: 'unavailable', composite: 99, d1: 0, d2: 0, spend_usd: '0.300000' }),
    row({ status: 'abandoned', composite: 0, d1: 0, spend_usd: '0.050000' }),
    row({ status: 'started', spend_usd: 0 }),
  ]);
  assert.deepEqual(s.spread, { min: 40, p25: 47.5, median: 55, p75: 65, max: 80, mean: 57.5, sd: 14.8 });
  assert.deepEqual(s.domain_mean, { d1: 2.8, d2: 4, d3: null, d4: null, d5: null, d6: null, d7: null });
  assert.deepEqual([s.plays, s.scored, s.unavailable, s.abandoned, s.started, s.ranked_scored], [7, 4, 1, 1, 1, 3]);
  assert.equal(s.spend_usd, 0.71);
  assert.equal(s.first_play, '2026-11-05T08:00:00+07:00');
  assert.equal(s.last_play, '2026-11-08T03:15:00+07:00');
});

test('quantile interpolates between closest ranks', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([10, 20], 0.25), 12.5);
  assert.equal(quantile([], 0.5), null);
});

test('the report carries aggregates only, never an id or a tag', () => {
  const out = report('NFCME-2026', summarize([row({ id: 'a1b2c3d4-0000-0000-0000-000000000000', tag: 4242, composite: 55 })]));
  assert.doesNotMatch(out, /a1b2c3d4|4242/);
});

test('purge-event refuses a bad --event before it loads the backend or reaches the database', () => {
  const run = (args) => {
    try {
      execFileSync(process.execPath, [PURGE, ...args], { encoding: 'utf8', cwd: '/', env: {} });
      return { code: 0, err: '' };
    } catch (e) {
      return { code: e.status, err: e.stderr };
    }
  };
  for (const args of [[], ['--event'], ['--event', 'nfcme-2026'], ['--event', "X'; drop"], ['--event', 'NFCME-2026', '--yes']]) {
    const r = run(args);
    assert.equal(r.code, 2, `exit 2 for ${JSON.stringify(args)}`);
    assert.match(r.err, /usage: /, `usage printed for ${JSON.stringify(args)}`);
    assert.doesNotMatch(r.err, /backend modules/, `no backend load for ${JSON.stringify(args)}`);
  }
});

test('purge-event against a fake backend: dry run, refusal while switched on, delete, then an idempotent re-run', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'booth-purge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src/lib'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/dotenv'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/dotenv/index.js'), 'module.exports = { config: () => ({}) };');
  // An in-memory PostgREST stand-in over a JSON file, so the state survives across runs.
  writeFileSync(join(dir, 'src/lib/supabase.js'), `
    const fs = require('fs');
    const DB = process.env.FAKE_DB;
    const load = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
    function from(table) {
      const q = { filters: [], op: 'select', opts: {}, range: null };
      const b = {
        select(_c, opts = {}) { q.opts = opts; return b; },
        delete(opts = {}) { q.op = 'delete'; q.opts = opts; return b; },
        eq(k, v) { q.filters.push((r) => r[k] === v); return b; },
        in(k, vs) { q.filters.push((r) => vs.includes(r[k])); return b; },
        order() { return b; },
        range(a, z) { q.range = [a, z]; return b; },
        then(ok, no) {
          const db = load();
          const hit = (r) => q.filters.every((f) => f(r));
          const rows = db[table].filter(hit);
          let out;
          if (q.op === 'delete') {
            db[table] = db[table].filter((r) => !hit(r));
            fs.writeFileSync(DB, JSON.stringify(db));
            out = { data: null, error: null, count: rows.length };
          } else if (q.opts.head) out = { data: null, error: null, count: rows.length };
          else out = { data: q.range ? rows.slice(q.range[0], q.range[1] + 1) : rows, error: null };
          return Promise.resolve(out).then(ok, no);
        },
      };
      return b;
    }
    module.exports = { supabase: { from } };
  `);
  const db = join(dir, 'db.json');
  const play = (i, event_code = 'NFCME-2026') => ({ id: String(i), event_code, status: i % 2 ? 'scored' : 'abandoned',
    spend_usd: '0.1', composite: i % 2 ? 50 + (i % 7) : null, ranked: true, created_at: new Date(Date.UTC(2026, 10, 5, 0, 0, i)).toISOString() });
  const settings = (enabled) => [{ key: 'booth_event_code', value: 0, value_text: 'NFCME-2026' }, { key: 'booth_enabled', value: enabled, value_text: null }];
  const plays = [...Array.from({ length: 2101 }, (_, i) => play(i)), play(9999, 'OTHER-2025')];
  writeFileSync(db, JSON.stringify({ booth_plays: plays, app_settings: settings(1) }));
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [PURGE, ...args], { encoding: 'utf8', cwd: dir, env: { FAKE_DB: db } }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  const dry = run(['--event', 'NFCME-2026']);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /plays 2101 {2}scored 1050/, 'paginates past 1000 rows');
  assert.match(dry.out, /dry run: nothing deleted/);
  assert.doesNotMatch(dry.out, /\b9999\b/);

  const refused = run(['--event', 'NFCME-2026', '--delete']);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /refused: .*booth_enabled = 1/);
  assert.equal(JSON.parse(readFileSync(db, 'utf8')).booth_plays.length, 2102, 'nothing deleted while switched on');

  const state = JSON.parse(readFileSync(db, 'utf8'));
  writeFileSync(db, JSON.stringify({ ...state, app_settings: settings(0) }));
  const deleted = run(['--event', 'NFCME-2026', '--delete']);
  assert.equal(deleted.code, 0);
  assert.match(deleted.out, /deleted 2101 rows, 0 remain/);
  assert.deepEqual(JSON.parse(readFileSync(db, 'utf8')).booth_plays.map((r) => r.event_code), ['OTHER-2025'], 'other events are kept');

  const again = run(['--event', 'NFCME-2026', '--delete']);
  assert.equal(again.code, 0);
  assert.match(again.out, /plays 0 /);
  assert.match(again.out, /deleted 0 rows, 0 remain/);
});
