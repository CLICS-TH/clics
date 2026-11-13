// The path score table build's sample walk (scripts/booth/path-table-sample.js, #373) and its runner's guards.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { isValidAsk, evaluateRequest, bankKey } = require('../src/services/booth-dialogue');
const { treeSha } = require('../src/booth-cases/tree-sha');
const { sampleWalk, replyProblems, jobsFor, lockProblems } = require('../../scripts/booth/path-table-sample');
const { PATHS, PATHS_BY_STEPS } = require('../../scripts/booth/sandbox-play');
const MANIFEST = require('../../rimpl/src/model-manifest.json').expected.code;

const KASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8'));
const KASE5 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree-5.json'), 'utf8'));
const LETTER = { best: 'B', reasonable: 'R', weaker: 'W' };
const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'booth', 'build-path-tables.mjs');
const tierPaths = (length) => (length ? ['B', 'R', 'W'].flatMap((a) => tierPaths(length - 1).map((rest) => a + rest)) : ['']);

const bankFor = (prefix) => [KASE.banks.step1, KASE.banks.step2[prefix], KASE.banks.step3[prefix]][prefix.length];
const option = (prefix, id) => bankFor(prefix).options.find((o) => o.id === id);
// A sample reply file names each bank as the case file lays it out: step1, then step<n>.<key> for each keyed bank.
const banksOf = (kase) => Object.entries(kase.banks).flatMap(([step, level]) =>
  (level.variants ? [[step, level]] : Object.entries(level).map(([key, bank]) => [`${step}.${key}`, bank])));
// A reply per option of every bank, bolding a phrase of the option's own Thai label and naming its bank.
const repliesFor = (kase) => Object.fromEntries(banksOf(kase).map(([key, bank]) => [key, Object.fromEntries(bank.options.map((o) => [o.id, {
  strength: `เลือก **${o.label.th.slice(0, 6)}** โดยมีเหตุผล ${o.id}`, weigh: `ควรชั่งน้ำหนักข้อมูลเพิ่ม ${key}`, safety: '',
}]))]));
const REPLIES = repliesFor(KASE);
const REPLIES5 = repliesFor(KASE5);
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
    expect(d.replies).toEqual(d.answers.map((a, i) => REPLIES[bankKey(KASE, tierPath.slice(0, i))][a.choice]));
  });

  test.each(['BBBBB', 'WRBWB', 'RWWRB'])('five steps: %s taps the path\'s tier at each of five steps, from the bank keyed on the previous tier', (tierPath) => {
    const d = sampleWalk(KASE5, REPLIES5, tierPath);
    expect(d.tierPath).toBe(tierPath);
    expect(d.answers).toHaveLength(5);
    d.asks.forEach((ask, i) => {
      const [key, bank] = i ? [`step${i + 1}.${tierPath[i - 1]}`, KASE5.banks[`step${i + 1}`][tierPath[i - 1]]] : ['step1', KASE5.banks.step1];
      const chosen = bank.options.find((o) => o.id === d.answers[i].choice);
      expect(isValidAsk(bank, ask)).toBe(true);
      expect(ask.options).toContain(chosen.id);
      expect(LETTER[chosen.tier]).toBe(tierPath[i]);
      expect(d.replies[i]).toEqual(REPLIES5[key][chosen.id]);
    });
  });

  test('variants and same-tier options are drawn at random: 60 walks of one path see more than one of each', () => {
    const walks = Array.from({ length: 60 }, () => sampleWalk(KASE, REPLIES, 'BBB'));
    expect(new Set(walks.map((d) => d.asks.map((a) => a.variant).join())).size).toBeGreaterThan(1);
    expect(new Set(walks.map((d) => d.answers.map((a) => a.choice).join())).size).toBeGreaterThan(1);
  });

  test('the transcript of a sample is the booth\'s, built from the case file by hand for the same path and answers', () => {
    const d = sampleWalk(KASE, REPLIES, 'RBW');
    expect(d.tierPath).toBe('RBW');
    const rest = evaluateRequest(KASE, d);
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
      turns.push({ role: 'assistant', content: replyText(REPLIES[bankKey(KASE, prefix)][chosen.id]) });
      prefix += LETTER[chosen.tier];
    }
    expect(rest).toEqual({ transcript: turns, patient_ref: null, chief_complaint: KASE.vignette.th, shadow: false });
  });

  test.each([['three', KASE, 3, 27], ['five', KASE5, 5, 243]])('every tier path of a %s-step case is sampled the given number of times', (_, kase, steps, paths) => {
    const jobs = jobsFor([kase], 3);
    expect(jobs).toHaveLength(3 * paths);
    expect(new Set(jobs.map((j) => j.tierPath))).toEqual(new Set(tierPaths(steps)));
    expect(new Set(jobs.map((j) => `${j.tierPath}#${j.sample}`)).size).toBe(3 * paths);
  });

  test('a build samples only the paths its table plan names', () => {
    const jobs = jobsFor([KASE], 3, () => ['BBB', 'WWW']);
    expect(jobs.map((j) => `${j.tierPath}#${j.sample}`)).toEqual(['BBB#1', 'BBB#2', 'BBB#3', 'WWW#1', 'WWW#2', 'WWW#3']);
  });
});

describe('the scripted paths by case length', () => {
  test('three steps keep the sandbox\'s paths, and five steps are the ones the path table\'s node tests plan from', () => {
    expect(PATHS_BY_STEPS[3]).toBe(PATHS);
    // scripts/booth/path-table.test.mjs holds this map as a literal, since sandbox-play.js needs this suite's packages.
    expect(PATHS_BY_STEPS[5]).toEqual({ best: 'BBBBB', mixed: 'BRWRR', weakest: 'WWWWW' });
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

  test('five steps: replies on every option of its 13 banks pass, and a missing one is named by its previous-tier bank', () => {
    expect(Object.keys(REPLIES5)).toHaveLength(13);
    expect(replyProblems(KASE5, REPLIES5)).toEqual([]);
    const id = KASE5.banks.step4.R.options[0].id;
    const { [id]: _gone, ...rest } = REPLIES5['step4.R'];
    expect(replyProblems(KASE5, { ...REPLIES5, 'step4.R': rest })).toEqual([`step4.R ${id}: no reply`]);
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
// A saved sample as the build recorded it from such a response.
const scored = (res) => ({ domains: DOMAINS, provider: res.provider, model: res.provenance.model, prompt_version: res.prompt_version,
  decoding: res.provenance.decoding });

describe('the locked evaluator', () => {
  test('a sample scored by the manifest\'s model, prompt and decoding passes; any other model or decoding is named', () => {
    expect(lockProblems(scored(locked()))).toEqual([]);
    expect(lockProblems(scored(locked({ provenance: { ...locked().provenance, model: 'claude-opus-5-5' } }))))
      .toEqual([`model claude-opus-5-5, locked ${MANIFEST.anthropic.model}`]);
    expect(lockProblems(scored(locked({ provenance: { ...locked().provenance, decoding: { temperature: 0.7, max_tokens: 4096 } } }))))
      .toEqual([`temperature 0.7, locked ${MANIFEST.decoding.evaluate.temperature}`]);
  });
});

describe('the build runner', () => {
  const run = (args) => spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });

  test('refuses --samples 2: a median needs an odd count', () => {
    expect(run(['--samples', '2']).status).toBe(2);
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

  /** A throwaway build: fixture cases under a fresh event code, committed in their own git repo (a safety review then
   *  reads the committed tree), with their sample replies. Nothing it writes is a tracked file of this repo. */
  function throwawayBuild(kases = [KASE]) {
    const build = `TST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const dir = path.join(tmp(), build);
    fs.mkdirSync(dir);
    const replies = tmp();
    for (const kase of kases) {
      fs.writeFileSync(path.join(dir, `${kase.case_id}.json`), `${JSON.stringify({ ...kase, event_code: build }, null, 2)}\n`);
      fs.writeFileSync(path.join(replies, `${kase.case_id}.json`), JSON.stringify({ case_id: kase.case_id, replies: repliesFor(kase) }));
    }
    const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'case');
    return { build, dir, args: ['--cases', dir, '--replies', replies, '--out', tmp()] };
  }

  /** A stub rimpl that records every request and answers each with a 500. */
  async function stubRimpl() {
    const calls = [];
    const server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => { res.statusCode = 500; res.end('{}'); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { calls, server, url: `http://127.0.0.1:${server.address().port}` };
  }

  test.each([
    ['--go', []],
    ['--go after the other flags', ['--samples', '3']],
    ['--go with --from', ['--from', '/nonexistent.samples.jsonl']],
  ])('%s sends no request to rimpl and is refused, naming #408', async (_name, extra) => {
    const { args } = throwawayBuild();
    const rimpl = await stubRimpl();
    try {
      const res = await runAsync([...args, ...extra, '--go'], { INTERNAL_TOKEN: 't', RIMPL_URL: rimpl.url });
      expect(rimpl.calls).toEqual([]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/Live table builds are off until #408/);
    } finally {
      rimpl.server.close();
    }
  });

  test('--from still builds a table from a saved run, spending nothing, into the throwaway case only', async () => {
    const { dir, args } = throwawayBuild();
    const caseFile = path.join(dir, `${KASE.case_id}.json`);
    const kase = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
    const file = path.join(args[5], 'run.samples.jsonl');
    const header = { run_id: 'ptb-saved', date: '2026-11-09', build: kase.event_code, cap_usd: 25, prior_usd: 0, samples: 3 };
    const samples = jobsFor([kase], 3).map((j) => ({ case_id: kase.case_id, tier_path_planned: j.tierPath, sample: j.sample,
      tree_sha256: treeSha(kase), tier_path: j.tierPath, domains: DOMAINS, composite: 60, usd: 0.017, ...scored(locked()) }));
    fs.writeFileSync(file, `${[header, ...samples].map((x) => JSON.stringify(x)).join('\n')}\n`);
    const rimpl = await stubRimpl();
    try {
      const res = await runAsync([...args, '--from', file], { INTERNAL_TOKEN: 't', RIMPL_URL: rimpl.url });
      expect(rimpl.calls).toEqual([]);
      expect([0, 1]).toContain(res.status);
      const built = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
      expect(built.version).toBe(String(Number(kase.version) + 1));
      expect(built.path_score_table.provenance).toMatchObject({ run_id: 'ptb-saved', tree_sha256: treeSha(kase) });
      expect(built.path_score_table.paths.BBB).toEqual(DOMAINS);
    } finally {
      rimpl.server.close();
    }
  });

  test('--from records the three-step method, its scripted paths and the 27 paths it sampled', () => {
    const { dir, args } = throwawayBuild();
    const caseFile = path.join(dir, `${KASE.case_id}.json`);
    const kase = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
    const out = args[args.indexOf('--out') + 1];
    const file = path.join(out, 'run.samples.jsonl');
    const header = { run_id: 'ptb-method', date: '2026-11-10', build: kase.event_code, cap_usd: 25, prior_usd: 0, samples: 3 };
    const samples = jobsFor([kase], 3).map((j) => ({ case_id: kase.case_id, tier_path_planned: j.tierPath, sample: j.sample,
      tree_sha256: treeSha(kase), tier_path: j.tierPath, domains: DOMAINS, composite: 60, usd: 0.017, ...scored(locked()) }));
    fs.writeFileSync(file, `${[header, ...samples].map((x) => JSON.stringify(x)).join('\n')}\n`);
    expect([0, 1]).toContain(run([...args, '--from', file]).status);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'ptb-method.json'), 'utf8'));
    expect(report).toMatchObject({ method: 'median', scripted: PATHS, sampled: tierPaths(3) });
    expect(JSON.parse(fs.readFileSync(caseFile, 'utf8')).path_score_table.provenance.method).toBe('median');
  });

  test('--from builds a five-step case\'s fitted table of all 243 paths from the 27 its plan samples', () => {
    const { dir, args } = throwawayBuild([KASE5]);
    const caseFile = path.join(dir, `${KASE5.case_id}.json`);
    const kase = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
    const out = args[args.indexOf('--out') + 1];
    const file = path.join(out, 'run.samples.jsonl');
    const header = { run_id: 'ptb-five', date: '2026-11-11', build: kase.event_code, cap_usd: 25, prior_usd: 0, samples: 3 };
    // A saved sample on every path, so whichever 27 the plan samples are all there.
    const samples = jobsFor([kase], 3).map((j) => ({ case_id: kase.case_id, tier_path_planned: j.tierPath, sample: j.sample,
      tree_sha256: treeSha(kase), tier_path: j.tierPath, domains: DOMAINS, composite: 60, usd: 0, ...scored(locked()) }));
    fs.writeFileSync(file, `${[header, ...samples].map((x) => JSON.stringify(x)).join('\n')}\n`);
    const res = run([...args, '--from', file]);
    expect([0, 1]).toContain(res.status);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'ptb-five.json'), 'utf8'));
    expect(report).toMatchObject({ method: 'median-regression', scripted: PATHS_BY_STEPS[5] });
    expect(report.sampled).toHaveLength(27);
    expect(report.sampled).toEqual(expect.arrayContaining(Object.values(PATHS_BY_STEPS[5])));
    const built = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
    expect(built.version).toBe(String(Number(kase.version) + 1));
    expect(built.path_score_table.provenance).toMatchObject({ method: 'median-regression', run_id: 'ptb-five', tree_sha256: treeSha(kase) });
    expect(Object.keys(built.path_score_table.paths)).toHaveLength(243);
    expect(built.path_score_table.paths.WRBWB).toEqual(DOMAINS);
  });

  test('refuses a run of cases with different step counts, and builds either count once --case picks it', () => {
    const { args } = throwawayBuild([KASE, KASE5]);
    const mixed = run(args);
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toMatch(/have (3 and 5|5 and 3) steps: a run builds one step count/);
    expect(run([...args, '--case', KASE.case_id]).status).toBe(0);
    expect(run([...args, '--case', KASE5.case_id]).status).toBe(0);
  });

  test('--from refuses a run that went over the cap it ran under', () => {
    const out = tmp();
    const file = path.join(out, 'over.samples.jsonl');
    const header = { run_id: 'ptb-over', date: '2026-11-09', build: 'NFCME-2026', cap_usd: 25, prior_usd: 24, samples: 3 };
    const sample = { case_id: 'adhf', tier_path_planned: 'BBB', sample: 1, tier_path: 'BBB', domains: DOMAINS, composite: 60, usd: 2, ...locked() };
    fs.writeFileSync(file, `${[header, sample].map((x) => JSON.stringify(x)).join('\n')}\n`);
    const res = spawnSync(process.execPath, [RUNNER, '--case', 'adhf', '--from', file, '--out', out], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/went over its cap: \$24\.00 before it and \$2\.00 in it, over \$25/);
  });

  test('--from refuses samples that do not record the tree they were scored on', () => {
    const out = tmp();
    const file = path.join(out, 'old.samples.jsonl');
    const header = { run_id: 'ptb-old', date: '2026-11-04', build: 'NFCME-2026', cap_usd: 25, prior_usd: 0, samples: 3 };
    const sample = { case_id: 'adhf', tier_path_planned: 'BBB', sample: 1, tier_path: 'BBB', domains: DOMAINS, composite: 60, usd: 0.017, ...locked() };
    fs.writeFileSync(file, `${[header, sample].map((x) => JSON.stringify(x)).join('\n')}\n`);
    const res = spawnSync(process.execPath, [RUNNER, '--case', 'adhf', '--from', file, '--out', out], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/1 sample\(s\) were not scored on the current tree, first adhf BBB#1 on no recorded tree/);
  });

  test('without --go it checks every NFCME-2026 tree and spends nothing', () => {
    const res = run([]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Nothing spent/);
    expect(res.stdout).not.toMatch(/: refused, it /);
  });
});
