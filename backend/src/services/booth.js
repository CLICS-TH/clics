const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { costUsd } = require('../lib/pricing');
const { ScoreSchema } = require('../lib/schemas');
const { compositeScore, WEIGHTS } = require('./ple-gate');
const { rimplChat, rimplEvaluate } = require('./rimpl-client');
const { TIERS, CaseTreeSchema, caseTreeProblems, isAdmitted } = require('../booth-cases/tree-schema');
const {
  STEPS, REPLY_MAX_CHARS, BRIDGE_MAX_CHARS, LETTER, bankAt, randomOf, isValidAsk, firstAsk, nextOf, fenced,
  chatRequest, chatOutcome, evaluateRequest,
} = require('./booth-dialogue');

const BOOTH_SETTINGS = Object.freeze({
  code: 'booth_event_code',
  enabled: 'booth_enabled',
  opensAt: 'booth_opens_at',
  closesAt: 'booth_closes_at',
  ceilingUsd: 'booth_play_ceiling_usd',
});

const REPLY_RESERVE_USD = 0.05;
const SCORE_RESERVE_USD = 0.30;

const REPLY_TIMEOUT_MS = 30_000;
const SCORE_TIMEOUT_MS = 60_000;

const ANSWER_MAX_CHARS = 500;
const LETTERS = TIERS.map((t) => t.letter);
const DOMAIN_KEYS = Object.keys(WEIGHTS);
const BOARD_SIZE = 10;
// The read is ordered like byStanding, so every play above a fetched one is fetched too: a play outside the top
// STANDINGS_MAX just has no rank, and the today board draws on that top only. One kiosk finishes a play about
// every 5 minutes, far below this.
const STANDINGS_MAX = 1000;
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Answer and Ask are typed in ./booth-dialogue. The kiosk sends a typed answer as text only: its `tier` is set
 * server-side from the turn sigs (recoverTiers).
 * @typedef {{ answers: Answer[], replies: string[], asks: Ask[], sigs: string[] }} Dialogue
 *   reply (n = answers.length, 1..3): n asks, n - 1 replies, n sigs. score: 3 answers, replies and asks, 4 sigs.
 *   A reply may be '' when the AI gave none for that step; its sig still binds the ''.
 * @typedef {{ tag: number, score: number, at: string }} BoardEntry
 * @typedef {{ today: BoardEntry[], event: BoardEntry[] }} Board
 * @typedef {'bad_request' | 'case_off' | 'closed' | 'not_found' | 'not_started' | 'replayed' | 'unavailable'} Refusal
 * @typedef {{ body: object } | { refused: Refusal }} Result
 */

const AskSchema = z.object({
  variant: z.string().max(16),
  bridge: z.string().max(BRIDGE_MAX_CHARS),
  options: z.array(z.string().max(16)).length(3),
}).strict();

const DialogueSchema = z.object({
  answers: z.array(z.union([
    z.object({ choice: z.string().max(16) }).strict(),
    z.object({ text: z.string().trim().min(1).max(ANSWER_MAX_CHARS) }).strict(),
  ])).min(1).max(STEPS),
  replies: z.array(z.string().max(REPLY_MAX_CHARS)).max(STEPS),
  asks: z.array(AskSchema).min(1).max(STEPS),
  sigs: z.array(z.string().max(64)).min(1).max(STEPS + 1),
}).strict();

const CASE_ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
// The kiosk's seen list is at most the event's pool (about 11 cases) plus the one it was reset to.
const SEEN_MAX = 20;
const DrawSchema = z.object({ seen: z.array(CASE_ID).max(SEEN_MAX) }).strict();
const StartSchema = z.object({ case_id: CASE_ID }).strict();

const DomainsSchema = ScoreSchema.pick(Object.fromEntries(DOMAIN_KEYS.map((k) => [k, true])));

const SAFE_EVENT_CODE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
// Tests point BOOTH_CASES_DIR at a folder holding the fixture case.
const casesDir = () => process.env.BOOTH_CASES_DIR || path.join(__dirname, '..', 'booth-cases');
const caseCache = new Map();

/** A bare local time would be read in the server's zone (UTC on Railway), seven hours off Bangkok. The refine
 *  drops what the offset check alone lets through but Date cannot read, such as +99:99. */
const BoothTimeSchema = z.string().datetime({ offset: true }).refine((text) => !Number.isNaN(Date.parse(text)));

const UNAVAILABLE = Object.freeze({ body: Object.freeze({ status: 'unavailable' }) });
const PAST_STARTED = new Set(['not_started', 'not_found']);
const usd = (x) => Math.round(x * 1e6) / 1e6;

function readCase(file, id, code) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { why: 'is not readable JSON' }; }
  const problems = caseTreeProblems(raw);
  if (problems.length) return { why: `has ${problems.length} problem(s), first ${problems[0]}` };
  const kase = CaseTreeSchema.parse(raw);
  if (kase.case_id !== id || kase.event_code !== code) return { why: 'is not named after its case_id and event folder' };
  return isAdmitted(kase) ? { kase } : { why: 'is not admitted' };
}

/** Pure but for the read: the admitted cases of one event under `dir`, by case_id. */
function readEventCases(dir, code) {
  let files;
  try { files = fs.readdirSync(path.join(dir, code)).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.flatMap((f) => {
    const id = f.slice(0, -'.json'.length);
    const { kase, why } = readCase(path.join(dir, code, f), id, code);
    // Left-out cases are logged because a booth with none left reads only as 'misconfigured'.
    if (why) console.warn(`[booth] case ${code}/${f} left out: it ${why}`);
    return kase ? [kase] : [];
  }).sort((a, b) => (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0));
}

function eventCases(code) {
  if (typeof code !== 'string' || !SAFE_EVENT_CODE.test(code)) return [];
  const key = `${casesDir()}\0${code}`;
  if (!caseCache.has(key)) caseCache.set(key, readEventCases(casesDir(), code));
  return caseCache.get(key);
}

// One app_settings row per case, so two superadmins switching different cases never overwrite each other.
const caseKey = (code, id) => `booth_case_off:${code}:${id}`;

// The one place that decides which cases a visitor can be dealt or start: the event's admitted cases that are
// switched on, so the draw and the start can never disagree. A running play reads eventCases (playCase) instead.
const liveCases = (event) => eventCases(event.code).filter((k) => !event.off.has(k.case_id));

const instant = (text) => (BoothTimeSchema.safeParse(text).success ? new Date(text) : null);

async function readSettingRows(keys) {
  if (keys.length === 0) return [];
  const { data, error } = await supabase.from('app_settings').select('key, value, value_text').in('key', keys);
  return error || !Array.isArray(data) ? null : data;
}

/** The booth settings and the event's per-case switches, by key. */
async function readBoothRows() {
  const settings = await readSettingRows(Object.values(BOOTH_SETTINGS));
  if (!settings) return null;
  const rows = Object.fromEntries(settings.map((r) => [r.key, r]));
  const code = rowText(rows, BOOTH_SETTINGS.code);
  const switches = await readSettingRows(eventCases(code).map((k) => caseKey(code, k.case_id)));
  if (!switches) return null;
  return { ...rows, ...Object.fromEntries(switches.map((r) => [r.key, r])) };
}

const rowText = (rows, key) => (typeof rows[key]?.value_text === 'string' && rows[key].value_text.trim()) || null;

function boothEvent(rows) {
  const ceiling = Number(rows[BOOTH_SETTINGS.ceilingUsd]?.value);
  const code = rowText(rows, BOOTH_SETTINGS.code);
  return {
    code,
    off: new Set(eventCases(code).filter((k) => Number(rows[caseKey(code, k.case_id)]?.value) === 1).map((k) => k.case_id)),
    enabled: Number(rows[BOOTH_SETTINGS.enabled]?.value) === 1,
    opensAt: instant(rowText(rows, BOOTH_SETTINGS.opensAt)),
    closesAt: instant(rowText(rows, BOOTH_SETTINGS.closesAt)),
    ceilingUsd: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null,
  };
}

async function readBoothEvent() {
  const rows = await readBoothRows();
  return rows ? boothEvent(rows) : null;
}

function eventState(event, now) {
  if (!event.enabled) return { open: false, reason: 'off' };
  if (eventCases(event.code).length === 0 || !event.opensAt || !event.closesAt || event.ceilingUsd == null || event.opensAt >= event.closesAt) {
    return { open: false, reason: 'misconfigured' };
  }
  if (now < event.opensAt) return { open: false, reason: 'not_yet' };
  if (now >= event.closesAt) return { open: false, reason: 'ended' };
  return { open: true };
}

// A running play needs only its own case (playCase), so a pool switched all off stops new plays and lets the
// running ones reply and score.
function dealState(event, now) {
  const state = eventState(event, now);
  return state.open && liveCases(event).length === 0 ? { open: false, reason: 'misconfigured' } : state;
}

async function openEvent(now, stateOf = eventState) {
  const event = await readBoothEvent();
  if (!event) return { refused: 'unavailable' };
  const state = stateOf(event, now);
  return state.open ? { event } : { refused: 'closed' };
}

/** The case the play started on, at the version it started with: never the event's current case. */
async function playCase(playId, event) {
  const { data: row, error } = await supabase.from('booth_plays').select('case_id, case_version')
    .eq('id', playId).eq('event_code', event.code).maybeSingle();
  if (error) return { refused: 'unavailable' };
  if (!row) return { refused: 'not_found' };
  const kase = eventCases(event.code).find((k) => k.case_id === row.case_id);
  return kase && kase.version === row.case_version ? { kase } : UNAVAILABLE;
}

function turnKey() {
  const secret = process.env.GUEST_TOKEN_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('GUEST_TOKEN_SECRET is required in production');
  return crypto.createHmac('sha256', secret || 'clics-dev-guest-secret-do-not-use-in-prod').update('booth-turn-v1').digest();
}

// A typed answer binds its tier too, so a client can neither claim a tier nor change the one the AI gave. The
// canonical form is keyed by position, not by object key order. The kiosk never holds the tier (spec #244): the
// server recovers it from the sigs (recoverTiers).
const canonicalAnswer = (a) => ('choice' in a ? [a.choice] : [a.text, a.tier ?? null]);

/** Turn k (0..3) binds everything the server had issued after k answers: the answers (typed ones with their sorted
 *  tier) and replies before it and the asks through the next one, so a client can neither invent a reply nor
 *  answer an option it was not offered. */
function turnSig(playId, k, { answers, replies, asks }) {
  return crypto.createHmac('sha256', turnKey())
    .update(JSON.stringify([playId, k, answers.slice(0, k).map(canonicalAnswer), replies.slice(0, k), asks.slice(0, k + 1)]))
    .digest('base64url');
}

function sigMatches(expected, given) {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Gives each typed answer the tier its turn sig binds: the letter whose sig matches, so the kiosk neither holds
 *  nor chooses a tier. In a reply call the last answer, if typed, has no sig yet and stays unsorted.
 *  @returns {Answer[] | null} null when a sig matches no tier */
function recoverTiers(playId, d) {
  const answers = d.answers.map((a) => ({ ...a }));
  for (const [k, given] of d.sigs.entries()) {
    const typed = k > 0 && 'text' in answers[k - 1] ? answers[k - 1] : null;
    const fits = () => sigMatches(turnSig(playId, k, { ...d, answers }), given);
    if (typed ? !LETTERS.some((tier) => { typed.tier = tier; return fits(); }) : !fits()) return null;
  }
  return answers;
}

/** Walks the asks along the tier path. A tapped answer's tier is its option's; a typed answer's is the one the AI
 *  sorted it into (ADR 0006), recovered from the sigs. In a reply call the last answer, if typed, is still
 *  unsorted: the path then stops before it.
 *  @returns {{ tierPath: string, unsorted: boolean } | null} null when an ask or a tapped answer does not fit */
function walkPath(kase, { answers, asks }, phase) {
  let tierPath = '';
  for (const [i, answer] of answers.entries()) {
    const bank = bankAt(kase, tierPath);
    if (!isValidAsk(bank, asks[i])) return null;
    if ('choice' in answer) {
      if (!asks[i].options.includes(answer.choice)) return null;
      tierPath += LETTER[bank.options.find((o) => o.id === answer.choice).tier];
    } else if (phase === 'reply' && i === answers.length - 1) {
      return { tierPath, unsorted: true };
    } else {
      tierPath += answer.tier;
    }
  }
  return { tierPath, unsorted: false };
}

/** @returns {(Dialogue & { tierPath: string, unsorted: boolean }) | null} */
function parseDialogue(kase, playId, raw, phase) {
  const parsed = DialogueSchema.safeParse(raw);
  if (!parsed.success) return null;
  const n = parsed.data.answers.length;
  const counted = phase === 'score'
    ? n === STEPS && parsed.data.replies.length === STEPS && parsed.data.asks.length === STEPS && parsed.data.sigs.length === STEPS + 1
    : parsed.data.replies.length === n - 1 && parsed.data.asks.length === n && parsed.data.sigs.length === n;
  const answers = counted ? recoverTiers(playId, parsed.data) : null;
  if (!answers) return null;
  const d = { ...parsed.data, answers };
  const walked = walkPath(kase, d, phase);
  return walked === null ? null : { ...d, ...walked };
}

async function reserve(playId, event, amount) {
  const { data, error } = await supabase.rpc('booth_reserve_spend',
    { p_play: playId, p_event: event.code, p_amount: amount, p_ceiling: event.ceilingUsd });
  return error ? 'error' : data;
}

async function settle(playId, res, reserved) {
  const delta = costUsd(res?.input_tokens, res?.output_tokens, res?.provider) - reserved;
  const { error } = await supabase.rpc('booth_settle_spend', { p_play: playId, p_delta: delta });
  if (error) console.error(`[booth] settle failed for ${playId}: ${error.message}`);
}

const bangkokDayStart = (ms) => Math.floor((ms + BANGKOK_OFFSET_MS) / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS;

/** Higher score first; an equal score ranks the earlier play first. */
function byStanding(a, b) {
  return b.composite - a.composite || Date.parse(a.scored_at) - Date.parse(b.scored_at) || a.tag - b.tag;
}

/**
 * Pure: the event's scored plays, ranked for the event and for the Bangkok day that `dayOf` falls in.
 * @param {{ id: string, tag: number, composite: number, scored_at: string }[]} rows ranked scored plays of one event
 */
function standings(rows, dayOf) {
  const event = [...rows].sort(byStanding);
  const start = bangkokDayStart(dayOf);
  const today = event.filter((r) => { const t = Date.parse(r.scored_at); return t >= start && t < start + DAY_MS; });
  return { event, today };
}

const entry = (r) => ({ tag: r.tag, score: r.composite, at: r.scored_at });

/** @returns {Board} */
const boardOf = ({ today, event }) => ({ today: today.slice(0, BOARD_SIZE).map(entry), event: event.slice(0, BOARD_SIZE).map(entry) });

async function readStandings(event, dayOf) {
  const { data, error } = await supabase.from('booth_plays').select('id, tag, composite, scored_at')
    .eq('event_code', event.code).eq('status', 'scored').eq('ranked', true)
    .order('composite', { ascending: false }).order('scored_at').order('tag').limit(STANDINGS_MAX);
  if (error || !Array.isArray(data)) {
    console.error(`[booth] standings read failed for ${event.code}: ${error?.message ?? 'not a list'}`);
    return null;
  }
  const rows = data.map((r) => ({ id: r.id, tag: r.tag, composite: Number(r.composite), scored_at: r.scored_at }));
  return standings(rows, dayOf);
}

/** A rank of null means none: the standings did not load, or the play is outside the top STANDINGS_MAX. */
async function scoredBody(playId, event, composite, domains, scoredAt) {
  const s = await readStandings(event, Date.parse(scoredAt));
  const rank = (list) => {
    const i = list.findIndex((r) => r.id === playId);
    return i >= 0 ? i + 1 : null;
  };
  return {
    status: 'scored', composite, domains,
    rank_today: rank(s?.today ?? []), rank_event: rank(s?.event ?? []),
    board: s ? boardOf(s) : null,
  };
}

async function settledOutcome(playId, event) {
  const { data: row, error } = await supabase.from('booth_plays')
    .select(`id, status, composite, scored_at, ${DOMAIN_KEYS.join(', ')}`)
    .eq('id', playId).eq('event_code', event.code).maybeSingle();
  if (error) return { refused: 'unavailable' };
  if (!row) return { refused: 'not_found' };
  if (row.status === 'started') return null;
  if (row.status !== 'scored') return UNAVAILABLE;
  const domains = Object.fromEntries(DOMAIN_KEYS.map((k) => [k, Number(row[k])]));
  return { body: await scoredBody(playId, event, Number(row.composite), domains, row.scored_at) };
}

async function claimAsUnavailable(playId, event) {
  const { data, error } = await supabase.from('booth_plays').update({ status: 'unavailable' })
    .eq('id', playId).eq('event_code', event.code).eq('status', 'started').select('id');
  return !error && Array.isArray(data) && data.length === 1;
}

async function finish(playId, event, domains, tierPath) {
  const composite = compositeScore(domains);
  const scoredAt = new Date().toISOString();
  const { data, error } = await supabase.from('booth_plays')
    .update({ status: 'scored', composite, ...domains, scored_at: scoredAt, ranked: true, tier_path: tierPath })
    .eq('id', playId).eq('status', 'unavailable').is('scored_at', null).select('id');
  if (error || !Array.isArray(data) || data.length !== 1) return UNAVAILABLE;
  return { body: await scoredBody(playId, event, composite, domains, scoredAt) };
}

/** @returns {Promise<Result>} body: { open, reason?, event_code } */
async function boothStatus(now = new Date()) {
  const event = await readBoothEvent();
  if (!event) return { refused: 'unavailable' };
  const state = dealState(event, now);
  return { body: { open: state.open, ...(state.open ? {} : { reason: state.reason }), event_code: event.code } };
}

/** The live cases played least this event. Counted per case with a head request: a plain select stops at 1000 rows.
 *  @returns {Promise<object[] | null>} null when a count cannot be read: a wrong draw is worse than none */
async function leastPlayed(code, live) {
  const counts = await Promise.all(live.map(async (kase) => {
    const { count, error } = await supabase.from('booth_plays').select('id', { count: 'exact', head: true })
      .eq('event_code', code).eq('case_id', kase.case_id);
    return error || !Number.isInteger(count) ? null : count;
  }));
  if (counts.includes(null)) return null;
  const least = Math.min(...counts);
  return live.filter((_, i) => counts[i] === least);
}

/** Writes nothing. A first draw (empty `seen`) is the least-played live case; a reroll is a random live case not in
 *  `seen`. With every live case seen, any but the last one seen (the kiosk then restarts its list from the one
 *  returned); ids in `seen` that are no longer live are ignored.
 *  `live` is how many cases can be dealt right now (a count, no ids), so the kiosk offers a reroll only when there
 *  is another case to draw.
 *  @returns {Promise<Result>} body: { case_id, teaser: { th, en }, live } and nothing else of the case */
async function drawCase(input, now = new Date()) {
  const opened = await openEvent(now, dealState);
  if (opened.refused) return opened;
  const parsed = DrawSchema.safeParse(input);
  if (!parsed.success) return { refused: 'bad_request' };
  const { seen } = parsed.data;
  const live = liveCases(opened.event);
  let pool;
  if (seen.length === 0) {
    pool = await leastPlayed(opened.event.code, live);
    if (!pool) return { refused: 'unavailable' };
  } else {
    pool = live.filter((k) => !seen.includes(k.case_id));
    if (pool.length === 0) {
      const others = live.filter((k) => k.case_id !== seen[seen.length - 1]);
      pool = others.length ? others : live;
    }
  }
  const { case_id, teaser } = randomOf(pool);
  return { body: { case_id, teaser, live: live.length } };
}

/** @returns {Promise<Result>} body: { play_id, tag, answer_max_chars, case: { vignette }, next, sig } */
async function startPlay(input, now = new Date()) {
  const opened = await openEvent(now, dealState);
  if (opened.refused) return opened;
  const parsed = StartSchema.safeParse(input);
  if (!parsed.success) return { refused: 'bad_request' };
  const { event } = opened;
  const kase = liveCases(event).find((k) => k.case_id === parsed.data.case_id);
  if (!kase) return { refused: 'case_off' };
  // PostgREST answers a table function with an array of rows.
  const { data, error } = await supabase.rpc('booth_start_play',
    { p_event: event.code, p_case: kase.case_id, p_version: kase.version });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) return { refused: 'unavailable' };
  const bank = kase.banks.step1;
  const ask = firstAsk(bank);
  return {
    body: {
      play_id: row.play_id, tag: row.play_tag, answer_max_chars: ANSWER_MAX_CHARS, case: { vignette: kase.vignette },
      next: nextOf(bank, ask), sig: turnSig(row.play_id, 0, { answers: [], replies: [], asks: [ask] }),
    },
  };
}

/** @returns {Promise<Result>} body: { board: Board } */
async function boardFor(now = new Date()) {
  const opened = await openEvent(now);
  if (opened.refused) return opened;
  const s = await readStandings(opened.event, now.getTime());
  return s ? { body: { board: boardOf(s) } } : { refused: 'unavailable' };
}

/** One reply per step: step n is claimed only from n - 1, so a re-posted reply (to draw the AI's tier again) is refused. */
async function claimStep(playId, event, n) {
  const { data, error } = await supabase.from('booth_plays').update({ replied_step: n })
    .eq('id', playId).eq('event_code', event.code).eq('status', 'started').eq('replied_step', n - 1).select('id');
  if (error) return 'error';
  return Array.isArray(data) && data.length === 1 ? 'claimed' : 'replayed';
}

/** @returns {Promise<Result>} body: { status: 'replied', reply, reply_sig, next? } | { status: 'unavailable' }.
 *    An AI call that fails or gives no reply still answers 'replied', with reply '' and the fallback ask. */
async function replyToStep(playId, input, now = new Date()) {
  const opened = await openEvent(now);
  if (opened.refused) return opened;
  const { event } = opened;
  const played = await playCase(playId, event);
  if (!played.kase) return played;
  const { kase } = played;
  const dialogue = parseDialogue(kase, playId, input, 'reply');
  if (!dialogue) return { refused: 'bad_request' };

  const reserved = await reserve(playId, event, REPLY_RESERVE_USD);
  if (reserved === 'ceiling') return UNAVAILABLE;
  if (PAST_STARTED.has(reserved)) return { refused: reserved };
  if (reserved !== 'reserved') return { refused: 'unavailable' };

  const n = dialogue.answers.length;
  const claimed = await claimStep(playId, event, n);
  if (claimed !== 'claimed') {
    await settle(playId, null, REPLY_RESERVE_USD);
    return { refused: claimed === 'replayed' ? 'replayed' : 'unavailable' };
  }
  let res = null;
  try {
    res = await rimplChat({ ple_id: playId, ...chatRequest(kase, dialogue) }, { timeoutMs: REPLY_TIMEOUT_MS });
  } catch (err) {
    // The reservation stays: a call that failed or timed out may still have been billed.
    console.warn(`[booth] reply failed for ${playId}: ${err.status || err.name}`);
  }
  if (res) await settle(playId, res, REPLY_RESERVE_USD);
  const issued = chatOutcome(kase, dialogue, res);
  const { bank, ask } = issued;
  return {
    body: {
      status: 'replied', reply: issued.replies[n - 1], reply_sig: turnSig(playId, n, issued),
      ...(ask ? { next: nextOf(bank, ask) } : {}),
    },
  };
}

/** The score call's outcome, and what its latency line needs: `reason` for an unavailable one, `provider` for a
 *  scored one (a replay of a stored score has none). */
async function scoreOutcome(playId, input, now) {
  const opened = await openEvent(now);
  if (opened.refused) return { result: opened, reason: 'event' };
  const { event } = opened;
  const played = await playCase(playId, event);
  if (!played.kase) return { result: played, reason: 'case' };
  const { kase } = played;
  const dialogue = parseDialogue(kase, playId, input, 'score');
  if (!dialogue) return { result: { refused: 'bad_request' } };

  const stored = (result) => ({ result, reason: result.refused === 'unavailable' ? 'read' : 'settled' });
  const settled = await settledOutcome(playId, event);
  if (settled) return stored(settled);

  const reserved = await reserve(playId, event, SCORE_RESERVE_USD);
  if (reserved === 'ceiling') return { result: UNAVAILABLE, reason: 'ceiling' };
  if (PAST_STARTED.has(reserved)) return stored((await settledOutcome(playId, event)) ?? UNAVAILABLE);
  if (reserved !== 'reserved') return { result: { refused: 'unavailable' }, reason: 'reserve' };

  if (!(await claimAsUnavailable(playId, event))) return { result: UNAVAILABLE, reason: 'claim' };

  let res;
  try {
    res = await rimplEvaluate({ ple_id: playId, ...evaluateRequest(kase, dialogue) }, { timeoutMs: SCORE_TIMEOUT_MS });
  } catch (err) {
    return { result: UNAVAILABLE, reason: err.status || err.name };
  }
  await settle(playId, res, SCORE_RESERVE_USD);
  const domains = DomainsSchema.safeParse(res);
  if (!domains.success) return { result: UNAVAILABLE, reason: 'schema' };
  const result = await finish(playId, event, domains.data, dialogue.tierPath);
  return result === UNAVAILABLE ? { result, reason: 'finish' } : { result, provider: res.provider };
}

// One line per score call that ends scored or unavailable, timing the whole call (what the visitor waits):
// scripts/booth/score-latency.mjs reads them from `railway logs` for the rehearsal's p95 and provider check. A
// replay of a stored score logs provider=replay.
function logScore(playId, ms, { result, reason, provider }) {
  if (result.body?.status === 'scored') {
    console.info(`[booth] score scored play=${playId} ms=${ms} provider=${provider ?? 'replay'}`);
  } else if (result.body?.status === 'unavailable' || result.refused === 'unavailable') {
    console.warn(`[booth] score unavailable play=${playId} ms=${ms} reason=${reason}`);
  }
}

/** @returns {Promise<Result>} body: { status: 'scored', composite, domains, rank_today, rank_event, board }
 *    | { status: 'unavailable' } */
async function scorePlay(playId, input, now = new Date()) {
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await scoreOutcome(playId, input, now);
  } catch (err) {
    logScore(playId, Date.now() - startedAt, { result: { refused: 'unavailable' }, reason: 'error' });
    throw err;
  }
  logScore(playId, Date.now() - startedAt, outcome);
  return outcome.result;
}

// Superadmin booth card (#214). An 'unavailable' play may still be scoring (scorePlay claims it before the AI call),
// so the card counts plays and scored plays only and never reports 'unavailable' as a final outcome.
const BoothSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  opens_at: BoothTimeSchema.nullable().optional(),
  closes_at: BoothTimeSchema.nullable().optional(),
  ceiling_usd: z.number().positive().max(20).optional(),
  // true switches the case on.
  cases: z.record(CASE_ID, z.boolean())
    .refine((c) => { const n = Object.keys(c).length; return n > 0 && n <= SEEN_MAX; }, { message: `Send 1 to ${SEEN_MAX} cases` })
    .optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

/** @returns {Promise<object[] | null>} the event's plays, null when they cannot be read */
async function eventPlays(code) {
  if (!code) return [];
  const { data, error } = await supabase.from('booth_plays').select('case_id, status, spend_usd').eq('event_code', code);
  return error || !Array.isArray(data) ? null : data;
}

function playTotals(played) {
  if (!played) return { plays: null, scored: null, spend_usd: null };
  return {
    plays: played.length,
    scored: played.filter((r) => r.status === 'scored').length,
    spend_usd: usd(played.reduce((acc, r) => acc + Number(r.spend_usd ?? 0), 0)),
  };
}

/** The event's admitted pool as the card lists it. Admitted on the later of its two admission dates. */
function casePool(event, played) {
  return eventCases(event.code).map((k) => {
    const { safety_review: review, sandbox } = k.admission;
    return {
      case_id: k.case_id, teaser: k.teaser, version: k.version,
      admitted_on: review.date > sandbox.date ? review.date : sandbox.date,
      plays: played ? played.filter((r) => r.case_id === k.case_id).length : null,
      on: !event.off.has(k.case_id),
    };
  });
}

/** @returns {Promise<object | null>} null when the settings cannot be read */
async function boothSettings(now = new Date()) {
  const rows = await readBoothRows();
  if (!rows) return null;
  const event = boothEvent(rows);
  const state = dealState(event, now);
  const played = await eventPlays(event.code);
  return {
    event_code: event.code,
    enabled: event.enabled,
    opens_at: rowText(rows, BOOTH_SETTINGS.opensAt),
    closes_at: rowText(rows, BOOTH_SETTINGS.closesAt),
    ceiling_usd: event.ceilingUsd,
    state: state.open ? 'open' : state.reason,
    ...playTotals(played),
    cases: casePool(event, played),
  };
}

/** @returns {Promise<{ refused: 'bad_request', error: unknown } | { refused: 'unavailable' } | { changed: object }>} */
async function updateBoothSettings(input) {
  const parsed = BoothSettingsPatch.safeParse(input);
  if (!parsed.success) return { refused: 'bad_request', error: parsed.error.flatten() };
  const patch = parsed.data;
  const rows = await readBoothRows();
  if (!rows) return { refused: 'unavailable' };
  const enabled = patch.enabled ?? Number(rows[BOOTH_SETTINGS.enabled]?.value) === 1;
  const opens = patch.opens_at !== undefined ? patch.opens_at : rowText(rows, BOOTH_SETTINGS.opensAt);
  const closes = patch.closes_at !== undefined ? patch.closes_at : rowText(rows, BOOTH_SETTINGS.closesAt);
  if (opens && closes && instant(opens) && instant(closes) && instant(opens) >= instant(closes)) {
    return { refused: 'bad_request', error: 'closes_at must be after opens_at' };
  }
  if (enabled && !(opens && closes)) {
    return { refused: 'bad_request', error: 'A booth that is switched on needs both opens_at and closes_at' };
  }
  const code = rowText(rows, BOOTH_SETTINGS.code);
  const admitted = new Set(eventCases(code).map((k) => k.case_id));
  const switched = Object.entries(patch.cases ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  if (switched.some(([id]) => !admitted.has(id))) {
    return { refused: 'bad_request', error: 'cases may name only admitted cases of the event' };
  }
  const updated_at = new Date().toISOString();
  const row = (key, value, value_text = null) => ({ key, value, value_text, updated_at });
  // The switch and both bounds are checked together above, so they are written together from the merged values:
  // a patch that writes only its own field would combine with another request's field, checked against a read
  // neither saw, into a window that closes before it opens. One upsert is one statement, so two writers land
  // whole, last one wins. The rows go in the same key order every time, so the row locks never deadlock.
  const touchesWindow = ['enabled', 'opens_at', 'closes_at'].some((k) => patch[k] !== undefined);
  const upserts = [
    touchesWindow && row(BOOTH_SETTINGS.enabled, enabled ? 1 : 0),
    touchesWindow && row(BOOTH_SETTINGS.opensAt, 0, opens),
    touchesWindow && row(BOOTH_SETTINGS.closesAt, 0, closes),
    patch.ceiling_usd !== undefined && row(BOOTH_SETTINGS.ceilingUsd, patch.ceiling_usd),
    ...switched.map(([id, on]) => row(caseKey(code, id), on ? 0 : 1)),
  ].filter(Boolean);
  const { error } = await supabase.from('app_settings').upsert(upserts);
  return error ? { refused: 'unavailable' } : { changed: patch };
}

module.exports = {
  BOOTH_SETTINGS, BoothTimeSchema, SAFE_EVENT_CODE, readEventCases, turnSig, fenced, standings, boothStatus, boardFor, drawCase, startPlay, replyToStep,
  scorePlay, boothSettings, updateBoothSettings,
};
