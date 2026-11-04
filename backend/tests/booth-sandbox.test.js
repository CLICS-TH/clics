// The physician sandbox script (scripts/booth/sandbox.mjs, #252) apart from its booth-API parity, which
// booth.test.js proves next to the API it mirrors.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tapping, personaChooser, playOnce, jobsFor, runPlays, rimplCalls, worstCall, PATHS } = require('../../scripts/booth/sandbox-play');

const KASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8'));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'booth', 'sandbox.mjs');
const EVAL_OK = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 3, d6: 2, d7: 3, input_tokens: 20000, output_tokens: 2000, provider: 'anthropic' };
const CHAT_OK = { reply: { strength: 'นึกถึง **ไข้** ก่อน', weigh: 'worth weighing', safety: '' }, pick: null,
  input_tokens: 3000, output_tokens: 200, provider: 'anthropic' };

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-cases-'));
  fs.writeFileSync(path.join(dir, `${KASE.case_id}.json`), JSON.stringify(KASE));
  return dir;
}
const sandbox = (args, { env = {}, node = [] } = {}) => spawnSync(process.execPath, [...node, SCRIPT, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
});

describe('rimpl calls', () => {
  test('post only to rimpl /chat and /evaluate, with the internal token', async () => {
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push([String(url), init.method, init.headers['x-internal-token']]);
      return { ok: true, json: async () => ({}) };
    };
    const calls = rimplCalls({ url: 'http://localhost:3003', token: 't', fetchImpl });
    expect(Object.keys(calls)).toEqual(['chat', 'evaluate']);
    await calls.chat({});
    await calls.evaluate({});
    expect(urls).toEqual([['http://localhost:3003/chat', 'POST', 't'], ['http://localhost:3003/evaluate', 'POST', 't']]);
  });

  test.each(['http://localhost:3001/booth/plays', 'http://localhost:3003/?x=1'])('refuse a base URL with a path or query: %s', (url) => {
    expect(() => rimplCalls({ url, token: 't', fetchImpl: jest.fn() })).toThrow(/bare origin/);
  });
});

describe('playOnce', () => {
  test('a failed chat takes the booth fallback and the play goes on; a failed evaluate leaves it unscored at worst-case cost', async () => {
    const ai = {
      chat: jest.fn().mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'TimeoutError' })).mockResolvedValue(CHAT_OK),
      evaluate: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 502 })),
    };
    const play = await playOnce({ kase: KASE, choose: tapping(PATHS.best), ai });
    expect(ai.chat).toHaveBeenCalledTimes(3);
    expect(play.tier_path).toBe('BBB');
    expect(play.composite).toBeNull();
    expect(play.calls.map((c) => c.error ?? 'ok')).toEqual(['TimeoutError', 'ok', 'ok', '502']);
    expect(play.usd).toBeCloseTo(worstCall('chat') + 2 * 0.012 + worstCall('evaluate'), 6);
  });

  test('every evaluate call has shadow off, so rimpl writes no shadow row', async () => {
    const ai = { chat: async () => CHAT_OK, evaluate: jest.fn(async () => EVAL_OK) };
    const play = await playOnce({ kase: KASE, choose: tapping(PATHS.weakest), ai });
    expect(ai.evaluate.mock.calls[0][0].shadow).toBe(false);
    expect(play.tier_path).toBe('WWW');
    expect(play.composite).toBe(59);
  });

  const personaAi = (replies) => ({
    persona: jest.fn(async () => {
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return { content: r, input_tokens: 1500, output_tokens: 100, provider: 'anthropic' };
    }),
    chat: jest.fn(async () => ({ ...CHAT_OK, tier: 'reasonable' })),
    evaluate: jest.fn(async () => EVAL_OK),
  });

  test('a persona that types sends its text as a typed answer; one unusable answer taps and is counted', async () => {
    const ai = personaAi(['{"text": "ให้สารน้ำทางหลอดเลือด"}', 'no idea', '{"text": "ส่งต่อโรงพยาบาลจังหวัด"}']);
    const typing = [0, 0.9, 0];
    const play = await playOnce({ kase: KASE, choose: personaChooser('weak', { random: () => typing.shift() }), ai });
    expect(ai.persona.mock.calls[0][0].messages[0].content).toMatch(/Type your own answer/);
    expect(ai.persona.mock.calls[1][0].messages[0].content).toMatch(/Pick the option/);
    expect(ai.persona.mock.calls[1][0].messages[0].content).toContain('Tutor: นึกถึง ไข้ ก่อน worth weighing\n');
    expect(ai.chat.mock.calls[0][0].booth_typed).toBeDefined();
    expect(ai.chat.mock.calls[0][0].message).toContain('ให้สารน้ำทางหลอดเลือด');
    expect(play).toMatchObject({ typed: 2, fallbacks: 1, composite: 59 });
    expect(play.tier_path[0]).toBe('R');
  });

  test('a persona call that fails (a bad key answers 401) abandons the play unscored, before any rimpl call', async () => {
    const ai = personaAi([Object.assign(new Error('persona model answered 401'), { status: 401 })]);
    const play = await playOnce({ kase: KASE, choose: personaChooser('strong'), ai });
    expect(play).toMatchObject({ composite: null, error: 'persona call failed' });
    expect(ai.chat).not.toHaveBeenCalled();
    expect(ai.evaluate).not.toHaveBeenCalled();
    expect(play.calls).toEqual([expect.objectContaining({ kind: 'persona', error: '401', usd: worstCall('persona') })]);
  });

  test('a second unusable persona answer abandons the play rather than score random taps', async () => {
    const ai = personaAi(['no idea', '{"choice": "not-offered"}']);
    const play = await playOnce({ kase: KASE, choose: personaChooser('average', { random: () => 0.9 }), ai });
    expect(play).toMatchObject({ composite: null, fallbacks: 1, error: 'more than 1 unusable persona answer' });
    expect(play.unusable_answers).toEqual([
      { step: 1, typing: false, content: 'no idea' }, { step: 2, typing: false, content: '{"choice": "not-offered"}' },
    ]);
    expect(ai.chat).toHaveBeenCalledTimes(1);
    expect(ai.evaluate).not.toHaveBeenCalled();
  });
});

describe('runPlays', () => {
  const jobs = jobsFor([KASE], { pathRuns: 1, personaRuns: 0 });

  test('plays each scripted path and each persona 3 times by default, and each as often as asked', () => {
    const three = ['best', 'mixed', 'weakest', 'strong', 'average', 'weak'].flatMap((g) => [g, g, g]);
    expect(jobsFor([KASE]).map((j) => j.group)).toEqual(three);
    expect(jobsFor([KASE], { pathRuns: 2, personaRuns: 1 }).map((j) => `${j.group}#${j.run}`))
      .toEqual(['best#1', 'best#2', 'mixed#1', 'mixed#2', 'weakest#1', 'weakest#2', 'strong#1', 'average#1', 'weak#1']);
  });

  test('stops at the cap: a play starts only if its worst case still fits, and every later play is left unplayed', async () => {
    const play = jest.fn(async () => ({ usd: 0.2 }));
    const run = await runPlays([...jobs, ...jobs], { capUsd: 1, concurrency: 1, play });
    expect(play).toHaveBeenCalledTimes(3);
    expect(run.results.map((r) => r.skipped ?? 'played')).toEqual(['played', 'played', 'played', 'cap', 'cap', 'cap']);
    expect(run).toMatchObject({ spent_usd: 0.6, stopped: true, over_cap: false });
  });

  test('a play that costs more than its worst case marks the run over the cap', async () => {
    const run = await runPlays(jobs.slice(0, 1), { capUsd: 1, play: async () => ({ usd: 1.5 }) });
    expect(run).toMatchObject({ spent_usd: 1.5, stopped: false, over_cap: true });
  });
});

describe('sandbox.mjs', () => {
  test('without --go it prints the estimated spend and spends nothing', () => {
    const out = sandbox(['--cases', fixtureDir()]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/18 plays\. Estimated spend \$\d+\.\d+ typical, \$\d+\.\d+ if every call bills its worst case\. Cap \$30\./);
    expect(out.stdout).toMatch(/Nothing spent/);
  });

  test.each([
    ['stopped at the cap', { stopped: true, scored: 20, planned: 36 }, /20 of 36 plays scored, stopped at the cap/],
    ['with a play unscored, from before #344 pooled only complete groups', { scored: 35, planned: 36 }, /35 of 36 plays scored\)/],
    ['over the cap', { over_cap: true, scored: 36, planned: 36 }, /over the cap/],
  ])('refuses a --pool report from a run %s', (_, run, message) => {
    const groups = ['best', 'mixed', 'weakest'];
    const pool = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-pool-')), 'partial.json');
    fs.writeFileSync(pool, JSON.stringify({ stopped: false, over_cap: false, ...run, verdict: {
      medians: Object.fromEntries(groups.map((g) => [g, 60])), pool_n: Object.fromEntries(groups.map((g) => [g, 11])),
    } }));
    const out = sandbox(['--cases', fixtureDir(), '--persona-runs', '0', '--pool', pool]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/is from an incomplete run/);
    expect(out.stderr).toMatch(message);
  });

  test('accepts a --pool report with an unscored play once its medians pool only complete groups', () => {
    const groups = ['best', 'mixed', 'weakest'];
    const pool = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-pool-')), 'partial.json');
    fs.writeFileSync(pool, JSON.stringify({ stopped: false, over_cap: false, scored: 197, planned: 198, verdict: {
      medians: Object.fromEntries(groups.map((g) => [g, 60])), pool_n: Object.fromEntries(groups.map((g) => [g, 11])), gap_min: 6.59,
    } }));
    const out = sandbox(['--cases', fixtureDir(), '--persona-runs', '0', '--pool', pool]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/Nothing spent/);
  });

  test('the worst-case reservation follows the configured token rates', () => {
    const worst = (env) => Number(sandbox(['--cases', fixtureDir()], { env }).stdout.match(/\$([\d.]+) if every call/)[1]);
    expect(worst({ CLAUDE_INPUT_PER_M: '6', CLAUDE_OUTPUT_PER_M: '30' })).toBeCloseTo(2 * worst({}), 1);
  });

  test('refuses to run with a database client loaded', () => {
    const out = sandbox(['--cases', fixtureDir()], { node: ['-r', require.resolve('@supabase/supabase-js')] });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/refuses to run with a database client loaded/);
  });

  test('refuses a --pool report whose medians come from fewer than 3 cases', () => {
    const groups = ['best', 'mixed', 'weakest'];
    const pool = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-pool-')), 'thin.json');
    fs.writeFileSync(pool, JSON.stringify({ stopped: false, over_cap: false, scored: 36, planned: 36, verdict: {
      medians: Object.fromEntries(groups.map((g) => [g, 60])), pool_n: { best: 3, mixed: 3, weakest: 1 },
    } }));
    const out = sandbox(['--cases', fixtureDir(), '--persona-runs', '0', '--pool', pool]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/no median from 3 or more cases for weakest/);
  });

  test('a cap below one play stops before any call and still writes the report', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-out-'));
    const out = sandbox(['--cases', fixtureDir(), '--persona-runs', '0', '--cap', '0.1', '--out', outDir, '--go'],
      { env: { INTERNAL_TOKEN: 't', RIMPL_URL: 'http://127.0.0.1:9' } });
    expect(out.status).toBe(1);
    const [json] = fs.readdirSync(outDir).filter((f) => f.endsWith('.json'));
    const report = JSON.parse(fs.readFileSync(path.join(outDir, json), 'utf8'));
    expect(report).toMatchObject({ stopped: true, scored: 0, planned: 9, path_runs: 3, spent_usd: 0 });
    expect(report.plays.every((p) => p.skipped === 'cap' && !p.calls)).toBe(true);
    expect(fs.readFileSync(path.join(outDir, json.replace(/\.json$/, '.md')), 'utf8')).toMatch(/stopped at the cap/);
  });
});
