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

// A stand-in for booth_event_summary() over a JSON file (the SQL itself is scripts/db/booth-purge-test.sh's job).
// FAKE_RPC=rollback fails before anything commits; FAKE_RPC=lost commits the delete and its record, then throws as a
// dropped connection does.
function fakeBackend(t, settings) {
  const dir = mkdtempSync(join(tmpdir(), 'booth-purge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src/lib'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/dotenv'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/dotenv/index.js'), 'module.exports = { config: () => ({}) };');
  writeFileSync(join(dir, 'src/lib/supabase.js'), `
    const fs = require('fs');
    const DB = process.env.FAKE_DB;
    const load = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
    const save = (db) => fs.writeFileSync(DB, JSON.stringify(db));
    const rec = (p) => p && { purged_at: p.purged_at, summary: p.summary };
    async function rpc(name, args) {
      const db = load();
      db.calls.push([name, args]);
      save(db);
      if (process.env.FAKE_RPC === 'missing') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
      if (process.env.FAKE_RPC === 'rollback') throw new TypeError('fetch failed');
      if (args.p_delete && db.settings.enabled === 1) return { data: null, error: { code: 'BP409', message: 'booth_event_switched_on' } };
      const mine = db.purges.filter((p) => p.event_code === args.p_event);
      const recorded = mine.at(-1) ?? null;
      const attempt = mine.find((p) => args.p_attempt && p.attempt_id === args.p_attempt) ?? null;
      const rows = db.booth_plays.filter((r) => r.event_code === args.p_event);
      const n = (s) => rows.filter((r) => r.status === s).length;
      const summary = { plays: rows.length, scored: n('scored'), unavailable: n('unavailable'), abandoned: n('abandoned'),
        started: n('started'), ranked: 0, spend_usd: rows.length * 0.1, first_play_at: null, last_play_at: null,
        spread: {}, domain_mean: {} };
      if (args.p_delete) {
        db.booth_plays = db.booth_plays.filter((r) => r.event_code !== args.p_event);
        const stamp = '2026-12-06T03:0' + (db.purges.length + 4) + ':05.123456+00:00';
        if (rows.length) db.purges.push({ event_code: args.p_event, purged_at: stamp, summary, attempt_id: args.p_attempt });
        save(db);
      }
      if (process.env.FAKE_RPC === 'lost') throw new TypeError('fetch failed');
      return { data: { ...summary, recorded: rec(recorded), attempt: rec(attempt) }, error: null };
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
  writeFileSync(db, JSON.stringify({ booth_plays: plays, purges: [], settings, calls: [] }));
  const state = () => JSON.parse(readFileSync(db, 'utf8'));
  const set = (patch) => writeFileSync(db, JSON.stringify({ ...state(), ...patch }));
  const run = (args, env = {}) => {
    let r;
    try {
      r = { code: 0, out: execFileSync(process.execPath, [PURGE, ...args], { encoding: 'utf8', cwd: dir, env: { FAKE_DB: db, ...env },
        stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      r = { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
    assert.doesNotMatch(r.out, /cd backend/, 'advice runs from backend/, where the runbook leaves the operator');
    assert.match(r.out, /(== CCME summary \(.+\) ==\nBooth event |CCME summary: .+)\n?.*Next step: .+\n?$/s, `${args.join(' ')} ends with the CCME block and a next step`);
    return r;
  };
  // Runs exactly the command the last "Next step:" line names.
  const follow = (r, env) => {
    const m = /Next step: .*?`node \.\.\/scripts\/booth\/purge-event\.mjs ([^`]+)`/.exec(r.out);
    assert.ok(m, `the next step names a command: ${r.out}`);
    return run(m[1].split(' '), env);
  };
  const live = () => state().booth_plays.filter((r) => r.event_code === 'NFCME-2026').length;
  return { state, set, run, follow, live };
}

const CCME = (title, plays) => new RegExp(`== CCME summary \\(${title}\\) ==\\nBooth event NFCME-2026\\nplays ${plays} `);

test('purge-event, committed: refused while switched on, then the delete labels its deleted rows as the CCME summary', (t) => {
  const { state, set, run, follow, live } = fakeBackend(t, { code: 'NFCME-2026', enabled: 1 });

  const refused = run(['--event', 'NFCME-2026', '--delete']);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /CCME summary: none yet \(nothing was deleted\)\nNext step: Switch the booth off/);
  assert.equal(live(), 21, 'nothing deleted while switched on');

  set({ settings: { code: 'NFCME-2026', enabled: 0 }, calls: [] });
  const deleted = follow(refused);
  assert.equal(deleted.code, 0);
  assert.match(deleted.out, CCME('the 21 plays deleted now', 21));
  assert.match(deleted.out, /deleted 21 rows, 0 remain/);
  assert.match(deleted.out, /Next step: Done\. Send the CCME summary block above to CCME\. Nothing else to run\.\n$/);
  assert.equal(state().calls.length, 1, 'one rpc call does both');
  assert.deepEqual(state().booth_plays.map((r) => r.event_code), ['OTHER-2025'], 'other events are kept');
});

test('purge-event, already purged: a --delete rerun deletes 0 and labels the recorded summary, never the zeros', (t) => {
  const { run } = fakeBackend(t, { code: 'NFCME-2026', enabled: 0 });
  assert.equal(run(['--event', 'NFCME-2026', '--delete']).code, 0);

  for (const args of [['--event', 'NFCME-2026', '--delete'], ['--event', 'NFCME-2026']]) {
    const again = run(args);
    assert.equal(again.code, 0);
    assert.match(again.out, CCME('recorded when NFCME-2026 was purged at 2026-12-06T10:04:05\\+07:00', 21), args.join(' '));
    assert.doesNotMatch(again.out, /== CCME summary[^\n]*==\nBooth event NFCME-2026\nplays 0 /, 'the zeros are never the CCME block');
    assert.match(again.out, /Next step: .*Nothing else to run\.\n$/);
  }
});

test('purge-event, rolled back before commit: the advised read says nothing was deleted, and its --delete completes', (t) => {
  const { follow, run, live } = fakeBackend(t, { code: 'NFCME-2026', enabled: 0 });

  const failed = run(['--event', 'NFCME-2026', '--delete'], { FAKE_RPC: 'rollback' });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /CCME summary: unknown yet[^\n]*\nNext step: Run `node \.\.\/scripts\/booth\/purge-event\.mjs --event NFCME-2026 --attempt [0-9a-f-]{36}`\. It deletes nothing/);
  assert.equal(live(), 21);

  const read = follow(failed);
  assert.equal(read.code, 0);
  assert.equal(live(), 21, 'the advised read deletes nothing');
  assert.match(read.out, /CCME summary: none yet \(that delete did not commit: nothing was deleted\)/);
  assert.match(read.out, /Next step: Nothing was deleted\. With the booth switched off, run `node \.\.\/scripts\/booth\/purge-event\.mjs --event NFCME-2026 --delete` once more\./);

  const done = follow(read);
  assert.equal(done.code, 0);
  assert.equal(live(), 0, 'the retention delete completes');
  assert.match(done.out, CCME('the 21 plays deleted now', 21));
});

test('purge-event, lost response then new plays: the attempt names the lost delete as the CCME summary, apart from the new plays', (t) => {
  const { state, set, follow, run, live } = fakeBackend(t, { code: 'NFCME-2026', enabled: 0 });

  const lost = run(['--event', 'NFCME-2026', '--delete'], { FAKE_RPC: 'lost' });
  assert.equal(lost.code, 1);
  assert.equal(live(), 0, 'the delete did commit');
  const late = (id) => ({ id, event_code: 'NFCME-2026', status: 'scored' });
  set({ booth_plays: [...state().booth_plays, late('n1'), late('n2')] });

  const read = follow(lost);
  assert.equal(read.code, 0);
  assert.equal(live(), 2, 'the new plays remain');
  assert.match(read.out, /Live plays of NFCME-2026 now \(dry run: nothing deleted\):\nBooth event NFCME-2026\nplays 2 /);
  assert.match(read.out, CCME('the delete of attempt [0-9a-f-]{36}, committed at 2026-12-06T10:04:05\\+07:00', 21));
  assert.doesNotMatch(read.out, /Earlier purge/, 'the lost delete is the only record, shown once');
  assert.match(read.out, /Next step: The delete committed\. Send the CCME summary block above to CCME\. The 2 live plays were started after it and are not in it/);

  const rest = follow(read);
  assert.equal(rest.code, 0);
  assert.equal(live(), 0);
  assert.match(rest.out, CCME('the 2 plays deleted now', 2));

  const plain = run(['--event', 'NFCME-2026']);
  assert.match(plain.out, CCME('recorded when NFCME-2026 was purged at 2026-12-06T10:05:05\\+07:00', 2), 'the latest purge is the CCME block');
});

test('purge-event: a dry run beside an earlier purge labels that record as earlier, and has no CCME summary yet', (t) => {
  const { state, set, run } = fakeBackend(t, { code: 'NFCME-2026', enabled: 0 });
  assert.equal(run(['--event', 'NFCME-2026', '--delete']).code, 0);
  set({ booth_plays: [...state().booth_plays, { id: 'n1', event_code: 'NFCME-2026', status: 'scored' }] });
  const dry = run(['--event', 'NFCME-2026']);
  assert.match(dry.out, /Earlier purge at 2026-12-06T10:04:05\+07:00 \(not the CCME summary of this run\):\nBooth event NFCME-2026\nplays 21 /);
  assert.match(dry.out, /CCME summary: none \(the 1 live plays are kept\)\nNext step: Nothing to run: booth plays are kept \(ADR 0010\)\. Only for a test event or an owner-ordered removal, with the booth switched off, run `node \.\.\/scripts\/booth\/purge-event\.mjs --event NFCME-2026 --delete`\./);
});

test('purge-event: a missing migration names the owner step, then the read', (t) => {
  const { run } = fakeBackend(t, { code: 'NFCME-2026', enabled: 0 });
  const missing = run(['--event', 'NFCME-2026', '--delete'], { FAKE_RPC: 'missing' });
  assert.equal(missing.code, 2);
  assert.match(missing.out, /Next step: Ask the owner to apply db\/migration-booth-purge\.sql, then run `node \.\.\/scripts\/booth\/purge-event\.mjs --event NFCME-2026`\./);
});
