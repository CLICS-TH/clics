// A streamed draft that a corrective retry replaced (rimpl chat.js: citation / language / evidence retry).
//
// WHY IT IS KEPT. With streaming, the physician watches the first draft arrive before the post-check
// runs; when the check fails, the draft is replaced by the retry's reply. The transcript row stores the
// reply that stood, as always — but the physician also READ the draft, and it may have shaped their next
// message. CREC082 treats the transcript as scored evidence, so the record says what was shown.
//
// WHERE. messages.superseded_draft / superseded_reason on the assistant row
// (db/migration-message-superseded-draft.sql). Not `content`: the evaluator, the auditor view and every
// replay read `content`, and they must see the conversation that stood. Every reader selects explicit
// columns, so these two reach no one by accident.
//
// ORDER: code first, migration second. Until the columns exist the update fails with an undefined-column
// error; that is logged (throttled) and the turn is unaffected — the reply is already stored and sent.

const { supabase } = require('../lib/supabase');

const MISSING = new Set(['42703', 'PGRST204']);   // undefined column / not in PostgREST's schema cache
let lastMissingLogAt = 0;

// A missing-column error, and ONLY that. Matching the bare column name was not enough: a CHECK
// violation (23514) names its constraint, `messages_superseded_reason_check`, which contains it — and
// reporting that as "the migration is not applied" sends whoever reads the log to the wrong fix while a
// real write failure goes unseen. Without a code, only the two missing-column message shapes count:
// Postgres `column "superseded_draft" of relation "messages" does not exist` and PostgREST
// `Could not find the 'superseded_draft' column of 'messages' in the schema cache`.
const CHECK_VIOLATION = '23514';
const MISSING_COLUMN_MESSAGE = /column "superseded_(?:draft|reason)"|'superseded_(?:draft|reason)' column/;
function isMissingColumn(error) {
  if (MISSING.has(error.code)) return true;
  if (error.code === CHECK_VIOLATION) return false;
  return MISSING_COLUMN_MESSAGE.test(error.message || '');
}

// The reasons the column's CHECK constraint accepts (db/migration-message-superseded-draft.sql:
// messages_superseded_reason_check). rimpl can name a check the constraint does not know yet — 'evidence',
// the evidence-level marker's rewrite (setting chat_evidence_marker) — and writing it would fail the
// constraint and lose the DRAFT with it. So an unknown reason is stored as NULL and the draft is kept:
// what the physician was shown matters more than which check replaced it. Widen the constraint (a
// migration, additive) and add the reason here together.
const KNOWN_REASONS = new Set(['citation', 'language', 'rescue']);

async function recordSupersededDraft(messageId, draft, reason) {
  try {
    const { error } = await supabase.from('messages')
      .update({ superseded_draft: draft, superseded_reason: KNOWN_REASONS.has(reason) ? reason : null })
      .eq('id', messageId).eq('role', 'assistant');
    if (!error) return 'recorded';
    if (isMissingColumn(error)) {
      const now = Date.now();
      if (now - lastMissingLogAt > 60_000) {
        lastMissingLogAt = now;
        console.error(`[stream] messages.superseded_draft missing — streamed drafts are NOT recorded until db/migration-message-superseded-draft.sql is applied: ${error.message}`);
      }
      return 'unavailable';
    }
    console.error(`[stream] failed to record a superseded draft on message ${messageId}: ${error.message}`);
    return 'error';
  } catch (e) {
    console.error(`[stream] failed to record a superseded draft on message ${messageId}: ${e.message}`);
    return 'error';
  }
}

function _resetLogThrottle() { lastMissingLogAt = 0; }

module.exports = { recordSupersededDraft, _resetLogThrottle, KNOWN_REASONS, isMissingColumn };
