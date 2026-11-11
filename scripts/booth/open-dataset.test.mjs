import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPii, parseAiRead, aiReadRequest } from './open-dataset.mjs';
import { run, anthropicRead, gitCaseFile, currentCaseFiles } from './build-open-dataset.mjs';

const { ANTHROPIC_MODEL } = createRequire(import.meta.url)('../../rimpl/src/lib/provider-policy.js');
const BUILD = fileURLToPath(new URL('./build-open-dataset.mjs', import.meta.url));
const EVENT = 'TEST-2026';
const HEADER = 'play_ref,event_code,play_date,case_id,case_version,status,replied_step,ranked,tier_path,'
  + 'd1,d2,d3,d4,d5,d6,d7,composite,score_source,transcript';

const reply = (over = {}) => ({ strength: 'เลือกได้เหมาะสม', weigh: 'ควรคำนึงถึงภาวะช็อก', safety: '', ...over });
const tapped = (over = {}) => ({ variant: 's1v1', bridge: '', options: ['o1', 'o2', 'o3'], choice: 'o1', reply: reply(), tier: 'best', ...over });
const typed = (text, over = {}) => ({ variant: 's1v1', bridge: '', options: ['o1', 'o2', 'o3'], typed: text, reply: reply(), tier: 'reasonable', ...over });
const play = (n, steps, over = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, event_code: EVENT, tag: n, status: 'scored', spend_usd: 0.004,
  composite: 49, d1: 2, d2: 3, d3: 2, d4: 3, d5: 2, d6: 3, d7: 2, created_at: '2026-11-05T03:00:00+00:00',
  scored_at: '2026-11-05T03:04:00+00:00', ranked: true, case_id: 'demo', case_version: '2', tier_path: 'BRB', replied_step: 3,
  steps, score_source: 'table', ...over,
});

const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'open-dataset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function fakeDb({ enabled, plays }) {
  const settings = enabled === 'missing' || enabled === 'error' ? [] : [{ key: 'booth_enabled', value: enabled }];
  const tables = { app_settings: settings, booth_plays: plays };
  const reads = [];
  const refuse = (name) => () => { throw new Error(`the build called ${name}`); };
  const from = (table) => {
    const q = { table, select: null, filters: [], order: null, range: null, count: false };
    const b = {
      select(cols, o) { q.select = cols; q.count = o?.count === 'exact'; return b; },
      in(k, vs) { q.filters.push((r) => vs.includes(r[k])); return b; },
      eq(k, v) { q.filters.push((r) => r[k] === v); return b; },
      order(k) { q.order = k; return b; },
      range(a, z) { q.range = [a, z]; return b; },
      insert: refuse('insert'), update: refuse('update'), upsert: refuse('upsert'), delete: refuse('delete'),
      then(ok, no) {
        reads.push(q);
        if (enabled === 'error' && table === 'app_settings') return Promise.resolve({ data: null, error: { message: 'timeout' } }).then(ok, no);
        let data = tables[table].filter((r) => q.filters.every((f) => f(r)));
        const count = data.length;
        if (q.order) data = [...data].sort((x, y) => (x[q.order] < y[q.order] ? -1 : 1));
        if (q.range) data = data.slice(q.range[0], q.range[1] + 1);
        return Promise.resolve({ data, error: null, count: q.count ? count : null }).then(ok, no);
      },
    };
    return b;
  };
  return { db: { from, rpc: refuse('rpc') }, reads };
}

function ai(answer = { identifying: false, reason: 'no identifier' }) {
  const calls = [];
  const read = async (req) => {
    calls.push(req);
    const a = typeof answer === 'function' ? answer(req) : answer;
    if (a instanceof Error) throw a;
    return { content: JSON.stringify(a), input_tokens: 900, output_tokens: 20 };
  };
  return { read, calls };
}

const CASES = { 'demo@1': '{"case_id":"demo","version":"1"}\n', 'demo@2': '{"case_id":"demo","version":"2"}\n' };

async function build(t, { plays, enabled = 0, aiRead = ai().read, cap = 1, signoff, out = tmp(t),
  caseFile = (id, v) => (CASES[`${id}@${v}`] ? Buffer.from(CASES[`${id}@${v}`]) : null),
  currentCases = () => [{ case_id: 'demo', version: '2' }] }) {
  const signoffPath = join(out, 'review', 'signoff.json');
  if (signoff) {
    mkdirSync(join(out, 'review'), { recursive: true });
    writeFileSync(signoffPath, JSON.stringify(signoff));
  }
  const { db, reads } = fakeDb({ enabled, plays });
  const lines = { out: [], err: [] };
  const code = await run({
    opts: { event: EVENT, version: 1, out, signoff: signoffPath, cap, commit: 'abc1234' },
    db, aiRead, caseFile, currentCases, now: new Date('2026-11-10T03:00:00Z'),
    log: { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l) },
  });
  const file = (p) => (existsSync(join(out, p)) ? readFileSync(join(out, p), 'utf8') : null);
  return {
    code, dir: out, reads, lines, file,
    transcripts: () => (file('bundle/transcripts.jsonl') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    flagged: () => JSON.parse(file('review/flagged.json')),
  };
}

const csvRows = (text) => {
  const [head, ...body] = text.trimEnd().split('\n').map((l) => l.split(','));
  return body.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i]])));
};
const stateOf = (b, tierPath) => csvRows(b.file('bundle/plays.csv')).find((r) => r.tier_path === tierPath).transcript;

function snapshot(dir, at = dir) {
  return Object.fromEntries(readdirSync(at).flatMap((n) => {
    const p = join(at, n);
    return statSync(p).isDirectory() ? Object.entries(snapshot(dir, p)) : [[p.slice(dir.length), readFileSync(p, 'utf8')]];
  }));
}

test('plays.csv has exactly its columns: no booth tag, time of day, spend, database id or typed text', async (t) => {
  const answer = 'ให้ ceftriaxone ทางหลอดเลือดดำทันที';
  const planted = play(1, [typed(answer), tapped(), tapped()], {
    tag: 9137, created_at: '2026-11-05T03:47:11Z', scored_at: '2026-11-05T03:52:40Z', spend_usd: 0.123457, tier_path: 'RBB',
  });
  const lateNight = play(2, [tapped(), tapped(), tapped()], { created_at: '2026-11-04T18:15:00Z', tier_path: 'BBB' });
  const b = await build(t, { plays: [planted, lateNight] });
  assert.equal(b.code, 0);

  const text = b.file('bundle/plays.csv');
  assert.equal(text.split('\n')[0], HEADER);
  for (const leak of ['9137', '03:47', '10:47', '03:52', '10:52', '0.123457', answer, planted.id, lateNight.id]) {
    assert.ok(!text.includes(leak), `plays.csv holds no ${leak}`);
  }
  const rows = csvRows(text);
  assert.equal(rows.find((r) => r.tier_path === 'RBB').play_date, '2026-11-05');
  assert.equal(rows.find((r) => r.tier_path === 'BBB').play_date, '2026-11-05', 'a play at 01:15 in Bangkok on 5 Nov is dated in Bangkok');
  assert.equal(stateOf(b, 'RBB'), 'released', 'typed text that passes both screens is released');
  assert.equal(b.transcripts().find((l) => l.tier_path === 'RBB').steps[0].typed, answer);

  const selected = b.reads.find((q) => q.table === 'booth_plays').select.split(/,\s*/);
  for (const col of ['tag', 'spend_usd', 'scored_at']) assert.ok(!selected.includes(col), `the read never selects ${col}`);
});

test('a typed name and phone are flagged by the scan even when the AI says clear, and only a matching sign-off releases them', async (t) => {
  const plays = [play(1, [typed('ผู้ป่วยชื่อสมศักดิ์ รักดี โทร 081-234-5678'), tapped(), tapped()], { tier_path: 'WBB' })];
  const out = tmp(t);
  const first = await build(t, { plays, out });
  assert.equal(first.code, 0);
  assert.equal(stateOf(first, 'WBB'), 'withheld');
  assert.equal(first.transcripts().length, 0);
  const [row] = first.flagged().rows;
  assert.notDeepEqual(row.findings, [], 'the scan lists what it found');
  assert.deepEqual(row.ai, { kind: 'clear' });
  assert.ok(row.strings.some((s) => s.includes('081-234-5678')), 'the reviewer is shown the text');
  assert.match(first.lines.out.join('\n'), /Next step: Read the 1 withheld plays in .*flagged\.json/);

  const signed = { ...row.signoff, by: 'Napat', date: '2026-11-10' };
  for (const [signoff, want, why] of [
    [[{ ...signed, by: '' }], 'withheld', 'a sign-off with no name'],
    [[{ ...signed, by: '   ' }], 'withheld', 'a sign-off with a blank name'],
    [[{ ...signed, sha256: '0'.repeat(64) }], 'withheld', 'a sign-off of other text'],
    [[signed], 'released', 'a sign-off of this text'],
  ]) {
    const again = await build(t, { plays, out, signoff });
    assert.equal(stateOf(again, 'WBB'), want, why);
    assert.equal(again.transcripts().length, want === 'released' ? 1 : 0, why);
  }
});

test('a planted name alone and a planted phone alone are each found by the scan, with the AI saying clear', async (t) => {
  const plays = [
    play(1, [typed('ผู้ป่วยชื่อสมศักดิ์ รักดี'), tapped(), tapped()], { tier_path: 'WBB' }),
    play(2, [typed('ให้ญาติโทร 081-234-5678'), tapped(), tapped()], { tier_path: 'RBB' }),
  ];
  const b = await build(t, { plays });
  assert.equal(stateOf(b, 'WBB'), 'withheld');
  assert.equal(stateOf(b, 'RBB'), 'withheld');
  const rulesOf = (n) => b.flagged().rows.find((r) => r.strings.some((s) => s.includes(n))).findings.map((f) => f.rule);
  assert.ok(rulesOf('สมศักดิ์').some((r) => /NAME|name/.test(r)), `a name rule fires: ${rulesOf('สมศักดิ์')}`);
  assert.ok(rulesOf('081').some((r) => r === 'long-number' || r === 'pii-filter:PHONE'), `a phone rule fires: ${rulesOf('081')}`);
});

test('a name the scan cannot see is withheld when the AI read calls it identifying', async (t) => {
  const plays = [play(1, [typed('พรรณราย ทองเปลว'), tapped(), tapped()], { tier_path: 'RBB' })];
  const b = await build(t, { plays, aiRead: ai({ identifying: true, reason: 'a full Thai name' }).read });
  assert.equal(stateOf(b, 'RBB'), 'withheld');
  assert.equal(b.transcripts().length, 0);
  assert.deepEqual(b.flagged().rows[0].ai, { kind: 'identifying', reason: 'a full Thai name' });
});

test('a phone echoed in a reply or a bridge flags its play, and Thai-digit, dotted and spaced phones are found', async (t) => {
  const plays = [
    play(1, [typed('ให้สารน้ำก่อน'), tapped({ reply: reply({ weigh: 'ถ้าญาติโทร 081-234-5678 ให้ประเมินซ้ำ' }) }), tapped()], { tier_path: 'RBW' }),
    play(2, [typed('ให้สารน้ำก่อน'), tapped({ bridge: 'ติดต่อ ๐๘๑-๒๓๔-๕๖๗๘ แล้วตอบต่อ' }), tapped()], { tier_path: 'RWB' }),
  ];
  const b = await build(t, { plays });
  assert.equal(stateOf(b, 'RBW'), 'withheld', 'a phone in a reply field');
  assert.equal(stateOf(b, 'RWB'), 'withheld', 'a Thai-digit phone in a bridge');

  for (const phone of ['โทร ๐๘๑-๒๓๔-๕๖๗๘', 'โทร 081.234.5678', 'โทร 081 234 5678', 'โทร 0812345678']) {
    assert.notDeepEqual(scanPii(phone), [], phone);
  }
  for (const clean of ['BP 90/60 HR 120 ให้ NSS 1000 ml', 'นาย[NAME-1] โทร [PHONE-1]']) {
    assert.deepEqual(scanPii(clean), [], `${clean}: vitals and the filter's own masks are not findings`);
  }
});

test('the AI read is sent the text de-identified: the planted phone reaches it in no form', async (t) => {
  const reader = ai();
  const plays = [play(1, [
    typed('ให้ ceftriaxone ก่อน โทร 081-234-5678'),
    tapped({ bridge: 'ติดต่อ ๐๘๑-๒๓๔-๕๖๗๘' }),
    tapped({ reply: reply({ safety: 'เบอร์ 081.234.5678' }) }),
  ])];
  await build(t, { plays, aiRead: reader.read });
  assert.equal(reader.calls.length, 1, 'one read per play');
  const sent = JSON.stringify(reader.calls[0]);
  assert.match(sent, /ceftriaxone/, 'the read is sent the play\'s text');
  for (const digits of ['5678', '๕๖๗๘']) assert.ok(!sent.includes(digits), `no ${digits} in the request`);
});

test('a tapped-only play is screened like any other; a failed read or the cap withholds a play, signed or not', async (t) => {
  const reader = ai();
  const tappedOnly = play(1, [tapped(), tapped(), tapped()], { tier_path: 'BBB' });
  const solo = await build(t, { plays: [tappedOnly], aiRead: reader.read });
  assert.equal(stateOf(solo, 'BBB'), 'released');
  assert.equal(solo.transcripts().length, 1);
  assert.equal(reader.calls.length, 1, 'a tapped-only play gets its AI read too');

  const echoed = play(4, [tapped({ reply: reply({ weigh: 'โทรหา 081-234-5678' }) }), tapped(), tapped()], { tier_path: 'BRB' });
  const echo = await build(t, { plays: [echoed] });
  assert.equal(stateOf(echo, 'BRB'), 'withheld', 'a phone in a tapped play\'s reply flags it');

  const typedPlay = play(2, [typed('ให้สารน้ำก่อน'), tapped(), tapped()], { tier_path: 'RBB' });
  const out = tmp(t);
  const identifying = ai({ identifying: true, reason: 'unsure' }).read;
  const first = await build(t, { plays: [typedPlay], out, aiRead: identifying });
  const signoff = [{ ...first.flagged().rows[0].signoff, by: 'Napat', date: '2026-11-10' }];
  assert.equal(stateOf(await build(t, { plays: [typedPlay], out, signoff, aiRead: identifying }), 'RBB'), 'released',
    'the sign-off is valid for a read play');
  const failed = await build(t, { plays: [typedPlay], out, signoff, aiRead: ai(new Error('socket hang up')).read });
  assert.equal(stateOf(failed, 'RBB'), 'withheld', 'signed, but the AI could not read it');
  assert.equal(failed.flagged().rows[0].signoff, null, 'an unread play offers no sign-off');
  assert.match(failed.lines.out.join('\n'), /Next step: Run `.*--go` again to read the 1 plays the AI could not read/);

  const capped = ai();
  const another = play(3, [typed('ให้ยาลดไข้'), tapped(), tapped()], { tier_path: 'WBB' });
  const zero = await build(t, { plays: [tappedOnly, typedPlay, another], cap: 0, aiRead: capped.read });
  assert.equal(zero.code, 0);
  assert.equal(capped.calls.length, 0, '--cap 0 makes no AI read');
  assert.equal(stateOf(zero, 'RBB'), 'withheld');
  assert.equal(stateOf(zero, 'WBB'), 'withheld');
  assert.equal(stateOf(zero, 'BBB'), 'withheld', 'a tapped-only play left unread is withheld too');
  assert.match(zero.lines.out.join('\n'), /raise --cap/);
});

test('the AI read is taken bare or in one code fence; any other answer is unread', () => {
  const clear = '{"identifying": false, "reason": "none"}';
  assert.deepEqual(parseAiRead(clear), { kind: 'clear' });
  assert.deepEqual(parseAiRead('```json\n{"identifying": true, "reason": "a name"}\n```'), { kind: 'identifying', reason: 'a name' });
  for (const bad of [`Sure: ${clear}`, '{"identifying": "no", "reason": "x"}', '{"identifying": false}', '{"identifying": false, "reason": "x", "extra": 1}']) {
    assert.equal(parseAiRead(bad).kind, 'unread', bad);
  }
});

test('the README states the data\'s licence and limits', async (t) => {
  const b = await build(t, { plays: [play(1, [tapped(), tapped(), tapped()])] });
  const text = b.file('bundle/README.md');
  for (const [limit, pattern] of [
    ['CC BY 4.0', /CC BY 4\.0/],
    ['a demo score, not credit', /demo score[\s\S]*not CME or CPD credit/i],
    ['an unvalidated scorer', /not validated against physician raters/],
    ['the compressed scale of #344', /compressed scale \(#344\)[\s\S]*best paths was 48[\s\S]*weakest paths 35/i],
    ['typed answers scored as their tier', /typed answers are scored as their tier[\s\S]*typed text itself is never scored/i],
    ['d1 to d7 a function of the path', /d1 to d7 are a function of the path[\s\S]*same score/],
    ['the 3 to 4 November 2026 plays', /3 to 4 November 2026[\s\S]*live evaluator/],
    ['withheld transcripts', /marked `withheld` in plays\.csv/],
    ['what is left out', /booth tag[\s\S]*time of day[\s\S]*AI spend[\s\S]*database id/],
  ]) assert.match(text, pattern, limit);
  assert.match(b.file('bundle/DATA-DICTIONARY.md'), /\| transcript \| released: /, 'the dictionary lists plays.csv\'s columns');
});

test('the build refuses while the booth is switched on, or when the switch cannot be read, before it reads any play', async (t) => {
  for (const [enabled, why] of [[1, 'switched on'], ['missing', 'no booth_enabled setting'], ['error', 'the setting read failed']]) {
    const b = await build(t, { enabled, plays: [play(1, [tapped(), tapped(), tapped()])] });
    assert.equal(b.code, 2, why);
    assert.ok(!b.reads.some((q) => q.table === 'booth_plays'), `${why}: booth_plays is never read`);
    assert.equal(existsSync(join(b.dir, 'bundle')), false, `${why}: nothing is written`);
  }
});

test('a full build only reads the database, sends only the AI read to the Messages API, and rebuilds the same files', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => { throw new Error(`the build fetched ${url}`); });
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url) !== 'https://api.anthropic.com/v1/messages') throw new Error(`the build fetched ${url}`);
    sent.push({ headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"identifying": false, "reason": "none"}' }], usage: { input_tokens: 800, output_tokens: 15 } }) };
  };
  const unscored = { status: 'abandoned', composite: null, d1: null, d2: null, d3: null, d4: null, d5: null, d6: null, d7: null,
    scored_at: null, steps: null, score_source: null, tier_path: 'B', ranked: false, replied_step: 1 };
  const plays = [
    play(1, [typed('ให้สารน้ำก่อน'), tapped(), tapped()], { tier_path: 'RBB' }),
    play(2, [tapped(), tapped(), tapped()], { tier_path: 'BBB', case_version: '1' }),
    play(3, null, unscored),
  ];
  const out = tmp(t);
  const opts = { plays, out, aiRead: anthropicRead({ apiKey: 'test-key', fetchImpl }) };
  const first = await build(t, opts);
  assert.equal(first.code, 0, first.lines.err.join('\n'));
  assert.equal(sent.length, 2, 'one AI read per play with dialogue');
  assert.equal(sent[0].body.model, ANTHROPIC_MODEL);
  assert.equal(sent[0].headers['x-api-key'], 'test-key');
  assert.deepEqual([...new Set(first.reads.map((q) => q.table))].sort(), ['app_settings', 'booth_plays']);
  assert.equal(stateOf(first, 'B'), 'none');
  assert.deepEqual(readdirSync(join(out, 'bundle', 'cases')), ['demo-v1.json', 'demo-v2.json']);
  assert.equal(existsSync(join(out, 'review', 'signoff.json')), false, 'the build never writes a sign-off');
  assert.match(first.lines.out.join('\n'), /Uploaded nothing\.\nNext step: Deposit .*bundle on Zenodo by hand/);

  const files = snapshot(out);
  await build(t, opts);
  assert.deepEqual(snapshot(out), files, 'the same input builds the same files');
});

test('a bundle folder that holds files no build wrote is refused, not removed', async (t) => {
  const out = tmp(t);
  mkdirSync(join(out, 'bundle'), { recursive: true });
  writeFileSync(join(out, 'bundle', 'notes.txt'), 'mine');
  const b = await build(t, { out, plays: [play(1, [tapped(), tapped(), tapped()])] });
  assert.equal(b.code, 2);
  assert.equal(readFileSync(join(out, 'bundle', 'notes.txt'), 'utf8'), 'mine');
  assert.ok(!b.reads.some((q) => q.table === 'booth_plays'), 'booth_plays is never read');
});

test('a case version is read from git history, and a version no commit holds builds nothing', async (t) => {
  const dir = tmp(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  const v1 = '{\n  "case_id": "demo",\n  "version": "1"\n}\n';
  const v2 = '{"case_id":"demo","version":"2"}\n';
  writeFileSync(join(dir, 'demo.json'), v1);
  git('add', 'demo.json');
  git('commit', '-q', '-m', 'v1');
  writeFileSync(join(dir, 'demo.json'), v2);
  git('commit', '-q', '-a', '-m', 'v2');
  writeFileSync(join(dir, 'demo.json'), '{"case_id":"demo","version":"2","edited":true}\n');

  const caseFile = gitCaseFile(dir);
  assert.equal(caseFile('demo', '1').toString('utf8'), v1, 'the older version, byte for byte');
  assert.equal(caseFile('demo', '2').toString('utf8'), v2, 'an uncommitted edit is never used');
  assert.equal(caseFile('demo', '3'), null);

  const b = await build(t, { plays: [play(1, [tapped(), tapped(), tapped()], { case_version: '3' })], caseFile, currentCases: () => currentCaseFiles(dir) });
  assert.equal(b.code, 1);
  assert.match(b.lines.err.join('\n'), /demo@3/);
  assert.equal(existsSync(join(b.dir, 'bundle')), false, 'no bundle');
  assert.equal(existsSync(join(b.dir, 'review')), false, 'no review file');
});

test('the CLI refuses bad arguments with usage, and without --go prints its plan and touches nothing', () => {
  const cli = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [BUILD, ...args], { encoding: 'utf8', cwd: '/', env: {}, stdio: ['ignore', 'pipe', 'pipe'] }), err: '' };
    } catch (e) {
      return { code: e.status, out: e.stdout, err: e.stderr };
    }
  };
  for (const args of [[], ['--event'], ['--event', 'nfcme-2026'], ['--event', "X'; drop"], ['--event', 'NFCME-2026', '--yes'],
    ['--event', 'NFCME-2026', '--cap', '-1'], ['--event', 'NFCME-2026', '--version', '0']]) {
    const r = cli(args);
    assert.equal(r.code, 2, `exit 2 for ${JSON.stringify(args)}`);
    assert.match(r.err, /usage: /, `usage printed for ${JSON.stringify(args)}`);
  }

  const event = 'NOGO-388';
  const out = fileURLToPath(new URL(`./open-dataset/${event}-v1`, import.meta.url));
  const dry = cli(['--event', event]);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Dry run: nothing was read, written or sent/);
  assert.match(dry.out, /It uploads nothing/);
  assert.match(dry.out, new RegExp(`Next step: node --env-file=backend/\\.env --env-file=rimpl/\\.env scripts/booth/build-open-dataset\\.mjs --event ${event} --go\\n$`));
  assert.equal(existsSync(out), false, 'the dry run writes nothing');

  const noEnv = cli(['--event', event, '--go']);
  assert.equal(noEnv.code, 2);
  assert.match(noEnv.err, /SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY not set: nothing was read/);
  assert.equal(existsSync(out), false, 'nothing is written without the env');
});

test('a play whose steps hold a key or value outside the published shape refuses the build, writing nothing', async (t) => {
  for (const [bad, why] of [
    [tapped({ at: '2026-11-05T03:47:11Z' }), 'an unknown step key'],
    [tapped({ reply: reply({ note: 'คุณสมชาย' }) }), 'an unknown reply key'],
    [tapped({ choice: 'คุณสมชาย โทร 0812345678' }), 'text in an id field'],
    [tapped({ tier: 'excellent' }), 'a tier that is not a tier name'],
  ]) {
    const b = await build(t, { plays: [play(1, [bad, tapped(), tapped()], { tier_path: 'BBB' })] });
    assert.equal(b.code, 1, why);
    assert.match(b.lines.err.join('\n'), /not the shape this build publishes/, why);
    assert.equal(existsSync(join(b.dir, 'bundle')), false, `${why}: nothing is written`);
  }
});

test('no span the scan flags reaches the AI read: a labelled English name and a titled Thai name are masked', () => {
  const strings = ['full name: John Smith', 'ส่งต่อให้ รศ.สมชาย ใจดี ดูแล', 'โทร ๐๘๑-๒๓๔-๕๖๗๘ หรือ a.b@c.co'];
  for (const s of strings) assert.notDeepEqual(scanPii(s), [], `the scan flags ${s}`);
  const sent = JSON.stringify(aiReadRequest(strings));
  for (const leak of ['John', 'Smith', 'สมชาย', 'ใจดี', '081', '๐๘๑', '5678', 'a.b@c.co']) {
    assert.ok(!sent.includes(leak), `the AI read is not sent ${leak}`);
  }
  assert.match(sent, /\[FLAGGED\]/);
});
