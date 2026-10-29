const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { costUsd } = require('../lib/pricing');
const { ScoreSchema } = require('../lib/schemas');
const { compositeScore, WEIGHTS } = require('./ple-gate');
const { rimplChat, rimplEvaluate } = require('./rimpl-client');

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
const REPLY_MAX_CHARS = 1200;
const STEPS = 3;
const DOMAIN_KEYS = Object.keys(WEIGHTS);

/**
 * @typedef {{ choice: string } | { text: string }} Answer
 * @typedef {{ answers: Answer[], replies: string[] }} Dialogue
 *   reply: 1..3 answers and answers.length - 1 replies (the step being answered is answers.length).
 *   score: exactly 3 of each. A reply may be '' when the AI gave none for that step.
 * @typedef {'bad_request' | 'closed' | 'not_found' | 'not_started' | 'ai_unavailable' | 'unavailable'} Refusal
 * @typedef {{ body: object } | { refused: Refusal }} Result
 */

const Bilingual = z.object({ th: z.string().trim().min(1), en: z.string().trim().min(1) }).strict();
const CaseSchema = z.object({
  placeholder: z.boolean().optional(),
  event_code: z.string(),
  version: z.string().min(1),
  vignette: Bilingual,
  steps: z.array(z.object({
    question: Bilingual,
    options: z.array(z.object({ id: z.string().regex(/^[a-z]$/), label: Bilingual, line: Bilingual }).strict())
      .length(3)
      .refine((os) => new Set(os.map((o) => o.id)).size === os.length, 'option ids must be unique'),
  }).strict()).length(STEPS),
}).strict();

const DialogueSchema = z.object({
  answers: z.array(z.union([
    z.object({ choice: z.string() }).strict(),
    z.object({ text: z.string().trim().min(1).max(ANSWER_MAX_CHARS) }).strict(),
  ])).min(1).max(STEPS),
  replies: z.array(z.string().max(REPLY_MAX_CHARS)).max(STEPS),
}).strict();

const DomainsSchema = ScoreSchema.pick(Object.fromEntries(DOMAIN_KEYS.map((k) => [k, true])));

const SAFE_EVENT_CODE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;
const CASES_DIR = path.join(__dirname, '..', 'booth-cases');
const caseCache = new Map();

/** A bare local time would be read in the server's zone (UTC on Railway), seven hours off Bangkok. The refine
 *  drops what the offset check alone lets through but Date cannot read, such as +99:99. */
const BoothTimeSchema = z.string().datetime({ offset: true }).refine((text) => !Number.isNaN(Date.parse(text)));

const UNAVAILABLE = Object.freeze({ body: Object.freeze({ status: 'unavailable' }) });
const PAST_STARTED = new Set(['not_started', 'not_found']);
const usd = (x) => Math.round(x * 1e6) / 1e6;

function boothCase(code) {
  if (typeof code !== 'string' || !SAFE_EVENT_CODE.test(code)) return null;
  if (!caseCache.has(code)) caseCache.set(code, loadCase(code));
  return caseCache.get(code);
}

function loadCase(code) {
  try {
    const parsed = CaseSchema.safeParse(JSON.parse(fs.readFileSync(path.join(CASES_DIR, `${code}.json`), 'utf8')));
    return parsed.success && parsed.data.event_code === code ? parsed.data : null;
  } catch {
    return null;
  }
}

const instant = (text) => (BoothTimeSchema.safeParse(text).success ? new Date(text) : null);

async function readBoothRows() {
  const { data, error } = await supabase.from('app_settings').select('key, value, value_text')
    .in('key', Object.values(BOOTH_SETTINGS));
  if (error || !Array.isArray(data)) return null;
  return Object.fromEntries(data.map((r) => [r.key, r]));
}

const rowText = (rows, key) => (typeof rows[key]?.value_text === 'string' && rows[key].value_text.trim()) || null;

function boothEvent(rows) {
  const ceiling = Number(rows[BOOTH_SETTINGS.ceilingUsd]?.value);
  return {
    code: rowText(rows, BOOTH_SETTINGS.code),
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
  const kase = boothCase(event.code);
  if (!kase || !event.opensAt || !event.closesAt || event.ceilingUsd == null || event.opensAt >= event.closesAt) {
    return { open: false, reason: 'misconfigured' };
  }
  if (now < event.opensAt) return { open: false, reason: 'not_yet' };
  if (now >= event.closesAt) return { open: false, reason: 'ended' };
  return { open: true, kase };
}

async function openEvent(now) {
  const event = await readBoothEvent();
  if (!event) return { refused: 'unavailable' };
  const state = eventState(event, now);
  return state.open ? { event, kase: state.kase } : { refused: 'closed' };
}

/** @returns {Dialogue | null} */
function parseDialogue(kase, raw, phase) {
  const parsed = DialogueSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { answers, replies } = parsed.data;
  const counted = phase === 'score'
    ? answers.length === STEPS && replies.length === STEPS
    : replies.length === answers.length - 1;
  const known = answers.every((a, i) => !('choice' in a) || kase.steps[i].options.some((o) => o.id === a.choice));
  return counted && known ? parsed.data : null;
}

// Turn 1 carries the vignette because the evaluator reads the transcript alone (chief_complaint only seeds
// rimpl's de-identification registry).
function dialogueTurns(kase, { answers, replies }) {
  return answers.flatMap((answer, i) => {
    const step = kase.steps[i];
    const option = 'choice' in answer ? step.options.find((o) => o.id === answer.choice) : null;
    const said = option ? `${option.label.th}: ${option.line.th}` : answer.text;
    const physician = { role: 'physician', content: `${i === 0 ? `${kase.vignette.th}\n\n` : ''}${step.question.th}\n${said}` };
    return replies[i] ? [physician, { role: 'assistant', content: replies[i] }] : [physician];
  });
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

const scoredBody = (composite, domains) => ({ status: 'scored', composite, domains });

async function settledOutcome(playId, event) {
  const { data: row, error } = await supabase.from('booth_plays')
    .select(`id, status, composite, ${DOMAIN_KEYS.join(', ')}`)
    .eq('id', playId).eq('event_code', event.code).maybeSingle();
  if (error) return { refused: 'unavailable' };
  if (!row) return { refused: 'not_found' };
  if (row.status === 'started') return null;
  if (row.status !== 'scored') return UNAVAILABLE;
  return { body: scoredBody(Number(row.composite), Object.fromEntries(DOMAIN_KEYS.map((k) => [k, Number(row[k])]))) };
}

async function claimAsUnavailable(playId, event) {
  const { data, error } = await supabase.from('booth_plays').update({ status: 'unavailable' })
    .eq('id', playId).eq('event_code', event.code).eq('status', 'started').select('id');
  return !error && Array.isArray(data) && data.length === 1;
}

async function finish(playId, domains) {
  const composite = compositeScore(domains);
  const { data, error } = await supabase.from('booth_plays')
    .update({ status: 'scored', composite, ...domains, scored_at: new Date().toISOString() })
    .eq('id', playId).eq('status', 'unavailable').is('scored_at', null).select('id');
  if (error || !Array.isArray(data) || data.length !== 1) return UNAVAILABLE;
  return { body: scoredBody(composite, domains) };
}

/** @returns {Promise<Result>} body: { open, reason?, event_code, case_version } */
async function boothStatus(now = new Date()) {
  const event = await readBoothEvent();
  if (!event) return { refused: 'unavailable' };
  const state = eventState(event, now);
  return {
    body: {
      open: state.open,
      ...(state.open ? {} : { reason: state.reason }),
      event_code: event.code,
      case_version: boothCase(event.code)?.version ?? null,
    },
  };
}

/** @returns {Promise<Result>} body: { play_id, tag, case, answer_max_chars } */
async function startPlay(now = new Date()) {
  const opened = await openEvent(now);
  if (opened.refused) return opened;
  // PostgREST answers a table function with an array of rows.
  const { data, error } = await supabase.rpc('booth_start_play', { p_event: opened.event.code });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) return { refused: 'unavailable' };
  return { body: { play_id: row.play_id, tag: row.play_tag, case: opened.kase, answer_max_chars: ANSWER_MAX_CHARS } };
}

/** @returns {Promise<Result>} body: { status: 'replied', reply } | { status: 'unavailable' } */
async function replyToStep(playId, input, now = new Date()) {
  const opened = await openEvent(now);
  if (opened.refused) return opened;
  const { event, kase } = opened;
  const dialogue = parseDialogue(kase, input, 'reply');
  if (!dialogue) return { refused: 'bad_request' };

  const reserved = await reserve(playId, event, REPLY_RESERVE_USD);
  if (reserved === 'ceiling') return UNAVAILABLE;
  if (PAST_STARTED.has(reserved)) return { refused: reserved };
  if (reserved !== 'reserved') return { refused: 'unavailable' };

  const history = dialogueTurns(kase, dialogue);
  const { content: message } = history.pop();
  let res;
  try {
    // No chief_complaint: rimpl prefixes it to the last user turn, and turn 1 already carries the vignette.
    res = await rimplChat({ ple_id: playId, history, message, language: 'th', booth_mode: true },
      { timeoutMs: REPLY_TIMEOUT_MS });
  } catch (err) {
    // The reservation stays: a call that failed or timed out may still have been billed.
    console.warn(`[booth] reply failed for ${playId}: ${err.status || err.name}`);
    return { refused: 'ai_unavailable' };
  }
  await settle(playId, res, REPLY_RESERVE_USD);
  const reply = typeof res?.content === 'string' ? res.content.trim().slice(0, REPLY_MAX_CHARS) : '';
  return reply ? { body: { status: 'replied', reply } } : { refused: 'ai_unavailable' };
}

// shadow MUST be false: rimpl's shadow evaluation upserts shadow_evaluations, whose ple_id references ples, and a
// booth play is not a PLE.
/** @returns {Promise<Result>} body: { status: 'scored', composite, domains } | { status: 'unavailable' } */
async function scorePlay(playId, input, now = new Date()) {
  const opened = await openEvent(now);
  if (opened.refused) return opened;
  const { event, kase } = opened;
  const dialogue = parseDialogue(kase, input, 'score');
  if (!dialogue) return { refused: 'bad_request' };

  const settled = await settledOutcome(playId, event);
  if (settled) return settled;

  const reserved = await reserve(playId, event, SCORE_RESERVE_USD);
  if (reserved === 'ceiling') return UNAVAILABLE;
  if (PAST_STARTED.has(reserved)) return (await settledOutcome(playId, event)) ?? UNAVAILABLE;
  if (reserved !== 'reserved') return { refused: 'unavailable' };

  if (!(await claimAsUnavailable(playId, event))) return UNAVAILABLE;

  let res;
  try {
    res = await rimplEvaluate({ ple_id: playId, transcript: dialogueTurns(kase, dialogue), patient_ref: null,
      chief_complaint: kase.vignette.th, shadow: false }, { timeoutMs: SCORE_TIMEOUT_MS });
  } catch (err) {
    console.warn(`[booth] score unavailable for ${playId}: ${err.status || err.name}`);
    return UNAVAILABLE;
  }
  await settle(playId, res, SCORE_RESERVE_USD);
  const domains = DomainsSchema.safeParse(res);
  return domains.success ? finish(playId, domains.data) : UNAVAILABLE;
}

// Superadmin booth card (#214). An 'unavailable' play may still be scoring (scorePlay claims it before the AI call),
// so the card counts plays and scored plays only and never reports 'unavailable' as a final outcome.
const BoothSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  opens_at: BoothTimeSchema.nullable().optional(),
  closes_at: BoothTimeSchema.nullable().optional(),
  ceiling_usd: z.number().positive().max(20).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

async function playTotals(code) {
  if (!code) return { plays: 0, scored: 0, spend_usd: 0 };
  const { data, error } = await supabase.from('booth_plays').select('status, spend_usd').eq('event_code', code);
  if (error || !Array.isArray(data)) return { plays: null, scored: null, spend_usd: null };
  return {
    plays: data.length,
    scored: data.filter((r) => r.status === 'scored').length,
    spend_usd: usd(data.reduce((acc, r) => acc + Number(r.spend_usd ?? 0), 0)),
  };
}

/** @returns {Promise<object | null>} null when the settings cannot be read */
async function boothSettings(now = new Date()) {
  const rows = await readBoothRows();
  if (!rows) return null;
  const event = boothEvent(rows);
  const state = eventState(event, now);
  return {
    event_code: event.code,
    enabled: event.enabled,
    opens_at: rowText(rows, BOOTH_SETTINGS.opensAt),
    closes_at: rowText(rows, BOOTH_SETTINGS.closesAt),
    ceiling_usd: event.ceilingUsd,
    state: state.open ? 'open' : state.reason,
    ...(await playTotals(event.code)),
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
  ].filter(Boolean);
  const { error } = await supabase.from('app_settings').upsert(upserts);
  return error ? { refused: 'unavailable' } : { changed: patch };
}

module.exports = {
  BOOTH_SETTINGS, BoothTimeSchema, SAFE_EVENT_CODE, boothStatus, startPlay, replyToStep, scorePlay,
  boothSettings, updateBoothSettings,
};
