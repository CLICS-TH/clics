// The path score table build's sample walk (#373, ADR 0009): one transcript along a tier path, with a random question
// variant and random same-tier options at each step and the case's sample replies as the AI's. Every step goes
// through the booth API's own chatOutcome (backend/src/services/booth-dialogue.js), so the transcript evaluateRequest
// builds from it is what a kiosk play on that path would hold. Also the checks on the sample replies and on the locked
// evaluator that the build applies to a saved run. Nothing here calls rimpl: live builds are off until #408.
// CommonJS so the backend's jest suite can prove it.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'backend', 'src');
const { STEPS, LETTER, bankAt, firstAsk, chatOutcome } = require(path.join(SRC, 'services', 'booth-dialogue'));
const { TIERS } = require(path.join(SRC, 'booth-cases', 'tree-schema'));
const LETTERS = TIERS.map((t) => t.letter);
const TIER_PATHS = LETTERS.flatMap((a) => LETTERS.flatMap((b) => LETTERS.map((c) => a + b + c)));
const REPLIES_DIR = path.join(__dirname, 'sample-replies');

/** A bank's key in a sample reply file: step1, step2.<tier>, step3.<tier><tier>. */
const bankKey = (prefix) => (prefix ? `step${prefix.length + 1}.${prefix}` : 'step1');
const prefixes = () => ['', ...LETTERS, ...LETTERS.flatMap((a) => LETTERS.map((b) => a + b))];

const tierOf = (bank, id) => LETTER[bank.options.find((o) => o.id === id).tier];

/** The AI's answer to the tap of `choice`: the sample reply and, before the last step, a random pick of the next bank. */
function sampleRes(kase, replies, prefix, choice, letter) {
  const reply = replies[bankKey(prefix)]?.[choice];
  if (!reply) throw new Error(`${kase.case_id}: no sample reply for ${bankKey(prefix)} ${choice}`);
  if (prefix.length + 1 === STEPS) return { reply };
  const next = firstAsk(bankAt(kase, prefix + letter));
  return { reply, pick: { variant_id: next.variant, option_ids: next.options, bridge: '' } };
}

/** A sample along `tierPath`: at each step the random offered option of that tier, tapped. Step 1's ask is drawn as
 *  the booth draws it; each later ask is the sample's random pick, issued through chatOutcome. */
function sampleWalk(kase, replies, tierPath) {
  let d = { answers: [], replies: [], asks: [firstAsk(kase.banks.step1)], tierPath: '' };
  for (let step = 0; step < STEPS; step += 1) {
    const bank = bankAt(kase, d.tierPath);
    const choice = d.asks[step].options.find((id) => tierOf(bank, id) === tierPath[step]);
    const walked = { ...d, answers: [...d.answers, { choice }], tierPath: d.tierPath + tierPath[step] };
    const out = chatOutcome(kase, walked, sampleRes(kase, replies, d.tierPath, choice, tierPath[step]));
    d = { answers: out.answers, replies: out.replies, asks: out.asks, tierPath: out.tierPath };
  }
  return d;
}

const THAI = /[฀-๿]/;

/** Every reason a case's sample replies are not usable, as "<bank> <option>: <problem>". A reply must be on every
 *  option, Thai, with strength and weigh, no double quote, and come through the booth API's reply checks unchanged
 *  (field length, bold runs) under every question variant. */
function replyProblems(kase, replies) {
  return prefixes().flatMap((prefix) => {
    const bank = bankAt(kase, prefix);
    return bank.options.flatMap((option) => {
      const at = `${bankKey(prefix)} ${option.id}`;
      const r = replies[bankKey(prefix)]?.[option.id];
      if (!r) return [`${at}: no reply`];
      const problems = [];
      if (Object.keys(r).sort().join() !== 'safety,strength,weigh') problems.push('fields must be strength, weigh and safety');
      for (const k of ['strength', 'weigh']) if (typeof r[k] !== 'string' || !THAI.test(r[k])) problems.push(`${k} is not Thai text`);
      if (typeof r.safety !== 'string' || (r.safety && !THAI.test(r.safety))) problems.push('safety is not "" or Thai text');
      if (Object.values(r).some((v) => typeof v === 'string' && v.includes('"'))) problems.push('has a double quote');
      if (problems.length) return problems.map((p) => `${at}: ${p}`);
      // The booth's checks read the question asked, so the reply must come through them unchanged under each variant.
      const changed = bank.variants.map((v) => shownReply(kase, prefix, option, v.id, r)).find((s) => JSON.stringify(s) !== JSON.stringify(r));
      return changed ? [`${at}: the booth's reply checks change it to ${JSON.stringify(changed)}`] : [];
    });
  });
}

// The reply as chatOutcome would issue it for a tap of `option` under `variant`. Only the last answer, its ask and
// the tier path matter to the checks, so earlier steps are placeholders.
function shownReply(kase, prefix, option, variant, reply) {
  const n = prefix.length + 1;
  const d = {
    answers: [...Array.from({ length: n - 1 }, () => ({ choice: '' })), { choice: option.id }],
    replies: Array.from({ length: n - 1 }, () => ({})),
    asks: Array.from({ length: n }, () => ({ variant, bridge: '', options: [] })),
    tierPath: prefix + LETTER[option.tier],
  };
  return chatOutcome(kase, d, { reply }).replies[n - 1];
}

/** A case's sample replies from `dir`, keyed by bank then option id. */
function readReplies(kase, dir = path.join(REPLIES_DIR, kase.event_code)) {
  const file = path.join(dir, `${kase.case_id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.case_id !== kase.case_id) throw new Error(`${file} is for ${raw.case_id}, not ${kase.case_id}`);
  return raw.replies;
}

/** Every evaluator call a build makes: `samples` per sampled tier path (`pathsOf` the case), per case. */
const jobsFor = (cases, samples = 3, pathsOf = () => TIER_PATHS) => cases.flatMap((kase) => pathsOf(kase).flatMap((tierPath) =>
  Array.from({ length: samples }, (_, i) => ({ kase, tierPath, sample: i + 1 }))));

// The locked evaluator, as rimpl's committed model manifest declares it for the API: what every table sample must have
// been scored by.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'rimpl', 'src', 'model-manifest.json'), 'utf8')).expected.code;
const LOCKED = Object.freeze({
  provider: 'anthropic',
  model: MANIFEST.anthropic.model,
  prompt_version: MANIFEST.evaluator.prompt_version.anthropic,
  prompt_sha256: MANIFEST.evaluator.prompt_sha256.anthropic,
  temperature: MANIFEST.decoding.evaluate.temperature,
  max_tokens: MANIFEST.decoding.evaluate.max_tokens,
});

/** Why a scored sample was not scored by the locked evaluator, or [] when it was. */
function lockProblems(sample) {
  const seen = { provider: sample?.provider, model: sample?.model, prompt_version: sample?.prompt_version,
    temperature: sample?.decoding?.temperature, max_tokens: sample?.decoding?.max_tokens };
  return Object.entries(seen).filter(([k, v]) => v !== LOCKED[k]).map(([k, v]) => `${k} ${v ?? 'none'}, locked ${LOCKED[k]}`);
}

// Checks the sample replies of the named cases: node scripts/booth/path-table-sample.js <case_id> [...]
if (require.main === module) {
  const { CaseTreeSchema } = require(path.join(SRC, 'booth-cases', 'tree-schema'));
  const dir = path.join(SRC, 'booth-cases', 'NFCME-2026');
  let bad = 0;
  for (const id of process.argv.slice(2)) {
    const kase = CaseTreeSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')));
    const problems = replyProblems(kase, readReplies(kase));
    bad += problems.length;
    console.log(problems.length ? `${id}: ${problems.length} problem(s)\n${problems.join('\n')}` : `${id}: ok`);
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { TIER_PATHS, LOCKED, bankKey, sampleWalk, replyProblems, readReplies, jobsFor, lockProblems };
