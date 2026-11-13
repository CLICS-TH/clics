const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { costUsd } = require('../lib/pricing');
const { WEIGHTS } = require('./ple-gate');
const { rimplChat } = require('./rimpl-client');
const { TIERS, MAX_STEPS, eventPool, tableScore } = require('../booth-cases/tree-schema');
const { readStudyCase } = require('../booth-cases/study-snapshot');
const {
  BRIDGE_MAX_CHARS, REPLY_FIELDS, FIELD_MAX_CHARS, BOLD_MAX_RUNS, ANSWER_MAX_CHARS, DEIDENTIFIED_MAX_CHARS, LETTER,
  LOOK_LANGUAGE, bankAt, randomOf, isValidAsk, firstAsk, nextOf, fenced, hasReply, sortedTier, chatRequest, chatOutcome, stepTiers,
  stepRecords, bankKey, stepCount, echoesAnswer, replyLanguage,
} = require('./booth-dialogue');

const BOOTH_SETTINGS = Object.freeze({
  code: 'booth_event_code',
  enabled: 'booth_enabled',
  opensAt: 'booth_opens_at',
  closesAt: 'booth_closes_at',
  ceilingUsd: 'booth_play_ceiling_usd',
  // The reply cache (#387). Not on the superadmin card: the owner switches it by SQL, after the calibration.
  replyCache: 'booth_reply_cache',
});

const REPLY_RESERVE_USD = 0.05;
const REPLY_TIMEOUT_MS = 30_000;

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
 * Answer, Ask and Reply are typed in ./booth-dialogue. The kiosk sends a typed answer as its text and, once replied,
 * the `deidentified` copy the reply gave it: its `tier` is set server-side from the turn sigs (recoverTiers).
 * @typedef {{ answers: Answer[], replies: Reply[], asks: Ask[], sigs: string[], look?: keyof typeof LOOK_LANGUAGE }} Dialogue
 *   reply (n = answers.length, 1..steps of the case): n asks, n - 1 replies, n sigs. score: steps answers, replies and
 *   asks, steps + 1 sigs.
 *   A reply has every field '' when the AI gave none for that step; its sig still binds the ''s.
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

// A field the server issued is at most FIELD_MAX_CHARS of visible text plus the markers of its bold runs.
const ReplySchema = z.object(Object.fromEntries(REPLY_FIELDS.map((k) => [k, z.string().max(FIELD_MAX_CHARS + 4 * BOLD_MAX_RUNS)])))
  .strict();

const DialogueSchema = z.object({
  answers: z.array(z.union([
    z.object({ choice: z.string().max(16) }).strict(),
    z.object({
      text: z.string().trim().min(1).max(ANSWER_MAX_CHARS),
      deidentified: z.string().max(DEIDENTIFIED_MAX_CHARS).nullable().optional(),
    }).strict(),
  ])).min(1).max(MAX_STEPS),
  replies: z.array(ReplySchema).max(MAX_STEPS),
  asks: z.array(AskSchema).min(1).max(MAX_STEPS),
  sigs: z.array(z.string().max(64)).min(1).max(MAX_STEPS + 1),
  // The kiosk's language look (#377). Optional so an older kiosk still plays; no turn sig binds it, so a visitor may
  // switch it mid-play.
  look: z.enum(Object.keys(LOOK_LANGUAGE)).optional(),
}).strict();

const CASE_ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
// The kiosk's seen list is at most the event's pool (about 11 cases) plus the one it was reset to.
const SEEN_MAX = 20;
const DrawSchema = z.object({ seen: z.array(CASE_ID).max(SEEN_MAX) }).strict();
const StartSchema = z.object({ case_id: CASE_ID }).strict();

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

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };

/** Pure but for the read: one event's pool under `dir` (tree-schema eventPool). */
function readEventCases(dir, code) {
  let names;
  try { names = fs.readdirSync(path.join(dir, code)).filter((f) => f.endsWith('.json')); } catch { return { steps: 0, cases: [] }; }
  const { steps, cases, left } = eventPool(code, names.map((name) => ({ name, raw: readJson(path.join(dir, code, name)) })));
  // Left-out cases are logged because a booth with none left reads only as 'misconfigured'.
  for (const { name, why } of left) console.warn(`[booth] case ${code}/${name} left out: it ${why}`);
  return { steps, cases };
}

const NO_POOL = Object.freeze({ steps: 0, cases: [] });

function eventPoolOf(code) {
  if (typeof code !== 'string' || !SAFE_EVENT_CODE.test(code)) return NO_POOL;
  const key = `${casesDir()}\0${code}`;
  if (!caseCache.has(key)) caseCache.set(key, readEventCases(casesDir(), code));
  return caseCache.get(key);
}
const eventCases = (code) => eventPoolOf(code).cases;

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
    replyCache: Number(rows[BOOTH_SETTINGS.replyCache]?.value) === 1,
    steps: eventPoolOf(code).steps,
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

const studyCache = new Map();

/** The study snapshot of one case version (#389), kept for every version ever admitted, so a play stays auditable
 *  after its case moves on. null when there is none. */
function studyCase(code, caseId, version) {
  const key = [casesDir(), code, caseId, version].join('\0');
  if (!studyCache.has(key)) {
    studyCache.set(key, SAFE_EVENT_CODE.test(code) ? readStudyCase(casesDir(), code, caseId, version) : null);
  }
  return studyCache.get(key);
}

// One server secret, one key per use: a label of its own keeps a sort memo key from ever standing for a turn sig.
function hmacKey(label) {
  const secret = process.env.GUEST_TOKEN_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('GUEST_TOKEN_SECRET is required in production');
  return crypto.createHmac('sha256', secret || 'clics-dev-guest-secret-do-not-use-in-prod').update(label).digest();
}
const turnKey = () => hmacKey('booth-turn-v1');

// A typed answer binds its tier too, so a client can neither claim a tier nor change the one the AI gave. The
// canonical forms are keyed by position, not by object key order. The kiosk holds no tier before the score reveals
// them (spec #244, #372): the server recovers it from the sigs (recoverTiers). It binds rimpl's de-identified text
// as well, the only form of the answer stored, so the kiosk cannot alter what is kept (#375).
const canonicalAnswer = (a) => ('choice' in a ? [a.choice] : [a.text, a.tier ?? null, a.deidentified ?? null]);
const canonicalReply = (r) => REPLY_FIELDS.map((k) => r[k]);

/** Turn k (0..steps) binds everything the server had issued after k answers: the answers (typed ones with their sorted
 *  tier) and replies before it and the asks through the next one, so a client can neither invent a reply nor
 *  answer an option it was not offered. */
function turnSig(playId, k, { answers, replies, asks }) {
  return crypto.createHmac('sha256', turnKey())
    .update(JSON.stringify([playId, k, answers.slice(0, k).map(canonicalAnswer), replies.slice(0, k).map(canonicalReply),
      asks.slice(0, k + 1)]))
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
  const steps = stepCount(kase);
  const counted = n <= steps && (phase === 'score'
    ? n === steps && parsed.data.replies.length === steps && parsed.data.asks.length === steps && parsed.data.sigs.length === steps + 1
    : parsed.data.replies.length === n - 1 && parsed.data.asks.length === n && parsed.data.sigs.length === n);
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

/** The board ranks one scale (spec #370, #386): only plays of the event's step count, so the three-step plays made
 *  before an event moved to five steps never rank against five-step ones. */
async function readStandings(event, dayOf) {
  const { data, error } = await supabase.from('booth_plays').select('id, tag, composite, scored_at')
    .eq('event_code', event.code).eq('status', 'scored').eq('ranked', true).like('tier_path', '_'.repeat(event.steps))
    .order('composite', { ascending: false }).order('scored_at').order('tag').limit(STANDINGS_MAX);
  if (error || !Array.isArray(data)) {
    console.error(`[booth] standings read failed for ${event.code}: ${error?.message ?? 'not a list'}`);
    return null;
  }
  const rows = data.map((r) => ({ id: r.id, tag: r.tag, composite: Number(r.composite), scored_at: r.scored_at }));
  return standings(rows, dayOf);
}

/** A rank of null means none: the standings did not load, or the play is outside the top STANDINGS_MAX. `steps` is
 *  stepTiers of the play: no other body ever carries a tier. */
async function scoredBody(playId, event, composite, domains, scoredAt, steps) {
  const s = await readStandings(event, Date.parse(scoredAt));
  const rank = (list) => {
    const i = list.findIndex((r) => r.id === playId);
    return i >= 0 ? i + 1 : null;
  };
  return {
    status: 'scored', composite, domains, steps,
    rank_today: rank(s?.today ?? []), rank_event: rank(s?.event ?? []),
    board: s ? boardOf(s) : null,
  };
}

async function settledOutcome(playId, event, steps) {
  const { data: row, error } = await supabase.from('booth_plays')
    .select(`id, status, composite, scored_at, ${DOMAIN_KEYS.join(', ')}`)
    .eq('id', playId).eq('event_code', event.code).maybeSingle();
  if (error) return { refused: 'unavailable' };
  if (!row) return { refused: 'not_found' };
  if (row.status === 'started') return null;
  if (row.status !== 'scored') return UNAVAILABLE;
  const domains = Object.fromEntries(DOMAIN_KEYS.map((k) => [k, Number(row[k])]));
  return { body: await scoredBody(playId, event, Number(row.composite), domains, row.scored_at, steps) };
}

/** Scores a play still started with its table score (ADR 0009). The play's dialogue (stepRecords), score source and the
 *  language look it was scored in are kept with the score (ADR 0010, #377). */
async function finish(playId, event, { domains, composite }, dialogue, source, steps) {
  const scoredAt = new Date().toISOString();
  const { data, error } = await supabase.from('booth_plays')
    .update({
      status: 'scored', composite, ...domains, scored_at: scoredAt, ranked: true, tier_path: dialogue.tierPath,
      steps: stepRecords(dialogue), score_source: source, language_look: dialogue.look ?? null,
    })
    .eq('id', playId).eq('status', 'started').is('scored_at', null).select('id');
  if (error || !Array.isArray(data) || data.length !== 1) return UNAVAILABLE;
  return { body: await scoredBody(playId, event, composite, domains, scoredAt, steps) };
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

/** @returns {Promise<Result>} body: { play_id, tag, step_count, answer_max_chars, case: { vignette }, next, sig } */
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
      play_id: row.play_id, tag: row.play_tag, step_count: stepCount(kase), answer_max_chars: ANSWER_MAX_CHARS, case: { vignette: kase.vignette },
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

/** A typed answer as the sort memo compares it: NFC, whitespace runs as one space, trimmed, Latin letters lowercased.
 *  Punctuation, spelling, word order and every other letter are kept. */
const normalisedAnswer = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim()
  .replace(/\p{Script=Latin}+/gu, (s) => s.toLowerCase());

/** The sort memo key of `d`'s last (typed) answer at its point of the case version: an HMAC, never the text. */
const sortKey = (kase, d) => crypto.createHmac('sha256', hmacKey('booth-sort-memo-v1'))
  .update(JSON.stringify([kase.case_id, kase.version, d.tierPath, normalisedAnswer(d.answers.at(-1).text)]))
  .digest('hex');

/** The tier kept under `key`, or null on a miss. With `letter`, keeps it unless a tier is already kept, and returns
 *  whichever is kept. A database fault never refuses the reply: it answers `letter` (a miss, on a lookup). */
async function memoTier(key, letter = null) {
  const { data, error } = await supabase.rpc('booth_sort_memo', { p_key: key, p_tier: letter });
  if (!error && (data === null || LETTERS.includes(data))) return data;
  console.warn(`[booth] sort memo ${letter ? 'keep' : 'lookup'} failed: ${error ? error.code ?? 'error' : 'not a tier'}`);
  return letter;
}

// Reply cache (#387, db/migration-booth-reply-cache.sql). The backend keeps the replies; rimpl sees each entry's
// embedding and cues only, and names the one a typed answer may reuse.
const CACHE_ENTRIES_MAX = 32;
const TIER_NAME = Object.fromEntries(TIERS.map((t) => [t.letter, t.name]));
const CacheLive = z.object({
  model: z.string().min(1).max(200),
  embedding: z.array(z.number().finite()).min(16).max(4096),
  cues: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(64),
});

/** The newest entries at the point `d`'s typed answer was given, in its reply language; with a memo, only the
 *  memo's tier (the exact sort memo wins). A database fault never refuses the reply: it reads as no entries. */
async function cachedReplies(kase, d) {
  try {
    let query = supabase.from('booth_reply_cache').select('id, model, embedding, cues, tier, reply, pick')
      .eq('case_id', kase.case_id).eq('case_version', kase.version).eq('bank', bankKey(kase, d.tierPath))
      .eq('tier_path', d.tierPath).eq('language', replyLanguage(d));
    if (d.memo) query = query.eq('tier', d.memo);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(CACHE_ENTRIES_MAX);
    if (!error && Array.isArray(data)) return data;
    console.warn(`[booth] reply cache read failed: ${error ? error.code ?? 'error' : 'not a list'}`);
  } catch (err) {
    console.warn(`[booth] reply cache read failed: ${err.name}`);
  }
  return [];
}

/** What rimpl's response stands for. A reuse names an entry the backend sent: that entry's reply, pick and tier, as
 *  if the AI had given them. An entry it did not send is no reply. Either way rimpl made no AI call. */
function answerOf(res, entries) {
  if (res?.cache?.hit === undefined) return { ai: res, reused: false };
  const entry = entries?.find((e) => e.id === res.cache.hit);
  return entry
    ? { ai: { ...res, reply: entry.reply, pick: entry.pick, tier: TIER_NAME[entry.tier] }, reused: true }
    : { ai: null, reused: true, reason: 'cache_unknown' };
}

/** Keeps a live reply for later answers that mean the same, only when the tier taken is the AI's own, best or
 *  reasonable, the reply shows and holds no safety field, and it repeats none of this visitor's own words beyond the
 *  case's text: a weaker or safety reply, or one carrying what a visitor typed, is never shown to another. Never the
 *  answer's text, raw or de-identified, and never the pick's bridge, which the AI writes from this visitor's answer
 *  and may quote. A database fault never refuses the reply. */
async function keepReply(kase, d, res, issued) {
  const live = CacheLive.safeParse(res.cache);
  const n = d.answers.length;
  const taken = issued.answers[n - 1].tier;
  const raw = Object.fromEntries(REPLY_FIELDS.map((k) => [k, typeof res.reply?.[k] === 'string' ? res.reply[k] : '']));
  if (!live.success || taken !== sortedTier(res.tier) || !['B', 'R'].includes(taken) || raw.safety.trim() !== ''
    || !hasReply(issued.replies[n - 1]) || echoesAnswer(kase, d, raw)) return;
  try {
    const { error } = await supabase.from('booth_reply_cache').insert({
      case_id: kase.case_id, case_version: kase.version, bank: bankKey(kase, d.tierPath), tier_path: d.tierPath, language: replyLanguage(d),
      ...live.data, tier: taken, reply: { ...raw, safety: '' }, pick: res.pick ? { ...res.pick, bridge: '' } : null,
    });
    if (error) console.warn(`[booth] reply cache keep failed: ${error.code ?? 'error'}`);
  } catch (err) {
    console.warn(`[booth] reply cache keep failed: ${err.name}`);
  }
}

/** The reply call's outcome once the dialogue is read, and what its latency line needs: `reason` unless the AI
 *  replied, `provider` when the AI answered. */
async function replyOutcome(playId, event, kase, dialogue) {
  const reserved = await reserve(playId, event, REPLY_RESERVE_USD);
  if (reserved === 'ceiling') return { result: UNAVAILABLE, reason: 'ceiling' };
  if (PAST_STARTED.has(reserved)) return { result: { refused: reserved }, reason: reserved };
  if (reserved !== 'reserved') return { result: { refused: 'unavailable' }, reason: 'reserve' };

  const n = dialogue.answers.length;
  const claimed = await claimStep(playId, event, n);
  if (claimed !== 'claimed') {
    await settle(playId, null, REPLY_RESERVE_USD);
    return claimed === 'replayed' ? { result: { refused: 'replayed' }, reason: 'replayed' } : { result: { refused: 'unavailable' }, reason: 'claim' };
  }
  const key = dialogue.unsorted ? sortKey(kase, dialogue) : null;
  const recalled = key ? await memoTier(key) : null;
  const asked = recalled ? { ...dialogue, memo: recalled } : dialogue;
  const request = chatRequest(kase, asked);
  // Off (the default), nothing about the cache is read, written or sent.
  const entries = dialogue.unsorted && event.replyCache ? await cachedReplies(kase, asked) : null;
  const cache = entries ? { booth_cache: { entries: entries.map(({ id, model, embedding, cues }) => ({ id, model, embedding, cues })) } } : {};
  let res = null;
  let reason = '';
  try {
    res = await rimplChat({ ple_id: playId, ...request, ...cache }, { timeoutMs: REPLY_TIMEOUT_MS });
  } catch (err) {
    // The reservation stays: a call that failed or timed out may still have been billed.
    reason = err.status || err.name;
  }
  const answered = answerOf(res, entries);
  const ai = answered.ai;
  // A reuse made no AI call, so its whole reservation is refunded.
  if (res) await settle(playId, answered.reused ? null : res, REPLY_RESERVE_USD);
  if (answered.reason) reason = answered.reason;
  // A rimpl older than the reply fields (#376) answers `content`: every step would show no reply, billed and unseen.
  if (ai && (typeof ai.reply !== 'object' || ai.reply === null)) reason = 'no_fields';
  // Only a tier the model gave is kept: a failed or unreadable call must not pin a text to weaker for good, and a
  // reuse's tier was given to another text.
  const kept = key && !recalled && !answered.reused && typeof ai?.tier === 'string' ? await memoTier(key, sortedTier(ai.tier)) : null;
  const issued = chatOutcome(kase, kept ? { ...asked, memo: kept } : asked, ai);
  if (entries && !answered.reused && res?.cache) await keepReply(kase, asked, res, issued);
  const { bank, ask } = issued;
  const body = {
    status: 'replied', reply: issued.replies[n - 1], reply_sig: turnSig(playId, n, issued),
    ...(dialogue.unsorted ? { deidentified: issued.answers[n - 1].deidentified } : {}),
    ...(ask ? { next: nextOf(bank, ask) } : {}),
  };
  return { result: { body }, provider: res?.provider, reason };
}

// One line per reply call, timing the whole call: score-latency.mjs reads the replied and empty ones for the
// rehearsal's reply p95 and counts the unavailable ones. An empty reply is what the visitor waited for too, so it
// counts in the p95 with its own line. A refused call (closed booth, unknown play, bad request, replayed or finished
// step) never reached the AI.
function logReply(playId, step, ms, { result, reason, provider }) {
  const at = `play=${playId} step=${step} ms=${ms}`;
  if (result.body?.status === 'replied') {
    if (hasReply(result.body.reply)) console.info(`[booth] reply replied ${at} provider=${provider}`);
    else console.warn(`[booth] reply empty ${at} provider=${provider ?? 'none'} reason=${reason || 'empty'}`);
  } else {
    const kind = result.body?.status === 'unavailable' || result.refused === 'unavailable' ? 'unavailable' : 'refused';
    console.warn(`[booth] reply ${kind} ${at} reason=${reason}`);
  }
}

/** What a reply call stops on before the spend check, with the reason its line gives, else what it goes on with. */
async function readReplyCall(playId, input, now) {
  const opened = await openEvent(now);
  if (opened.refused) return { stopped: { result: opened, reason: 'event' } };
  const played = await playCase(playId, opened.event);
  if (!played.kase) return { stopped: { result: played, reason: 'case' } };
  const dialogue = parseDialogue(played.kase, playId, input, 'reply');
  if (!dialogue) return { stopped: { result: { refused: 'bad_request' }, reason: 'bad_request' } };
  return { event: opened.event, kase: played.kase, dialogue };
}

/** @returns {Promise<Result>} body: { status: 'replied', reply: Reply, reply_sig, deidentified?, next? } | { status: 'unavailable' }.
 *    An AI call that fails or gives no reply still answers 'replied', with every reply field '' and the fallback ask. A
 *    typed answer's reply carries `deidentified` (null when rimpl gave none) for the kiosk to send back with the answer. */
async function replyToStep(playId, input, now = new Date()) {
  const startedAt = Date.now();
  let step = '-';
  let outcome;
  try {
    const call = await readReplyCall(playId, input, now);
    if (call.dialogue) step = call.dialogue.answers.length;
    outcome = call.stopped ?? await replyOutcome(playId, call.event, call.kase, call.dialogue);
  } catch (err) {
    logReply(playId, step, Date.now() - startedAt, { result: { refused: 'unavailable' }, reason: 'error' });
    throw err;
  }
  logReply(playId, step, Date.now() - startedAt, outcome);
  return outcome.result;
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
  const steps = stepTiers(kase, dialogue);

  const settled = await settledOutcome(playId, event, steps);
  if (settled) return { result: settled, reason: settled.refused === 'unavailable' ? 'read' : 'settled' };

  // ADR 0009: every admitted case has a path score table, so the score is read from it with no spend and no AI call.
  const result = await finish(playId, event, tableScore(kase, dialogue.tierPath), dialogue, 'table', steps);
  return result === UNAVAILABLE ? { result, reason: 'finish' } : { result, provider: 'table' };
}

// One line per score call that ends scored or unavailable, timing the whole call (what the visitor waits):
// scripts/booth/score-latency.mjs reads them from `railway logs` for the rehearsal's p95 and provider check. A score
// read from the case's path score table logs provider=table, and a replay of a stored score provider=replay.
function logScore(playId, ms, { result, reason, provider }) {
  if (result.body?.status === 'scored') {
    console.info(`[booth] score scored play=${playId} ms=${ms} provider=${provider ?? 'replay'}`);
  } else if (result.body?.status === 'unavailable' || result.refused === 'unavailable') {
    console.warn(`[booth] score unavailable play=${playId} ms=${ms} reason=${reason}`);
  }
}

/** @returns {Promise<Result>} body: { status: 'scored', composite, domains, steps, rank_today, rank_event, board }
 *    | { status: 'unavailable' }. steps: per step, the tier of the answer and of each option offered (stepTiers). */
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

// Superadmin booth card (#214).
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

/** The event's admitted pool as the card lists it. Admitted on the later of the safety review and the sandbox pass or owner waiver. */
function casePool(event, played) {
  return eventCases(event.code).map((k) => {
    const { safety_review: review, sandbox, owner_waiver: waiver } = k.admission;
    const second = (sandbox ?? waiver).date;
    return {
      case_id: k.case_id, teaser: k.teaser, version: k.version,
      admitted_on: review.date > second ? review.date : second,
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
  scorePlay, boothSettings, updateBoothSettings, studyCase,
};
