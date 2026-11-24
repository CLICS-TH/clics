// Anonymous booth feedback (ADR 0015). The row holds the form version, the answers, an optional comment (only as
// rimpl's de-identified copy), the case id when it names a case of the open event, and the Bangkok DATE: no time, no
// tag, no play id. Taken only while the booth is open. The comment is never logged.
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { openEvent, eventCases, readBoothEvent } = require('./booth');
const { readAll } = require('./booth-audits');
const { flaggedForAuditor } = require('./booth-dialogue');
const { rimplDeidentify } = require('./rimpl-client');

const FORM_VERSION = 'fb-1';
const COMMENT_MAX_CHARS = 1000;
const ROLES = Object.freeze(['physician', 'resident', 'student', 'other']);
const MOODS = Object.freeze(['stressed', 'confused', 'neutral', 'enjoyed', 'excited']);
const FELT_LIKE = Object.freeze(['exam', 'real_patient', 'ward_round', 'game', 'textbook', 'other']);

const scale = (min, max) => z.number().int().min(min).max(max);

const FeedbackSchema = z.object({
  form: z.literal(FORM_VERSION),
  case_id: z.string().min(1).max(200).optional(),
  answers: z.object({
    role: z.enum(ROLES),
    mood: z.enum(MOODS),
    felt_like: z.array(z.enum(FELT_LIKE)).min(1).max(FELT_LIKE.length).refine((a) => new Set(a).size === a.length),
    easy: scale(1, 5),
    real: scale(1, 5),
    fair: scale(1, 5),
    use: scale(0, 10),
  }).strict(),
  comment: z.string().max(COMMENT_MAX_CHARS).optional(),
}).strict();

const bangkokDate = (now) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

/** Whether feedback is being taken now. The phone page asks this instead of /booth/status, which is the kiosk's budget. */
async function feedbackOpen(now = new Date()) {
  const opened = await openEvent(now);
  if (opened.event) return { body: { open: true } };
  return opened.refused === 'closed' ? { body: { open: false } } : { refused: 'unavailable' };
}

/** The comment as rimpl masked it, null when blank. Throws when rimpl cannot: the caller stores nothing then. */
async function maskedComment(comment) {
  const text = (comment ?? '').trim();
  if (!text) return null;
  const out = await rimplDeidentify({ messages: [{ role: 'user', content: text }] });
  return out.messages[0].content;
}

async function submitFeedback(input, now = new Date()) {
  const parsed = FeedbackSchema.safeParse(input);
  if (!parsed.success) return { refused: 'bad_request' };
  const { form, case_id, answers, comment } = parsed.data;

  const opened = await openEvent(now);
  if (!opened.event) return { refused: opened.refused };
  const code = opened.event.code;

  let masked;
  try {
    masked = await maskedComment(comment);
  } catch {
    // Not even the error's message: it may quote the text.
    return { refused: 'comment_unavailable' };
  }

  const known = case_id !== undefined && eventCases(code).some((k) => k.case_id === case_id);
  const { error } = await supabase.from('booth_feedback').insert({
    event_code: code, case_id: known ? case_id : null, form, submitted_on: bangkokDate(now), answers, comment: masked,
  });
  return error ? { refused: 'unavailable' } : { body: {} };
}

// answers as text with sorted keys, so two rows of equal answers compare equal whatever order the database kept them in
const stableText = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Newest date first; within a date by case id (none last), then the answers as text, then id. Never database order:
 *  heap and insertion order would line rows up against the timestamped play export (ADR 0015). The id only breaks
 *  ties and never leaves this module. */
function inContentOrder(rows) {
  return rows.map((r) => ({ r, answersText: stableText(r.answers) })).sort((x, y) =>
    cmp(y.r.submitted_on, x.r.submitted_on)
    || (x.r.case_id === null) - (y.r.case_id === null)
    || cmp(x.r.case_id, y.r.case_id)
    || cmp(x.answersText, y.answersText)
    || cmp(x.r.id, y.r.id)).map((x) => x.r);
}

/** @returns {{ rows: object[], counts: object } | null} the event's rows as a superadmin sees them, null when unreadable */
async function eventRows(code) {
  // .order('id') only keeps the pages stable while they are read; the order that is shown is set in code afterwards.
  const raw = await readAll(() => supabase.from('booth_feedback').select('id, submitted_on, case_id, answers, comment')
    .eq('event_code', code).order('id'));
  if (!raw) return null;
  const rows = inContentOrder(raw).map((r) => {
    const out = { date: r.submitted_on, case_id: r.case_id, answers: r.answers, comment: r.comment };
    if (r.comment !== null && flaggedForAuditor(r.comment)) { out.comment = null; out.withheld = 'flagged'; }
    return out;
  });
  const counts = {
    answers: rows.length,
    comments: rows.filter((r) => r.comment !== null || r.withheld).length,
    comments_withheld: rows.filter((r) => r.withheld).length,
  };
  return { rows, counts };
}

/** Every row of the event the booth settings name, open or not. @returns {Promise<{ body: object } | null>} */
async function readFeedback() {
  const event = await readBoothEvent();
  if (!event?.code) return null;
  const read = await eventRows(event.code);
  return read && { body: { event_code: event.code, form: FORM_VERSION, rows: read.rows, counts: read.counts } };
}

/** @returns {Promise<{ filename: string, body: object } | null>} */
async function exportFeedback() {
  const event = await readBoothEvent();
  if (!event?.code) return null;
  const read = await eventRows(event.code);
  if (!read) return null;
  return {
    filename: `booth-feedback-${event.code.replace(/[^A-Za-z0-9-]/g, '_')}.json`,
    body: { export: { event_code: event.code, counts: read.counts, form: FORM_VERSION }, rows: read.rows },
  };
}

module.exports = { readFeedback, exportFeedback, FORM_VERSION, COMMENT_MAX_CHARS, ROLES, MOODS, FELT_LIKE, FeedbackSchema, feedbackOpen, submitFeedback };
