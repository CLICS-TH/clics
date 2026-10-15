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
// TWO WAYS IN. Once db/migration-chat-turn-flags.sql is applied, store_chat_turn() writes the draft on the
// assistant row in the SAME transaction as the turn (lib/turn-idempotency.js storeTurnAtomic), and the route
// does not call this. Until then — the old store_chat_turn signature, or the two-insert fallback — the route
// calls recordSupersededDraft() after the turn is stored: a separate, non-atomic update.
//
// ORDER: code first, migration second. Until the columns exist the update fails with an undefined-column
// error; that is logged (throttled) and the turn is unaffected — the reply is already stored and sent.

const { supabase } = require('../lib/supabase');

const MISSING = new Set(['42703', 'PGRST204']);   // undefined column / not in PostgREST's schema cache
let lastMissingLogAt = 0;
let lastCheckLogAt = 0;

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

// The reasons the column's CHECK constraint accepts once db/migration-chat-turn-flags.sql is applied
// (messages_superseded_reason_check: citation | language | rescue | evidence — 'evidence' is the
// evidence-level marker's rewrite, setting chat_evidence_marker). Anything else rimpl names is stored as
// NULL and the draft is kept: what the physician was shown matters more than which check replaced it.
// Adding a reason: widen the constraint (a migration, additive) and add it here together.
//
// Until that migration is applied the LIVE constraint still lacks 'evidence', so a write of it fails
// with 23514. recordSupersededDraft() then retries once with a NULL reason, so the draft is not lost.
const KNOWN_REASONS = new Set(['citation', 'language', 'rescue', 'evidence']);
function knownReason(reason) {
  return KNOWN_REASONS.has(reason) ? reason : null;
}

async function recordSupersededDraft(messageId, draft, reason) {
  const write = (r) => supabase.from('messages')
    .update({ superseded_draft: draft, superseded_reason: r })
    .eq('id', messageId).eq('role', 'assistant');
  try {
    const stored = knownReason(reason);
    let { error } = await write(stored);
    if (error && error.code === CHECK_VIOLATION && stored != null) {
      // The constraint refused the reason (the old one, before migration-chat-turn-flags.sql). Keep the
      // draft: write it again with no reason. Logged, throttled — it repeats on every such turn.
      const now = Date.now();
      if (now - lastCheckLogAt > 60_000) {
        lastCheckLogAt = now;
        console.warn(`[stream] superseded_reason '${stored}' refused by the CHECK constraint (db/migration-chat-turn-flags.sql not applied?) — ` +
          `keeping the draft on message ${messageId} with reason NULL: ${error.message}`);
      }
      ({ error } = await write(null));
    }
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

function _resetLogThrottle() { lastMissingLogAt = 0; lastCheckLogAt = 0; }

module.exports = { recordSupersededDraft, _resetLogThrottle, KNOWN_REASONS, knownReason, isMissingColumn };
