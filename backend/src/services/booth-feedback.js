// Anonymous booth feedback (ADR 0015). The row holds the form version, the answers, an optional comment (only as
// rimpl's de-identified copy), the case id when it names a case of the open event, and the Bangkok DATE: no time, no
// tag, no play id. Taken only while the booth is open. The comment is never logged.
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { openEvent, eventCases } = require('./booth');
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

module.exports = { FORM_VERSION, COMMENT_MAX_CHARS, ROLES, MOODS, FELT_LIKE, FeedbackSchema, feedbackOpen, submitFeedback };
