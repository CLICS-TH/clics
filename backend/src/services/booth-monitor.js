// The superadmin's view of the current booth event (owner, 2026-11-24): the leaderboard of every scored play, overall
// and per case, and the internal export of every play (ADR 0014). Both read whatever the event's window: the kiosk's
// board (booth.boardFor) refuses outside it, and the owner monitors and exports after the event too.
const { supabase } = require('../lib/supabase');
const { DISPLAY_SCALE, displayScore } = require('../booth-cases/display-score');
const { readBoothEvent, eventCases, standings } = require('./booth');
const { readAll } = require('./booth-audits');
const { REPLY_FIELDS, flaggedForAuditor } = require('./booth-dialogue');

const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const STANDING_COLUMNS = 'id, tag, composite, scored_at, case_id, case_version';
const EXPORT_COLUMNS = ['id', 'event_code', 'tag', 'status', 'ranked', 'case_id', 'case_version', 'tier_path', 'replied_step',
  'composite', ...DOMAINS, 'score_source', 'language_look', 'spend_usd', 'created_at', 'scored_at', 'steps'].join(', ');
const BANGKOK_OFFSET_MS = 7 * 3_600_000;

const numberOrNull = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
const player = (tag) => `#${String(tag).padStart(3, '0')}`;
const poolOf = (code) => eventCases(code).map((k) => ({ case_id: k.case_id, version: k.version, teaser: k.teaser }));

/**
 * The leaderboard as the kiosk ranks it (booth.readStandings): scored, ranked plays of the event's step count, by raw
 * composite, an equal score to the earlier play. Every row, not the kiosk's top ten. `score` is the display score the
 * visitor saw (ADR 0013), `raw` the stored composite. A case's rows are ranked within that case.
 * @returns {Promise<object | null>} null when the event or its plays cannot be read
 */
async function leaderboard(now = new Date()) {
  const event = await readBoothEvent();
  if (!event) return null;
  const base = { event_code: event.code, steps: event.steps, generated_at: now.toISOString() };
  if (!event.code) return { ...base, total: 0, overall: [], cases: [] };
  const rows = await readAll(() => supabase.from('booth_plays').select(STANDING_COLUMNS)
    .eq('event_code', event.code).eq('status', 'scored').eq('ranked', true).like('tier_path', '_'.repeat(event.steps))
    .order('composite', { ascending: false }).order('scored_at').order('tag'));
  if (!rows) return null;
  const plays = rows.map((r) => ({ ...r, composite: Number(r.composite) }));
  const ranked = (list) => standings(list, now.getTime()).event.map((r, i) => ({
    rank: i + 1, tag: r.tag, score: displayScore(r.composite, event.steps), raw: r.composite,
    case_id: r.case_id ?? null, case_version: r.case_version ?? null, scored_at: r.scored_at,
  }));
  const pool = poolOf(event.code);
  const known = new Set(pool.map((k) => k.case_id));
  // A case dropped from the pool after it was played keeps its rows, listed after the pool.
  const retired = [...new Set(plays.map((p) => p.case_id).filter((id) => id && !known.has(id)))].sort()
    .map((case_id) => ({ case_id, version: null, teaser: null }));
  return {
    ...base,
    total: plays.length,
    overall: ranked(plays),
    cases: [...pool, ...retired].map((k) => ({ ...k, rows: ranked(plays.filter((p) => p.case_id === k.case_id)) })),
  };
}

/**
 * A stored step record (booth-dialogue stepRecords) as the export carries it. Every free text in it is screened again
 * the way the auditor read screens it (studyTranscript), because rimpl's write-time filter misses some shapes (#449,
 * #451): the typed answer (rimpl's de-identified copy), the reply and the bridge. The bridge is the AI's, written from
 * the previous step's answer and stored on this step, so a tapped step carries AI text too; and before the reply bank
 * (#490), and on a play that is not five steps, a tapped answer's reply came from the AI as well. A reviewed bank
 * reply never trips the screen (none of the bank texts does), so screening every step costs a reviewed step nothing.
 * A finding withholds all three, marked 'flagged'; the ids (variant, options, choice) and the tier stay.
 */
function exportStep(step) {
  if (!step || typeof step !== 'object') return step ?? null;
  const typed = 'typed' in step;
  const texts = [typed ? step.typed : null, ...REPLY_FIELDS.map((k) => step.reply?.[k]), step.bridge]
    .filter((t) => typeof t === 'string' && t !== '');
  if (texts.some(flaggedForAuditor)) {
    return { ...step, ...(typed ? { typed: null } : {}), reply: null, bridge: null, withheld: 'flagged' };
  }
  if (typed && typeof step.typed !== 'string') return { ...step, typed: null, withheld: 'no_deidentified_copy' };
  return step;
}

function exportPlay(row) {
  const raw = numberOrNull(row.composite);
  const stepsPlayed = typeof row.tier_path === 'string' ? row.tier_path.length : 0;
  return {
    id: row.id, tag: row.tag, player: player(row.tag), status: row.status, ranked: row.ranked,
    case_id: row.case_id ?? null, case_version: row.case_version ?? null, tier_path: row.tier_path ?? null,
    steps_played: stepsPlayed, replied_step: row.replied_step ?? null,
    raw_composite: raw,
    // The display rescale for a five-step play, the raw score otherwise (ADR 0013). A five-step play scored before
    // display-v1 shipped (2026-11-18) was shown its raw score; scored_at tells them apart.
    display_score: raw == null ? null : displayScore(raw, stepsPlayed),
    domains: Object.fromEntries(DOMAINS.map((d) => [d, numberOrNull(row[d])])),
    score_source: row.score_source ?? null, language_look: row.language_look ?? null,
    spend_usd: numberOrNull(row.spend_usd), created_at: row.created_at, scored_at: row.scored_at ?? null,
    dialogue: Array.isArray(row.steps) ? row.steps.map(exportStep) : null,
  };
}

/**
 * Every play of the current event, every status, for internal research (ADR 0014): the tag, the full timestamps and
 * the spend stay in, which the open dataset (ADR 0010) leaves out.
 * @returns {Promise<{ filename: string, body: object } | null>} null when the event or its plays cannot be read
 */
async function exportPlays(now = new Date()) {
  const event = await readBoothEvent();
  if (!event) return null;
  const rows = event.code
    ? await readAll(() => supabase.from('booth_plays').select(EXPORT_COLUMNS).eq('event_code', event.code).order('tag'))
    : [];
  if (!rows) return null;
  const plays = rows.map(exportPlay);
  const steps = plays.flatMap((p) => p.dialogue ?? []).filter((s) => s && typeof s === 'object');
  const day = new Date(now.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
  return {
    // The code is a setting's free text: only safe characters reach the Content-Disposition header.
    filename: `clics-booth-${(event.code ?? 'none').replace(/[^A-Za-z0-9-]/g, '_')}-${day}.json`,
    body: {
      export: {
        kind: 'clics-booth-internal', version: 1, event_code: event.code, generated_at: now.toISOString(),
        use: 'Internal use only (ADR 0014). Not for publication: a public release is the open booth dataset (ADR 0010).',
        display_scale: DISPLAY_SCALE,
        counts: {
          plays: plays.length,
          scored: plays.filter((p) => p.status === 'scored').length,
          steps: steps.length,
          typed_steps: steps.filter((s) => 'typed' in s).length,
          withheld_flagged: steps.filter((s) => s.withheld === 'flagged').length,
          withheld_no_copy: steps.filter((s) => s.withheld === 'no_deidentified_copy').length,
        },
      },
      cases: event.code ? poolOf(event.code) : [],
      plays,
    },
  };
}

module.exports = { leaderboard, exportPlays, exportStep };
