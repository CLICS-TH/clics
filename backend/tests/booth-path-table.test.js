// The path score table build's sample walk (scripts/booth/path-table-sample.js, #373) and its runner's guards.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isValidAsk } = require('../src/services/booth-dialogue');
const { TIER_PATHS, bankKey, sampleWalk, replyProblems, jobsFor, scoreSample } = require('../../scripts/booth/path-table-sample');

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

describe('the build runner', () => {
  const run = (args) => spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });

  test.each([['--cap', '25.01'], ['--samples', '2']])('refuses %s %s: the cap is at most $25 and a median needs an odd count', (flag, v) => {
    const res = run([flag, v]);
    expect(res.status).toBe(2);
  });

  test('without --go it checks every NFCME-2026 tree and spends nothing', () => {
    const res = run([]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Nothing spent/);
    expect(res.stdout).not.toMatch(/refused/);
  });
});
