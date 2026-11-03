// The physician sandbox script (scripts/booth/sandbox.mjs, #252) apart from its booth-API parity, which
// booth.test.js proves next to the API it mirrors.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tapping, personaChooser, playOnce, jobsFor, runPlays, rimplCalls, PATHS } = require('../../scripts/booth/sandbox-play');

const KASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/booth-case-tree.json'), 'utf8'));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'booth', 'sandbox.mjs');
const EVAL_OK = { d1: 3, d2: 4, d3: 3, d4: 2, d5: 3, d6: 2, d7: 3, input_tokens: 20000, output_tokens: 2000, provider: 'anthropic' };
const CHAT_OK = { content: 'AI reply', pick: null, input_tokens: 3000, output_tokens: 200, provider: 'anthropic' };

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
    expect(play.usd).toBeCloseTo(0.05 + 2 * 0.012 + 0.30, 6);
  });

  test('every evaluate call has shadow off, so rimpl writes no shadow row', async () => {
    const ai = { chat: async () => CHAT_OK, evaluate: jest.fn(async () => EVAL_OK) };
    const play = await playOnce({ kase: KASE, choose: tapping(PATHS.weakest), ai });
    expect(ai.evaluate.mock.calls[0][0].shadow).toBe(false);
    expect(play.tier_path).toBe('WWW');
    expect(play.composite).toBe(59);
  });

  test('a persona that types sends its text as a typed answer, and one that answers badly taps and is counted', async () => {
    const replies = ['{"text": "ให้สารน้ำทางหลอดเลือด"}', 'no idea', '{"choice": "not-offered"}'];
    const ai = {
      persona: jest.fn(async () => ({ content: replies.shift(), input_tokens: 1500, output_tokens: 100, provider: 'anthropic' })),
      chat: jest.fn(async () => ({ ...CHAT_OK, tier: 'reasonable' })),
      evaluate: async () => EVAL_OK,
    };
    const typesFirst = [0, 0.9, 0.9];
    const play = await playOnce({ kase: KASE, choose: personaChooser('weak', { random: () => typesFirst.shift() }), ai });
    expect(ai.persona.mock.calls[0][0].messages[0].content).toMatch(/Type your own answer/);
    expect(ai.persona.mock.calls[1][0].messages[0].content).toMatch(/Pick the option/);
    expect(ai.chat.mock.calls[0][0].booth_typed).toBeDefined();
    expect(ai.chat.mock.calls[0][0].message).toContain('ให้สารน้ำทางหลอดเลือด');
    expect(play).toMatchObject({ typed: 1, fallbacks: 2 });
    expect(play.tier_path[0]).toBe('R');
  });
});

describe('runPlays', () => {
  const jobs = jobsFor([KASE], { personaRuns: 0 });

  test('plays each scripted path once and each persona per run', () => {
    expect(jobsFor([KASE], { personaRuns: 3 }).map((j) => j.group))
      .toEqual(['best', 'mixed', 'weakest', 'strong', 'strong', 'strong', 'average', 'average', 'average', 'weak', 'weak', 'weak']);
  });

  test('stops at the cap: a play starts only if its worst case still fits, and every later play is left unplayed', async () => {
    const play = jest.fn(async () => ({ usd: 0.2 }));
    const run = await runPlays([...jobs, ...jobs], { capUsd: 1, concurrency: 1, play });
    expect(play).toHaveBeenCalledTimes(3);
    expect(run.results.map((r) => r.skipped ?? 'played')).toEqual(['played', 'played', 'played', 'cap', 'cap', 'cap']);
    expect(run).toMatchObject({ spent_usd: 0.6, stopped: true });
  });
});

describe('sandbox.mjs', () => {
  test('without --go it prints the estimated spend and spends nothing', () => {
    const out = sandbox(['--cases', fixtureDir()]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/12 plays\. Estimated spend \$\d+\.\d+ typical, \$\d+\.\d+ if every call bills its worst case\. Cap \$30\./);
    expect(out.stdout).toMatch(/Nothing spent/);
  });

  test('refuses to run with a database client loaded', () => {
    const out = sandbox(['--cases', fixtureDir()], { node: ['-r', require.resolve('@supabase/supabase-js')] });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/refuses to run with a database client loaded/);
  });

  test('a cap below one play stops before any call and still writes the report', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-out-'));
    const out = sandbox(['--cases', fixtureDir(), '--persona-runs', '0', '--cap', '0.1', '--out', outDir, '--go'],
      { env: { INTERNAL_TOKEN: 't', RIMPL_URL: 'http://127.0.0.1:9' } });
    expect(out.status).toBe(1);
    const [json] = fs.readdirSync(outDir).filter((f) => f.endsWith('.json'));
    const report = JSON.parse(fs.readFileSync(path.join(outDir, json), 'utf8'));
    expect(report).toMatchObject({ stopped: true, scored: 0, planned: 3, spent_usd: 0 });
    expect(report.plays.every((p) => p.skipped === 'cap' && !p.calls)).toBe(true);
    expect(fs.readFileSync(path.join(outDir, json.replace(/\.json$/, '.md')), 'utf8')).toMatch(/stopped at the cap/);
  });
});
