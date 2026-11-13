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
const { PATHS, PATHS_BY_STEPS, worstCall } = require('../../scripts/booth/sandbox-play');
const { costUsd } = require('../src/lib/pricing');
const MANIFEST = require('../../rimpl/src/model-manifest.json').expected.code;

const KASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8'));
const KASE5 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree-5.json'), 'utf8'));
const LETTER = { best: 'B', reasonable: 'R', weaker: 'W' };
const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'booth', 'build-path-tables.mjs');
const LEDGER_TOOL = path.join(__dirname, '..', '..', 'scripts', 'booth', 'spend-ledger.mjs');
const RESERVER = path.join(__dirname, 'fixtures', 'spend-reserver.mjs');
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
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ptb-'));
  // Every run gets a HOME of its own, so no test reads or writes this machine's spend ledger.
  const envOf = (env) => ({ PATH: process.env.PATH, HOME: tmp(), ...env });
  const run = (args, env = {}) => spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env: envOf(env) });

  // The scripts a run loads from scripts/booth, and this repo's committed spend record, which no test may write.
  const RUNNER_FILES = ['build-path-tables.mjs', 'spend-ledger.mjs', 'path-table.mjs', 'path-fit.mjs', 'sandbox-verdict.mjs',
    'path-table-sample.js', 'sandbox-play.js'];
  const RECORD = path.join(path.dirname(RUNNER), 'path-table-runs', 'spend.jsonl');
  const recordAtStart = fs.readFileSync(RECORD, 'utf8');
  afterAll(() => expect(fs.readFileSync(RECORD, 'utf8')).toBe(recordAtStart));
  /** A throwaway checkout of the runner, committed in a git repo of its own: its scripts copied, backend and rimpl
   *  linked, and `record` as its committed spend record. A --go run writes that record, never this repo's. */
  function checkout(record = recordAtStart) {
    // Its real path: spend-ledger.mjs runs init only when argv[1] is its own resolved path.
    const root = fs.realpathSync(tmp());
    const booth = path.join(root, 'scripts', 'booth');
    fs.mkdirSync(path.join(booth, 'path-table-runs'), { recursive: true });
    for (const f of RUNNER_FILES) fs.copyFileSync(path.join(path.dirname(RUNNER), f), path.join(booth, f));
    for (const layer of ['backend', 'rimpl']) fs.symlinkSync(path.join(__dirname, '..', '..', layer), path.join(root, layer));
    fs.writeFileSync(path.join(booth, 'path-table-runs', 'spend.jsonl'), record);
    const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'checkout');
    return { git, runner: path.join(booth, 'build-path-tables.mjs'), ledgerTool: path.join(booth, 'spend-ledger.mjs'),
      record: path.join(booth, 'path-table-runs', 'spend.jsonl') };
  }
  let shared;
  // The checkout every other --go run uses: its record collects their open and charge lines.
  const sharedRunner = () => { shared ??= checkout(); return shared.runner; };
  const initIn = (co, home) => spawnSync(process.execPath, [co.ledgerTool, 'init'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });

  const runAsync = (args, env = {}, runner = sharedRunner()) => new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, ...args], { env: envOf(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  test.each([
    ['--cap', '25.01', /--cap needs a number from 0\.01 to 25\b/],
    ['--samples', '2', /--samples must be odd/],
  ])('refuses %s %s: the cap is at most $25 and a median needs an odd count', (flag, v, why) => {
    const res = run([flag, v]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(why);
  });

  const ledgerFile = (home) => path.join(home, '.clics', 'booth-spend', 'ledger.jsonl');
  const INIT = { kind: 'init', at: '2026-11-13T00:00:00.000Z', seeded_from: 'test' };
  /** A HOME whose spend ledger holds `lines` after its init line. */
  const homeWith = (...lines) => {
    const home = tmp();
    fs.mkdirSync(path.dirname(ledgerFile(home)), { recursive: true });
    fs.writeFileSync(ledgerFile(home), [INIT, ...lines].map((l) => `${JSON.stringify(l)}\n`).join(''));
    return home;
  };
  const ledgerOf = (home) => (fs.existsSync(ledgerFile(home))
    ? fs.readFileSync(ledgerFile(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // Spend as the cap counts it: each charge, and each reservation at its settled cost or, never settled, its worst case.
  const spentIn = (lines) => {
    const settled = new Map(lines.filter((l) => l.kind === 'settle').map((l) => [l.id, l.usd]));
    return lines.reduce((acc, l) => acc + (l.kind === 'charge' ? l.usd : l.kind === 'reserve' ? (settled.get(l.id) ?? l.usd) : 0), 0);
  };
  const goEnv = (home, rimpl) => ({ HOME: home, INTERNAL_TOKEN: 't', RIMPL_URL: rimpl.url });

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

  /** A stub rimpl that records every request. GET /manifest answers `manifest` (default: `retries` provider retries,
   *  200); POST /evaluate answers `answer` after `delayMs`, or never when it is null. `billed` is what the answered
   *  calls cost at their reported tokens. */
  async function stubRimpl({ retries = 0, answer = null, delayMs = 0, manifest } = {}) {
    const stub = { calls: [], billed: 0 };
    stub.server = http.createServer((req, res) => {
      stub.calls.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/manifest') {
          const { status = 200, body = { provider_retries: { anthropic: retries } } } = manifest ?? {};
          res.statusCode = status;
          res.end(JSON.stringify(body));
        } else if (answer) {
          setTimeout(() => {
            stub.billed += costUsd(answer.input_tokens, answer.output_tokens, answer.provider);
            res.end(JSON.stringify(answer));
          }, delayMs);
        }
      });
    });
    await new Promise((r) => stub.server.listen(0, '127.0.0.1', r));
    stub.url = `http://127.0.0.1:${stub.server.address().port}`;
    stub.close = () => { stub.server.closeAllConnections(); stub.server.close(); };
    return stub;
  }

  /** Starts a --go run, waits for its first evaluate request and kills the run there, mid-call. */
  async function killMidCall(args, home, rimpl, runner = sharedRunner()) {
    const child = spawn(process.execPath, [runner, '--go', ...args], { env: envOf(goEnv(home, rimpl)) });
    const exited = new Promise((r) => child.on('close', r));
    for (let i = 0; i < 400 && !rimpl.calls.includes('POST /evaluate'); i += 1) await new Promise((r) => setTimeout(r, 25));
    child.kill('SIGKILL');
    await exited;
  }

  test('two runs at once share one cap: what rimpl billed them together, and the ledger, stay within it', async () => {
    const home = homeWith();
    const { args } = throwawayBuild();
    // Each call bills $0.30 of its $0.33 worst case, so a $1.15 cap holds three.
    const rimpl = await stubRimpl({ answer: locked({ input_tokens: 60_000, output_tokens: 8000 }), delayMs: 30 });
    const cap = 1.15;
    try {
      const [a, b] = await Promise.all([
        runAsync([...args, '--go', '--cap', String(cap)], goEnv(home, rimpl)),
        runAsync([...args, '--go', '--cap', String(cap), '--out', tmp()], goEnv(home, rimpl)),
      ]);
      expect(rimpl.billed).toBeLessThanOrEqual(cap);
      expect(spentIn(ledgerOf(home))).toBeLessThanOrEqual(cap);
      expect(rimpl.billed).toBeGreaterThan(cap / 2);
      expect([a.status, b.status]).not.toContain(0);
    } finally {
      rimpl.close();
    }
  }, 30_000);

  test('eight processes reserving at once against one ledger are granted exactly what the cap holds, never more', async () => {
    const home = homeWith();
    const start = path.join(tmp(), 'start');
    const [usd, k, procs] = [1, 12, 8];
    const children = Array.from({ length: procs }, () => {
      const child = spawn(process.execPath, [RESERVER, LEDGER_TOOL, start, String(usd), String(k * usd), String(2 * k)],
        { env: { PATH: process.env.PATH, HOME: home } });
      let out = '';
      let err = '';
      child.stderr.on('data', (b) => { err += b; });
      const ready = new Promise((r) => { child.stdout.on('data', (b) => { out += b; if (out.includes('ready\n')) r(); }); child.on('close', r); });
      const done = new Promise((r) => child.on('close', (status) => r({ status, out, err })));
      return { ready, done };
    });
    await Promise.all(children.map((c) => c.ready));
    fs.writeFileSync(start, '');
    const results = await Promise.all(children.map((c) => c.done));
    expect(results.map((r) => [r.status, r.err])).toEqual(results.map(() => [0, '']));
    const granted = results.flatMap((r) => JSON.parse(r.out.split('\n')[1]));
    const reserved = ledgerOf(home).filter((l) => l.kind === 'reserve').map((l) => l.id);
    expect(granted).toHaveLength(k);
    expect(reserved.sort()).toEqual([...granted].sort());
    expect(spentIn(ledgerOf(home))).toBeLessThanOrEqual(k * usd);
  }, 30_000);

  test('--go with no spend ledger in HOME is refused before any request, naming where the ledger should be', async () => {
    const home = tmp();
    const { args } = throwawayBuild();
    const rimpl = await stubRimpl({ answer: locked() });
    try {
      const res = await runAsync([...args, '--go'], goEnv(home, rimpl));
      expect(rimpl.calls).toEqual([]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain(`${ledgerFile(home)} does not exist`);
    } finally {
      rimpl.close();
    }
  });

  test('a copy of a build under another event code sees its spend: once one has used the cap, the other gets no call', async () => {
    const home = homeWith();
    const [first, copy] = [throwawayBuild(), throwawayBuild()];
    // Each call settles at $0.18, so one at a time a $1 cap stops the first build after four, at $0.72.
    const rimpl = await stubRimpl({ answer: locked({ input_tokens: 40_000, output_tokens: 4000 }) });
    try {
      expect((await runAsync([...first.args, '--go', '--cap', '1', '--concurrency', '1'], goEnv(home, rimpl))).status).toBe(1);
      const before = rimpl.calls.length;
      const res = await runAsync([...copy.args, '--go', '--cap', '1'], goEnv(home, rimpl));
      expect(rimpl.calls.length).toBe(before);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/no room for a call's worst case/);
    } finally {
      rimpl.close();
    }
  });

  test('the ledger is in HOME, not the checkout: a call reserved by a run killed in one case repo counts for a run from another', async () => {
    const home = homeWith();
    const [one, other] = [throwawayBuild(), throwawayBuild()];
    const hung = await stubRimpl({ retries: 2 });
    const rimpl = await stubRimpl({ answer: locked() });
    try {
      await killMidCall(one.args, home, hung);
      // The killed call holds 3 × $0.33, so a $1.20 cap has no room for another $0.33.
      const res = await runAsync([...other.args, '--go', '--cap', '1.2'], goEnv(home, rimpl));
      expect(rimpl.calls).toEqual([]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/have spent \$0\.99 of the \$1\.2 cap/);
    } finally {
      hung.close();
      rimpl.close();
    }
  }, 20_000);

  test.each([
    ['no bytes at all', '', /is empty/],
    ['a first line that is not init', `${JSON.stringify({ kind: 'charge', run_id: 'r', usd: 1 })}\n`, /does not start with an init line/],
    ['a line that does not parse', `${JSON.stringify(INIT)}\n{"kind":"charge",\n`, /line 2 is not JSON/],
    ['a line of an unknown kind', `${JSON.stringify(INIT)}\n${JSON.stringify({ kind: 'refund', run_id: 'r', usd: 5 })}\n`, /line 2 is not an init, charge, reserve or settle line/],
  ])('a ledger with %s refuses --go before any request', async (_name, text, why) => {
    const home = homeWith();
    fs.writeFileSync(ledgerFile(home), text);
    const { args } = throwawayBuild();
    const rimpl = await stubRimpl({ answer: locked() });
    try {
      const res = await runAsync([...args, '--go'], goEnv(home, rimpl));
      expect(rimpl.calls).toEqual([]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain(ledgerFile(home));
      expect(res.stderr).toMatch(why);
    } finally {
      rimpl.close();
    }
  });

  test('a run killed mid-call leaves that call reserved at its worst case, from the retries rimpl reports', async () => {
    const home = homeWith();
    const { args } = throwawayBuild();
    const rimpl = await stubRimpl({ retries: 2 });
    try {
      await killMidCall(args, home, rimpl);
      expect(rimpl.calls).toEqual(['GET /manifest', 'POST /evaluate']);
      expect(ledgerOf(home).slice(1).map(({ kind, usd }) => ({ kind, usd }))).toEqual([{ kind: 'reserve', usd: expect.closeTo(3 * worstCall('evaluate'), 6) }]);
    } finally {
      rimpl.close();
    }
  }, 20_000);

  test('a probe scored by any model but the locked evaluator stops the build after that one call, settled and charged, and writes no table', async () => {
    const home = homeWith();
    const { dir, args } = throwawayBuild();
    const out = args[args.indexOf('--out') + 1];
    const rimpl = await stubRimpl({ answer: locked({ provenance: { ...locked().provenance, model: 'claude-opus-5-5' } }) });
    const caseFile = path.join(dir, `${KASE.case_id}.json`);
    const before = fs.readFileSync(caseFile, 'utf8');
    try {
      const res = await runAsync(['--go', ...args], goEnv(home, rimpl));
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/the probe was not scored by the locked evaluator: model claude-opus-5-5/);
      expect(rimpl.calls).toEqual(['GET /manifest', 'POST /evaluate']);
      expect(ledgerOf(home).slice(1).map((l) => l.kind)).toEqual(['reserve', 'settle']);
      const record = fs.readFileSync(path.join(out, 'spend.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(record).toEqual([{ kind: 'charge', run_id: expect.stringMatching(/^ptb-/), usd: expect.closeTo(rimpl.billed, 6),
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), build: expect.stringMatching(/^TST-/) }]);
    } finally {
      rimpl.close();
      expect(fs.readFileSync(caseFile, 'utf8')).toBe(before);
    }
  });

  test('a /manifest that is not a 200 is refused even when it reports provider_retries, before any evaluate call', async () => {
    const { args } = throwawayBuild();
    const rimpl = await stubRimpl({ answer: locked(), manifest: { status: 500, body: { provider_retries: { anthropic: 0 } } } });
    try {
      const res = await runAsync([...args, '--go'], goEnv(homeWith(), rimpl));
      expect(rimpl.calls).toEqual(['GET /manifest']);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/GET \/manifest answered 500/);
    } finally {
      rimpl.close();
    }
  });

  test('init seeds the ledger with the committed record\'s $30.49, refuses to run twice, and so refuses every --go at the $25 cap', async () => {
    const home = tmp();
    const co = checkout();
    const init = () => initIn(co, home);
    expect(init().status).toBe(0);
    expect(fs.existsSync(ledgerFile(home))).toBe(true);
    const seeded = fs.readFileSync(ledgerFile(home), 'utf8');
    expect(ledgerOf(home)[0]).toMatchObject({ kind: 'init', seeded_from: 'scripts/booth/path-table-runs/spend.jsonl' });
    expect(spentIn(ledgerOf(home))).toBeCloseTo(30.49, 6);
    const again = init();
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already exists/);
    expect(fs.readFileSync(ledgerFile(home), 'utf8')).toBe(seeded);
    expect(fs.readdirSync(path.dirname(ledgerFile(home)))).toEqual(['ledger.jsonl']);
    const rimpl = await stubRimpl({ answer: locked() });
    try {
      const res = await runAsync([...throwawayBuild().args, '--go'], goEnv(home, rimpl));
      expect(rimpl.calls).toEqual([]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/have spent \$30\.49 of the \$25 cap/);
    } finally {
      rimpl.close();
    }
  });

  test('a fresh init over the committed record seeds at least what runs killed mid-call or sent to another --out spent', async () => {
    const co = checkout(`${JSON.stringify({ kind: 'charge', run_id: 'ptb-earlier', usd: 1, date: '2026-11-01', build: 'TST' })}\n`);
    const homeA = tmp();
    expect(initIn(co, homeA).status).toBe(0);
    const rimpl = await stubRimpl({ answer: locked() });
    const hung = await stubRimpl({ retries: 2 });
    try {
      // Each throwaway build writes to an --out of its own, never the checkout's record folder.
      await runAsync([...throwawayBuild().args, '--go', '--cap', '5'], goEnv(homeA, rimpl), co.runner);
      expect(rimpl.calls).toContain('POST /evaluate');
      await killMidCall([...throwawayBuild().args, '--cap', '5'], homeA, hung, co.runner);
      expect(hung.calls).toEqual(['GET /manifest', 'POST /evaluate']);
    } finally {
      rimpl.close();
      hung.close();
    }
    // The operator commits the record, then a new machine (a fresh HOME) inits from it.
    co.git('commit', '-qam', 'record', '--allow-empty');
    const homeB = tmp();
    const res = initIn(co, homeB);
    expect(res.stderr).toBe('');
    expect(spentIn(ledgerOf(homeB))).toBeGreaterThanOrEqual(spentIn(ledgerOf(homeA)));
  }, 60_000);

  test.each([
    ['truncated to its first run', (raw) => `${raw.split('\n')[0]}\n`],
    ['with a charge edited down', (raw) => raw.replace('"usd":15.23', '"usd":0.23')],
  ])('init refuses a working-tree record %s, since only the record at HEAD proves the spend, and creates no ledger', (_name, edit) => {
    const co = checkout();
    fs.writeFileSync(co.record, edit(fs.readFileSync(co.record, 'utf8')));
    const home = tmp();
    const res = initIn(co, home);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/differs from the record committed at HEAD/);
    expect(fs.existsSync(ledgerFile(home))).toBe(false);
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
    const rimpl = await stubRimpl({ answer: locked() });
    try {
      const res = await runAsync([...args, '--from', file], goEnv(tmp(), rimpl));
      expect(rimpl.calls).toEqual([]);
      expect([0, 1]).toContain(res.status);
      const built = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
      expect(built.version).toBe(String(Number(kase.version) + 1));
      expect(built.path_score_table.provenance).toMatchObject({ run_id: 'ptb-saved', tree_sha256: treeSha(kase) });
      expect(built.path_score_table.paths.BBB).toEqual(DOMAINS);
    } finally {
      rimpl.close();
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
    const res = run(['--case', 'adhf', '--from', file, '--out', out]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/went over its cap: \$24\.00 before it and \$2\.00 in it, over \$25/);
  });

  test('--from refuses samples that do not record the tree they were scored on', () => {
    const out = tmp();
    const file = path.join(out, 'old.samples.jsonl');
    const header = { run_id: 'ptb-old', date: '2026-11-04', build: 'NFCME-2026', cap_usd: 25, prior_usd: 0, samples: 3 };
    const sample = { case_id: 'adhf', tier_path_planned: 'BBB', sample: 1, tier_path: 'BBB', domains: DOMAINS, composite: 60, usd: 0.017, ...locked() };
    fs.writeFileSync(file, `${[header, sample].map((x) => JSON.stringify(x)).join('\n')}\n`);
    const res = run(['--case', 'adhf', '--from', file, '--out', out]);
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
