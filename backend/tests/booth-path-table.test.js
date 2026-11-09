// The path score table build's sample walk (scripts/booth/path-table-sample.js, #373) and its runner's guards.
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { isValidAsk } = require('../src/services/booth-dialogue');
const { TIER_PATHS, bankKey, sampleWalk, replyProblems, jobsFor, scoreSample, lockProblems } = require('../../scripts/booth/path-table-sample');
const { worstCall } = require('../../scripts/booth/sandbox-play');
const { costUsd } = require('../src/lib/pricing');
const MANIFEST = require('../../rimpl/src/model-manifest.json').expected.code;

const KASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8'));
const LETTER = { best: 'B', reasonable: 'R', weaker: 'W' };
const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'booth', 'build-path-tables.mjs');
const PREFIXES = ['', 'B', 'R', 'W', 'BB', 'BR', 'BW', 'RB', 'RR', 'RW', 'WB', 'WR', 'WW'];

const bankFor = (prefix) => [KASE.banks.step1, KASE.banks.step2[prefix], KASE.banks.step3[prefix]][prefix.length];
const option = (prefix, id) => bankFor(prefix).options.find((o) => o.id === id);
// A reply per option of every bank, bolding a phrase of the option's own Thai label.
const REPLIES = Object.fromEntries(PREFIXES.map((p) => [bankKey(p), Object.fromEntries(bankFor(p).options.map((o) => [o.id, {
  strength: `เลือก **${o.label.th.slice(0, 6)}** โดยมีเหตุผล ${o.id}`, weigh: `ควรชั่งน้ำหนักข้อมูลเพิ่ม ${p || "ก"}`, safety: '',
}]))]));
const replyText = (r) => [r.strength, r.weigh, r.safety].map((s) => s.replaceAll('**', '')).filter(Boolean).join(' ');

describe('a sample walk', () => {
  test.each(['BBB', 'RWB', 'WWW'])('%s taps an offered option of the path\'s tier at every step, from a valid ask', (tierPath) => {
    const d = sampleWalk(KASE, REPLIES, tierPath);
    expect(d.tierPath).toBe(tierPath);
    d.asks.forEach((ask, i) => {
      const prefix = tierPath.slice(0, i);
      expect(isValidAsk(bankFor(prefix), ask)).toBe(true);
      expect(ask.options).toContain(d.answers[i].choice);
      expect(LETTER[option(prefix, d.answers[i].choice).tier]).toBe(tierPath[i]);
    });
    expect(d.replies).toEqual(d.answers.map((a, i) => REPLIES[bankKey(tierPath.slice(0, i))][a.choice]));
  });

  test('variants and same-tier options are drawn at random: 60 walks of one path see more than one of each', () => {
    const walks = Array.from({ length: 60 }, () => sampleWalk(KASE, REPLIES, 'BBB'));
    expect(new Set(walks.map((d) => d.asks.map((a) => a.variant).join())).size).toBeGreaterThan(1);
    expect(new Set(walks.map((d) => d.answers.map((a) => a.choice).join())).size).toBeGreaterThan(1);
  });

  test('the transcript the build scores is the booth\'s, built from the case file by hand for the same path and answers', async () => {
    let body;
    const res = await scoreSample({ kase: KASE, replies: REPLIES, tierPath: 'RBW',
      evaluate: async (b) => { body = b; return { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3, provider: 'anthropic' }; } });
    expect(res.tier_path).toBe('RBW');
    const { ple_id: pleId, ...rest } = body;
    expect(pleId).toMatch(/^[0-9a-f-]{36}$/);
    const turns = [];
    const { transcript } = rest;
    // Read the walked ids back off the transcript's own answers, then rebuild every turn from the case file.
    let prefix = '';
    for (let i = 0; i < 3; i += 1) {
      const b = bankFor(prefix);
      const said = transcript[2 * i].content.split('\n').at(-1);
      const chosen = b.options.find((o) => `${o.label.th}: ${o.line.th}` === said);
      const asked = b.variants.find((v) => transcript[2 * i].content.includes(v.question.th));
      expect(chosen.tier).toBe(['reasonable', 'best', 'weaker'][i]);
      turns.push({ role: 'physician', content: `${i === 0 ? `${KASE.vignette.th}\n\n` : ''}${asked.question.th}\n${said}` });
      turns.push({ role: 'assistant', content: replyText(REPLIES[bankKey(prefix)][chosen.id]) });
      prefix += LETTER[chosen.tier];
    }
    expect(rest).toEqual({ transcript: turns, patient_ref: null, chief_complaint: KASE.vignette.th, shadow: false });
  });

  test('a failed evaluator call leaves the sample unscored at its worst-case cost', async () => {
    const res = await scoreSample({ kase: KASE, replies: REPLIES, tierPath: 'BBB', evaluate: async () => { throw Object.assign(new Error('x'), { status: 502 }); } });
    expect(res).toMatchObject({ domains: null, error: '502' });
    expect(res.usd).toBeGreaterThan(0.2);
  });

  test('every tier path is sampled the given number of times per case', () => {
    expect(TIER_PATHS).toHaveLength(27);
    const jobs = jobsFor([KASE], 3);
    expect(jobs).toHaveLength(81);
    expect(new Set(jobs.map((j) => `${j.tierPath}#${j.sample}`)).size).toBe(81);
  });
});

describe('sample reply checks', () => {
  const withReply = (key, id, reply) => ({ ...REPLIES, [key]: { ...REPLIES[key], [id]: reply } });
  const someId = bankFor('BR').options[0].id;

  test('replies on every option that the booth shows unchanged pass', () => {
    expect(replyProblems(KASE, REPLIES)).toEqual([]);
  });

  test('a missing reply is named by bank and option', () => {
    const { [someId]: _gone, ...rest } = REPLIES['step3.BR'];
    expect(replyProblems(KASE, { ...REPLIES, 'step3.BR': rest })).toEqual([`step3.BR ${someId}: no reply`]);
  });

  test('a bold run naming an option the visitor did not choose is refused, since the booth would strip it', () => {
    const other = bankFor('BR').options[1];
    const problems = replyProblems(KASE, withReply('step3.BR', someId, { strength: `เลือก **${other.label.th}** ดี`, weigh: 'ควรคิด', safety: '' }));
    expect(problems).toEqual([expect.stringMatching(new RegExp(`^step3.BR ${someId}: the booth's reply checks change it`))]);
  });

  test('a field past the booth\'s cut, an English field and a missing weigh are refused', () => {
    const long = 'ก'.repeat(130);
    expect(replyProblems(KASE, withReply('step1', KASE.banks.step1.options[0].id, { strength: long, weigh: 'ควรคิด', safety: '' }))).toHaveLength(1);
    expect(replyProblems(KASE, withReply('step1', KASE.banks.step1.options[0].id, { strength: 'good', weigh: 'ควรคิด', safety: '' }))[0]).toMatch(/strength is not Thai/);
    expect(replyProblems(KASE, withReply('step1', KASE.banks.step1.options[0].id, { strength: 'ดี', safety: '' }))[0]).toMatch(/fields must be/);
  });
});

const DOMAINS = { d1: 3, d2: 3, d3: 3, d4: 3, d5: 3, d6: 3, d7: 3 };
// An evaluate response from the locked evaluator, as rimpl's model manifest declares it.
const locked = (over = {}) => ({
  ...DOMAINS, provider: 'anthropic', prompt_version: MANIFEST.evaluator.prompt_version.anthropic,
  provenance: { model: MANIFEST.anthropic.model, decoding: { ...MANIFEST.decoding.evaluate }, config_fingerprint: 'f' },
  input_tokens: 4000, output_tokens: 400, ...over,
});
const scored = (res) => scoreSample({ kase: KASE, replies: REPLIES, tierPath: 'BBB', evaluate: async () => res });

describe('what a sample is charged against the cap', () => {
  test('a call rimpl retried is charged its tokens plus the worst case of each retried attempt, which reported no tokens', async () => {
    expect((await scored(locked())).usd).toBeCloseTo(costUsd(4000, 400, 'anthropic'), 9);
    expect((await scored(locked({ retried_attempts: 2 }))).usd).toBeCloseTo(costUsd(4000, 400, 'anthropic') + 2 * worstCall('evaluate'), 9);
  });

  test('a call that reports no tokens is charged its worst case, and a failed call the worst case of every attempt rimpl may have made', async () => {
    expect((await scored(locked({ input_tokens: undefined }))).usd).toBe(worstCall('evaluate'));
    const failed = await scoreSample({ kase: KASE, replies: REPLIES, tierPath: 'BBB', evaluate: async () => { throw new Error('x'); } });
    expect(failed.usd).toBeCloseTo(6 * worstCall('evaluate'), 9);
  });
});

describe('the locked evaluator', () => {
  test('a sample scored by the manifest\'s model, prompt and decoding passes; any other model or decoding is named', async () => {
    expect(lockProblems(await scored(locked()))).toEqual([]);
    expect(lockProblems(await scored(locked({ provenance: { ...locked().provenance, model: 'claude-opus-5-5' } }))))
      .toEqual([`model claude-opus-5-5, locked ${MANIFEST.anthropic.model}`]);
    expect(lockProblems(await scored(locked({ provenance: { ...locked().provenance, decoding: { temperature: 0.7, max_tokens: 4096 } } }))))
      .toEqual([`temperature 0.7, locked ${MANIFEST.decoding.evaluate.temperature}`]);
  });
});

describe('the build runner', () => {
  const run = (args) => spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });

  test.each([['--cap', '25.01'], ['--samples', '2']])('refuses %s %s: the cap is at most $25 and a median needs an odd count', (flag, v) => {
    const res = run([flag, v]);
    expect(res.status).toBe(2);
  });

  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ptb-'));
  const runAsync = (args, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  test('the cap counts every earlier run of the build: with $24 already spent of $25, --go is refused before any call', () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, 'spend.json'), JSON.stringify({ 'NFCME-2026': [{ run_id: 'ptb-a', date: '2026-11-04', usd: 15 }, { run_id: 'ptb-b', date: '2026-11-04', usd: 9 }] }));
    const res = spawnSync(process.execPath, [RUNNER, '--go', '--out', out], { encoding: 'utf8', env: { PATH: process.env.PATH, INTERNAL_TOKEN: 't', RIMPL_URL: 'http://127.0.0.1:9' } });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/build NFCME-2026 has spent \$24\.00 of its \$25 cap: no room for another call/);
  });

  test('--from refuses samples that do not record the tree they were scored on', () => {
    const out = tmp();
    const file = path.join(out, 'old.samples.jsonl');
    const header = { run_id: 'ptb-old', date: '2026-11-04', build: 'NFCME-2026', cap_usd: 25, samples: 3 };
    const sample = { case_id: 'adhf', tier_path_planned: 'BBB', sample: 1, tier_path: 'BBB', domains: DOMAINS, composite: 60, usd: 0.017, ...locked() };
    fs.writeFileSync(file, `${[header, sample].map((x) => JSON.stringify(x)).join('\n')}\n`);
    const res = spawnSync(process.execPath, [RUNNER, '--case', 'adhf', '--from', file, '--out', out], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/1 sample\(s\) were not scored on the current tree, first adhf BBB#1 on no recorded tree/);
  });

  test('a probe scored by any model but the locked evaluator stops the build after that one call, and writes no table', async () => {
    const calls = [];
    const server = http.createServer((req, res) => {
      calls.push(req.url);
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(locked({ provenance: { ...locked().provenance, model: 'claude-opus-5-5' } })));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const out = tmp();
    const before = fs.readFileSync(path.join(__dirname, '../src/booth-cases/NFCME-2026/adhf.json'), 'utf8');
    try {
      const res = await runAsync(['--go', '--case', 'adhf', '--out', out], { INTERNAL_TOKEN: 't', RIMPL_URL: `http://127.0.0.1:${server.address().port}` });
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/the probe was not scored by the locked evaluator: model claude-opus-5-5/);
      expect(calls).toEqual(['/evaluate']);
    } finally {
      server.close();
      expect(fs.readFileSync(path.join(__dirname, '../src/booth-cases/NFCME-2026/adhf.json'), 'utf8')).toBe(before);
    }
  });

  test('without --go it checks every NFCME-2026 tree and spends nothing', () => {
    const res = run([]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Nothing spent/);
    expect(res.stdout).not.toMatch(/refused/);
  });
});
