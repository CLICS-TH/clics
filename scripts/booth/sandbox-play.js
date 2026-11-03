// The physician sandbox's play loop (#252, ADR 0005): one booth grill play of a candidate case through rimpl's booth
// chat and the unchanged evaluator, with the booth API's own request and transcript builders
// (backend/src/services/booth-dialogue.js). It reaches rimpl and the persona model over HTTP and loads no database
// client. CommonJS so the backend's jest suite can prove it sends what the booth API sends.
const crypto = require('crypto');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'backend', 'src');
const { STEPS, LETTER, bankAt, firstAsk, chatRequest, chatOutcome, evaluateRequest } = require(path.join(SRC, 'services', 'booth-dialogue'));
const { ScoreSchema } = require(path.join(SRC, 'lib', 'schemas'));
const { compositeScore, WEIGHTS } = require(path.join(SRC, 'services', 'ple-gate'));
const { costUsd } = require(path.join(SRC, 'lib', 'pricing'));
const { ANTHROPIC_MODEL } = require(path.join(__dirname, '..', '..', 'rimpl', 'src', 'lib', 'provider-policy'));

const DomainsSchema = ScoreSchema.pick(Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, true])));

const PATHS = Object.freeze({ best: 'BBB', mixed: 'BRW', weakest: 'WWW' });
const PERSONAS = Object.freeze({
  strong: 'an experienced Thai general practitioner who reasons step by step and follows current Thai and WHO guidance',
  average: 'a Thai general practitioner with a few years of practice who is usually sensible but sometimes settles for a '
    + 'plausible, less complete choice',
  weak: 'a newly graduated Thai intern who is unsure, anchors on the first idea and often misses the priority',
});
const GROUPS = Object.freeze([...Object.keys(PATHS), ...Object.keys(PERSONAS)]);
const TYPE_RATE = 0.25;
const MAX_FALLBACKS = 1;
const ANSWER_MAX_CHARS = 500;

// The most tokens one call is held to use, priced at the configured rates (lib/pricing.js reads CLAUDE_*_PER_M), so
// the cap's reservations follow the rates. A failed call may still have been billed, so it counts at its worst case.
// evaluate covers rimpl's three-pass consistency layer; a persona turn is about 4k tokens in and 300 out at most.
const WORST_TOKENS = Object.freeze({ chat: [10_000, 1_300], evaluate: [65_000, 9_000], persona: [4_000, 300] });
const worstCall = (kind) => costUsd(...WORST_TOKENS[kind], 'anthropic');
// Token counts a typical call uses, for the estimate printed before a run.
const TYPICAL_TOKENS = Object.freeze({ chat: [3500, 350], evaluate: [22000, 2500], persona: [1500, 120] });
// Longer than the booth's 30 s and 60 s: a slow call here costs a data point, not a visitor's wait.
const TIMEOUT_MS = Object.freeze({ chat: 100_000, evaluate: 180_000, persona: 60_000 });
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const tierOf = (bank, id) => LETTER[bank.options.find((o) => o.id === id).tier];

/** Taps the offered option of tier letters[step] at each step. */
const tapping = (letters) => ({ bank, ask, step }) => ({ choice: ask.options.find((id) => tierOf(bank, id) === letters[step]) });

const optionText = (o) => `${o.label.th}: ${o.line.th} (${o.label.en}: ${o.line.en})`;

/** The persona's prompt for one step. It sees what a kiosk visitor sees: the vignette, the dialogue so far, the
 *  question and the three options, never a tier. */
function personaRequest({ persona, kase, bank, ask, d, typing }) {
  const options = ask.options.map((id) => bank.options.find((o) => o.id === id));
  const asked = (v, i) => bankAt(kase, d.tierPath.slice(0, i)).variants.find((x) => x.id === v.variant).question.th;
  const said = (a, i) => ('text' in a ? a.text : optionText(bankAt(kase, d.tierPath.slice(0, i)).options.find((o) => o.id === a.choice)));
  const soFar = d.answers.map((a, i) => `Q: ${asked(d.asks[i], i)}\nYou: ${said(a, i)}\nTutor: ${d.replies[i] || '(no reply)'}`);
  const question = bank.variants.find((v) => v.id === ask.variant).question;
  return {
    system: `You are ${PERSONAS[persona]}, playing a 3-question clinical case at a medical forum booth. Answer as that `
      + 'physician would, with that level of skill. Reply with one JSON object and nothing else.',
    messages: [{
      role: 'user',
      content: [
        `Case: ${kase.vignette.th}\n(${kase.vignette.en})`,
        ...(soFar.length ? [`So far:\n${soFar.join('\n\n')}`] : []),
        `Question: ${question.th} (${question.en})`,
        `Options:\n${options.map((o) => `- ${o.id}: ${optionText(o)}`).join('\n')}`,
        typing
          ? 'Do not pick an option. Type your own answer in Thai, one or two short sentences: {"text": "..."}'
          : 'Pick the option you would choose: {"choice": "<option id>"}',
      ].join('\n\n'),
    }],
  };
}

/** The persona's answer, or null when it is not a usable one of the kind asked for. */
function personaAnswer(content, ask, typing) {
  const json = typeof content === 'string' ? content.match(/\{[\s\S]*\}/) : null;
  let parsed;
  try { parsed = json && JSON.parse(json[0]); } catch { return null; }
  if (typing) {
    const text = typeof parsed?.text === 'string' ? parsed.text.trim().slice(0, ANSWER_MAX_CHARS).trim() : '';
    return text ? { text } : null;
  }
  return ask.options.includes(parsed?.choice) ? { choice: parsed.choice } : null;
}

/** A persona types at a step with chance `typeRate`, and taps otherwise. One unusable persona answer per play taps
 *  the first offered option (asks are shuffled, so that is a random tier) and is counted; a second, or a persona
 *  call that failed, abandons the play: a play of random taps would pass as that persona's score. */
const personaChooser = (persona, { typeRate = TYPE_RATE, random = Math.random } = {}) => async (turn) => {
  const typing = random() < typeRate;
  const res = await turn.call('persona', personaRequest({ persona, ...turn, typing }));
  if (!res) return { abandon: 'persona call failed' };
  const answer = personaAnswer(res.content, turn.ask, typing);
  if (answer) return answer;
  if (turn.fallbacks >= MAX_FALLBACKS) return { abandon: `more than ${MAX_FALLBACKS} unusable persona answer` };
  turn.fallback();
  return { choice: turn.ask.options[0] };
};

/**
 * One booth grill play of `kase`. `ai` holds the calls: `chat` and `evaluate` reach rimpl, `persona` the persona model.
 * Each call's cost is read from the tokens it reports. A failed chat takes the booth's own fallback (reply '' and the
 * bank's default trio); a failed evaluate leaves the play unscored, and so does a `choose` that answers `{ abandon }`.
 * @param {{ kase: object, choose: Function, ai: Record<string, Function>, start?: object }} play
 *   `start` is step 1's ask (default: drawn the way the booth draws it).
 */
async function playOnce({ kase, choose, ai, start = firstAsk(kase.banks.step1) }) {
  const ple_id = crypto.randomUUID();
  const calls = [];
  let fallbacks = 0;
  const call = async (kind, body) => {
    const t0 = Date.now();
    try {
      const res = await ai[kind](body);
      calls.push({ kind, ms: Date.now() - t0, usd: costUsd(res?.input_tokens, res?.output_tokens, res?.provider), provider: res?.provider ?? null });
      return res;
    } catch (err) {
      calls.push({ kind, ms: Date.now() - t0, usd: worstCall(kind), error: String(err.status || err.name || err.message) });
      return null;
    }
  };
  const played = (d, domains, abandoned) => ({
    tier_path: d.tierPath,
    typed: d.answers.filter((a) => 'text' in a).length,
    fallbacks,
    composite: domains ? compositeScore(domains) : null,
    domains,
    ...(abandoned ? { error: abandoned } : {}),
    calls,
    usd: Math.round(calls.reduce((acc, c) => acc + c.usd, 0) * 1e6) / 1e6,
  });
  let d = { answers: [], replies: [], asks: [start], tierPath: '' };
  for (let step = 0; step < STEPS; step += 1) {
    const bank = bankAt(kase, d.tierPath);
    const ask = d.asks[step];
    const answer = await choose({ kase, bank, ask, step, d, call, fallbacks, fallback: () => { fallbacks += 1; } });
    if ('abandon' in answer) return played(d, null, answer.abandon);
    if ('choice' in answer && !ask.options.includes(answer.choice)) throw new Error(`answer ${answer.choice} was not offered`);
    const walked = 'choice' in answer
      ? { ...d, answers: [...d.answers, answer], tierPath: d.tierPath + tierOf(bank, answer.choice) }
      : { ...d, answers: [...d.answers, answer], unsorted: true };
    const out = chatOutcome(kase, walked, await call('chat', { ple_id, ...chatRequest(kase, walked) }));
    d = { answers: out.answers, replies: out.replies, asks: out.asks, tierPath: out.tierPath };
  }
  const domains = DomainsSchema.safeParse(await call('evaluate', { ple_id, ...evaluateRequest(kase, d) }));
  return played(d, domains.success ? domains.data : null);
}

/** Every play a run makes: each scripted path once and each persona `personaRuns` times, per case. */
function jobsFor(cases, { personaRuns = 3 } = {}) {
  return cases.flatMap((kase) => [
    ...Object.keys(PATHS).map((group) => ({ kase, group, run: 1, persona: false })),
    ...Object.keys(PERSONAS).flatMap((group) => Array.from({ length: personaRuns }, (_, i) => ({ kase, group, run: i + 1, persona: true }))),
  ]);
}

const worstPlay = (job) => STEPS * worstCall('chat') + worstCall('evaluate') + (job.persona ? STEPS * worstCall('persona') : 0);
const typicalCall = (kind) => costUsd(...TYPICAL_TOKENS[kind], 'anthropic');
const typicalPlay = (job) => STEPS * typicalCall('chat') + typicalCall('evaluate') + (job.persona ? STEPS * typicalCall('persona') : 0);
const sum = (jobs, f) => Math.round(jobs.reduce((acc, j) => acc + f(j), 0) * 100) / 100;

/** What the plays would cost: typically, and at the worst case every call could bill. */
const estimate = (jobs) => ({ plays: jobs.length, typical_usd: sum(jobs, typicalPlay), worst_usd: sum(jobs, worstPlay) });

/**
 * Runs the jobs `concurrency` at a time. A play starts only while the spend so far, plus the worst case of every
 * play in flight and its own, stays within `capUsd`; the first play that would cross it stops the run, and it and
 * every later play are left unplayed.
 */
async function runPlays(jobs, { capUsd, concurrency = 3, play, onDone = () => {} }) {
  const results = new Array(jobs.length);
  let committed = 0;
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next;
      next += 1;
      const hold = worstPlay(jobs[i]);
      if (stopped || committed + hold > capUsd) {
        stopped = true;
        results[i] = { skipped: 'cap' };
        continue;
      }
      committed += hold;
      try {
        results[i] = await play(jobs[i]);
      } catch (err) {
        results[i] = { error: err.message, usd: hold };
      }
      committed += results[i].usd - hold;
      onDone(jobs[i], results[i]);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const spent = Math.round(committed * 1e6) / 1e6;
  // A call that used more than its worst case can still take the spend past the cap after the fact.
  return { results, spent_usd: spent, stopped, over_cap: spent > capUsd };
}

/** rimpl's two booth calls, and nothing else: only /chat and /evaluate, under a base URL with no path of its own. */
function rimplCalls({ url, token, fetchImpl = fetch }) {
  const base = new URL(url);
  if (base.pathname !== '/' || base.search || base.hash) throw new Error(`RIMPL_URL must be a bare origin, not ${url}`);
  const post = (route) => async (body) => {
    const res = await fetchImpl(new URL(route, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS[route.slice(1)]),
    });
    if (!res.ok) throw Object.assign(new Error(`rimpl ${route} answered ${res.status}`), { status: res.status });
    return res.json();
  };
  return { chat: post('/chat'), evaluate: post('/evaluate') };
}

/** The persona model: the Messages API on rimpl's pinned Claude model, priced as rimpl's anthropic provider. */
function personaCall({ apiKey, model = ANTHROPIC_MODEL, fetchImpl = fetch }) {
  return async ({ system, messages }) => {
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 300, system, messages }),
      signal: AbortSignal.timeout(TIMEOUT_MS.persona),
    });
    if (!res.ok) throw Object.assign(new Error(`persona model answered ${res.status}`), { status: res.status });
    const json = await res.json();
    return {
      content: (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
      input_tokens: json.usage?.input_tokens, output_tokens: json.usage?.output_tokens, provider: 'anthropic',
    };
  };
}

module.exports = {
  PATHS, PERSONAS, GROUPS, ANTHROPIC_MODEL, worstCall, tapping, personaRequest, personaAnswer, personaChooser, playOnce,
  jobsFor, estimate, runPlays, rimplCalls, personaCall,
};
