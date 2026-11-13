const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { compositeScore, WEIGHTS } = require('./ple-gate');
const { studyCase } = require('./booth');
const { studyTranscript } = require('./booth-dialogue');

const DOMAINS = Object.keys(WEIGHTS);
const BLIND_COLUMNS = 'id, event_code, case_id, case_version, scored_at, steps, language_look';
const REVEAL_COLUMNS = [...DOMAINS, 'composite'].join(', ');
const AUDIT_COLUMNS = [...DOMAINS, 'created_at'].join(', ');
const PER_PAGE = 50;
// PostgREST answers at most 1000 rows a request, so a longer read would be cut short silently.
const PAGE = 1000;
const PlayId = z.string().uuid();
const PageNumber = z.string().regex(/^[1-9][0-9]{0,5}$/).default('1').transform(Number);
const DROP_REASONS = ['no_snapshot', 'no_deidentified_copy', 'malformed', 'flagged'];
const AuditSchema = z.object(Object.fromEntries(DOMAINS.map((k) => [k, z.number().int().min(0).max(5)]))).strict();

/**
 * @typedef {'bad_request' | 'not_found' | 'already_audited' | 'unavailable'} Refusal
 * @typedef {{ body: object, total?: number } | { refused: Refusal, error?: unknown }} Result
 * @typedef {{ id: string, played_on: string, case: { case_id: string, teaser: { th: string, en: string } } }} StudyPlay
 * @typedef {{ role: 'physician' | 'assistant', content: string }} Turn
 */

const NOT_FOUND = Object.freeze({ refused: 'not_found' });
const ALREADY_AUDITED = Object.freeze({ refused: 'already_audited' });
const UNAVAILABLE = Object.freeze({ refused: 'unavailable' });

const scoresOf = (row) => Object.fromEntries(DOMAINS.map((k) => [k, Number(row[k])]));
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const blindDay = (scoredAt) => new Date(Date.parse(scoredAt) + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
const round2 = (x) => Math.round(x * 100) / 100;

/** Every row of an ordered query, read PAGE rows a request. null when a read fails. */
async function readAll(query) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1);
    if (error || !Array.isArray(data)) return null;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

/** The play as an auditor studies it, from the study snapshot of the case version it was played on, in the language
 *  of the look it was scored in.
 *  @returns {{ play: StudyPlay, messages: Turn[] } | { why: string }} */
function studyOf(row) {
  const kase = studyCase(row.event_code, row.case_id, row.case_version);
  if (!kase) return { why: 'no_snapshot' };
  const rebuilt = studyTranscript(kase, row.steps, row.language_look);
  if (rebuilt.why) return rebuilt;
  const play = { id: row.id, played_on: blindDay(row.scored_at), case: { case_id: kase.case_id, teaser: kase.teaser } };
  return { play, messages: rebuilt.messages };
}

/** @returns {Promise<Result>} body: one page of (StudyPlay & { audited: boolean })[], newest scored first; total: every
 *  auditable play */
async function queue(auditorId, pageText) {
  const page = PageNumber.safeParse(pageText);
  if (!page.success) return { refused: 'bad_request', error: 'page must be a whole number from 1' };
  const [plays, mine] = await Promise.all([
    readAll(() => supabase.from('booth_plays').select(BLIND_COLUMNS).eq('status', 'scored').not('steps', 'is', null)
      .order('scored_at', { ascending: false }).order('id')),
    readAll(() => supabase.from('booth_audits').select('play_id').eq('auditor_id', auditorId).order('play_id')),
  ]);
  if (!plays || !mine) return UNAVAILABLE;
  const audited = new Set(mine.map((r) => r.play_id));
  const dropped = Object.fromEntries(DROP_REASONS.map((why) => [why, 0]));
  const auditable = plays.flatMap((row) => {
    const study = studyOf(row);
    if (study.why) { dropped[study.why] += 1; return []; }
    return [{ ...study.play, audited: audited.has(row.id) }];
  });
  // A play that cannot be rebuilt is unreachable from the queue, so every load says how many and why.
  const counts = DROP_REASONS.map((why) => `${why}=${dropped[why]}`).join(' ');
  const log = DROP_REASONS.some((why) => dropped[why] > 0) ? console.warn : console.info;
  log(`[booth-audits] queue auditable=${auditable.length} dropped ${counts}`);
  const from = (page.data - 1) * PER_PAGE;
  return { body: auditable.slice(from, from + PER_PAGE), total: auditable.length };
}

/** @returns {Promise<Result>} body: { state: 'blind', play, messages }
 *    | { state: 'revealed', play, messages, audit: { d1..d7, composite, created_at }, demo: { d1..d7, composite } } */
async function study(playId, auditorId) {
  if (!PlayId.safeParse(playId).success) return NOT_FOUND;
  const [play, own] = await Promise.all([
    supabase.from('booth_plays').select(BLIND_COLUMNS).eq('id', playId).eq('status', 'scored').maybeSingle(),
    supabase.from('booth_audits').select(AUDIT_COLUMNS).eq('play_id', playId).eq('auditor_id', auditorId).maybeSingle(),
  ]);
  if (play.error || own.error) return UNAVAILABLE;
  const found = play.data && studyOf(play.data);
  if (!found || found.why) return NOT_FOUND;
  if (!own.data) return { body: { state: 'blind', ...found } };
  const demo = await supabase.from('booth_plays').select(REVEAL_COLUMNS).eq('id', playId).single();
  if (demo.error || !demo.data) return UNAVAILABLE;
  const audit = scoresOf(own.data);
  return {
    body: {
      state: 'revealed', ...found,
      audit: { ...audit, composite: compositeScore(audit), created_at: own.data.created_at },
      demo: { ...scoresOf(demo.data), composite: Number(demo.data.composite) },
    },
  };
}

/** @returns {Promise<Result>} body: the revealed study */
async function submit(playId, auditorId, input) {
  const parsed = AuditSchema.safeParse(input);
  if (!parsed.success) return { refused: 'bad_request', error: parsed.error.flatten() };
  const before = await study(playId, auditorId);
  if (before.refused) return before;
  if (before.body.state === 'revealed') return ALREADY_AUDITED;
  const { error } = await supabase.from('booth_audits').insert({ play_id: playId, auditor_id: auditorId, ...parsed.data });
  if (error) return error.code === '23505' ? ALREADY_AUDITED : UNAVAILABLE;
  return study(playId, auditorId);
}

/** @param {{ d1: number, booth_plays: { d1: number } }[]} rows */
function meanGap(rows) {
  if (rows.length === 0) return null;
  return Object.fromEntries(DOMAINS.map((k) => [k,
    round2(rows.reduce((acc, r) => acc + Number(r[k]) - Number(r.booth_plays[k]), 0) / rows.length)]));
}

/** @returns {Promise<{ audits: number, auditors: number, plays: number, mean_gap: object | null } | null>} */
async function summary() {
  const rows = await readAll(() => supabase.from('booth_audits')
    .select(`auditor_id, play_id, ${DOMAINS.join(', ')}, booth_plays(${DOMAINS.join(', ')})`)
    .order('play_id').order('auditor_id'));
  if (!rows) return null;
  return {
    audits: rows.length,
    auditors: new Set(rows.map((r) => r.auditor_id)).size,
    plays: new Set(rows.map((r) => r.play_id)).size,
    mean_gap: meanGap(rows),
  };
}

module.exports = { queue, study, submit, summary, BLIND_COLUMNS, REVEAL_COLUMNS, AUDIT_COLUMNS };
