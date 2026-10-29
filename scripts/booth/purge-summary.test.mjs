import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report, bangkokTime } from './purge-summary.mjs';

const PURGE = fileURLToPath(new URL('./purge-event.mjs', import.meta.url));
const NONE = { min: null, p25: null, median: null, p75: null, max: null, mean: null, sd: null };
const NO_DOMAINS = { d1: null, d2: null, d3: null, d4: null, d5: null, d6: null, d7: null };
// The shape booth_event_summary() returns through PostgREST: numbers unrounded, timestamps in UTC.
const SUMMARY = {
  plays: 7, scored: 4, unavailable: 1, abandoned: 1, started: 1, ranked: 3, spend_usd: 0.71,
  first_play_at: '2026-11-05T01:00:00+00:00', last_play_at: '2026-11-07T20:15:00.123+00:00',
  spread: { min: 40.0, p25: 47.5, median: 55, p75: 65, max: 80.0, mean: 57.5, sd: 14.7901994577 },
  domain_mean: { ...NO_DOMAINS, d1: 2.75, d2: 4.0 },
};

test('the report prints counts, spend, Bangkok times, and the spread and domain means to one decimal', () => {
  const out = report('NFCME-2026', SUMMARY);
  assert.equal(out, [
    'Booth event NFCME-2026',
    'plays 7  scored 4  unavailable 1  abandoned 1  started 1',
    'ranked scored 3',
    'total spend USD 0.71',
    'first play 2026-11-05T08:00:00+07:00  last play 2026-11-08T03:15:00+07:00',
    'score spread (scored composites, 0-100): min 40  p25 47.5  median 55  p75 65  max 80  mean 57.5  SD 14.8',
    'domain mean (0-5): d1 2.8  d2 4  d3 -  d4 -  d5 -  d6 -  d7 -',
  ].join('\n'));
});

test('an empty event prints zeros and dashes', () => {
  const out = report('NFCME-2026', { plays: 0, scored: 0, unavailable: 0, abandoned: 0, started: 0, ranked: 0, spend_usd: 0,
    first_play_at: null, last_play_at: null, spread: NONE, domain_mean: NO_DOMAINS });
  assert.match(out, /plays 0 {2}scored 0/);
  assert.match(out, /first play - {2}last play -/);
  assert.match(out, /min - {2}p25 - {2}median -/);
  assert.match(out, /total spend USD 0\.00/);
});

test('bangkokTime shifts UTC to +07:00', () => {
  assert.equal(bangkokTime('2026-11-05T02:30:00Z'), '2026-11-05T09:30:00+07:00');
  assert.equal(bangkokTime(null), null);
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

test('purge-event against a fake backend: one rpc per run, the refusal, the delete, then an idempotent re-run', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'booth-purge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src/lib'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/dotenv'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/dotenv/index.js'), 'module.exports = { config: () => ({}) };');
  // A stand-in for booth_event_summary() over a JSON file (the SQL itself is scripts/db/booth-purge-test.sh's job).
  writeFileSync(join(dir, 'src/lib/supabase.js'), `
    const fs = require('fs');
    const DB = process.env.FAKE_DB;
    const load = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
    const save = (db) => fs.writeFileSync(DB, JSON.stringify(db));
    async function rpc(name, args) {
      const db = load();
      db.calls.push([name, args]);
      save(db);
      if (process.env.FAKE_RPC === 'missing') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
      if (process.env.FAKE_RPC === 'error') return { data: null, error: { code: '57014', message: 'canceling statement' } };
      const on = db.settings.code === args.p_event && db.settings.enabled === 1;
      if (args.p_delete && on) return { data: null, error: { code: 'BP409', message: 'booth_event_switched_on' } };
      const rows = db.booth_plays.filter((r) => r.event_code === args.p_event);
      if (args.p_delete) { db.booth_plays = db.booth_plays.filter((r) => r.event_code !== args.p_event); save(db); }
      const n = (s) => rows.filter((r) => r.status === s).length;
      return { data: { plays: rows.length, scored: n('scored'), unavailable: n('unavailable'), abandoned: n('abandoned'),
        started: n('started'), ranked: 0, spend_usd: rows.length * 0.1, first_play_at: null, last_play_at: null,
        spread: {}, domain_mean: {} }, error: null };
    }
    function from(table) {
      const filters = [];
      const b = {
        select() { return b; },
        eq(k, v) { filters.push((r) => r[k] === v); return b; },
        then(ok, no) {
          const count = load()[table].filter((r) => filters.every((f) => f(r))).length;
          return Promise.resolve({ data: null, error: null, count }).then(ok, no);
        },
      };
      return b;
    }
    module.exports = { supabase: { rpc, from } };
  `);
  const db = join(dir, 'db.json');
  const play = (i, event_code = 'NFCME-2026') => ({ id: String(i), event_code, status: i % 2 ? 'scored' : 'abandoned' });
  const plays = [...Array.from({ length: 21 }, (_, i) => play(i)), play(9999, 'OTHER-2025')];
  writeFileSync(db, JSON.stringify({ booth_plays: plays, settings: { code: 'NFCME-2026', enabled: 1 }, calls: [] }));
  const state = () => JSON.parse(readFileSync(db, 'utf8'));
  const run = (args, env = {}) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [PURGE, ...args], { encoding: 'utf8', cwd: dir, env: { FAKE_DB: db, ...env } }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  const dry = run(['--event', 'NFCME-2026']);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /plays 21 {2}scored 10/);
  assert.match(dry.out, /dry run: nothing deleted/);
  assert.deepEqual(state().calls, [['booth_event_summary', { p_event: 'NFCME-2026', p_delete: false }]], 'one rpc call, no delete');

  const refused = run(['--event', 'NFCME-2026', '--delete']);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /refused: .*booth_enabled = 1/);
  assert.doesNotMatch(refused.out, /plays 21/, 'no summary printed for a refusal');
  assert.equal(state().booth_plays.length, 22, 'nothing deleted while switched on');

  const missing = run(['--event', 'NFCME-2026', '--delete'], { FAKE_RPC: 'missing' });
  assert.equal(missing.code, 2);
  assert.match(missing.out, /apply db\/migration-booth-purge\.sql first/);
  const failed = run(['--event', 'NFCME-2026', '--delete'], { FAKE_RPC: 'error' });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /booth_event_summary failed: canceling statement/);

  writeFileSync(db, JSON.stringify({ ...state(), settings: { code: 'NFCME-2026', enabled: 0 }, calls: [] }));
  const deleted = run(['--event', 'NFCME-2026', '--delete']);
  assert.equal(deleted.code, 0);
  assert.match(deleted.out, /plays 21 {2}scored 10/, 'the summary printed is the one the delete returned');
  assert.match(deleted.out, /deleted 21 rows, 0 remain/);
  assert.deepEqual(state().calls, [['booth_event_summary', { p_event: 'NFCME-2026', p_delete: true }]], 'one rpc call does both');
  assert.deepEqual(state().booth_plays.map((r) => r.event_code), ['OTHER-2025'], 'other events are kept');

  const again = run(['--event', 'NFCME-2026', '--delete']);
  assert.equal(again.code, 0);
  assert.match(again.out, /plays 0 /);
  assert.match(again.out, /deleted 0 rows, 0 remain/);
});
