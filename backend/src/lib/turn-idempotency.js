// Idempotency for a physician chat turn (POST /ples/:id/message with `client_turn_id`).
//
// THE PROBLEM. The route persists a turn only AFTER rimpl answers (up to ~100 s). A dropped connection
// therefore looked like a failed turn to the client while the backend went on to store it, and the
// client's Retry stored the physician message a second time in the scored transcript (CREC082).
//
// THE MECHANISM. A keyed turn CLAIMS its slot before any paid work: the physician row is inserted first,
// carrying the key, under the partial unique index (ple_id, client_turn_id) WHERE role = 'physician'
// (db/migration-message-client-turn-id.sql). The database — not an in-memory check — decides which of two
// overlapping requests owns the turn; the loser gets a unique violation, never reaches rimpl, and never
// reserves budget. The assistant reply is stamped with the same key so a retry reads the stored pair back
// by key.
//
// DEPLOY ORDER. The column may not exist yet (code ships before the migration; the 2026-09 outage rule is
// never to require the database ahead of the code). Every query here treats "column missing" as "no key",
// and says so in the log: a fallback that drops its error is worse than a 500.
const { supabase } = require('./supabase');

// The rimpl chat call is bounded by RIMPL_CHAT_TIMEOUT_MS (services/rimpl-client.js, default 100 s). A
// claimed physician row with no reply that is older than that, plus a margin for the surrounding DB
// calls, cannot belong to a request that is still running — its process died. Read the env here rather
// than importing rimpl-client so a test that mocks that module cannot turn this into NaN.
const CHAT_TIMEOUT_MS = parseInt(process.env.RIMPL_CHAT_TIMEOUT_MS || '100000', 10);
const STALE_CLAIM_MS = CHAT_TIMEOUT_MS + 60_000;
const PENDING_RETRY_AFTER_S = 5;

const COLS = 'id, role, content, refs, socratic_question, token_count, created_at';

// PostgREST reports an unknown column as PGRST204 (insert/update, schema cache) or 42703 (filter/select).
function isMissingColumn(err) {
  if (!err) return false;
  if (err.code === 'PGRST204' || err.code === '42703') return true;
  return /client_turn_id/.test(err.message || '') && /(column|schema cache)/i.test(err.message || '');
}
const isUniqueViolation = (err) => !!err && err.code === '23505';

// Throttled: once the backend is deployed and the migration is not, every turn would log.
let lastMissingLogAt = 0;
function logMissingColumn(where, err) {
  const now = Date.now();
  if (now - lastMissingLogAt < 60_000) return;
  lastMissingLogAt = now;
  console.error(`[turn-idem] client_turn_id column missing (${where}) — idempotency DISABLED, turns are stored ` +
    `without a key until db/migration-message-client-turn-id.sql is applied: ${err.message}`);
}
function _resetLogThrottle() { lastMissingLogAt = 0; }

// What is stored for this key. Never throws.
//   { state: 'none' }                              nothing stored under this key
//   { state: 'unavailable' }                       column missing — behave as an unkeyed request
//   { state: 'done', physician, assistant }        both rows stored
//   { state: 'pending', physician }                physician row claimed, no reply yet (original in flight)
//   { state: 'conflict', physician }               same key already used for DIFFERENT text
//   { state: 'error', error }                      the lookup itself failed (not a missing column)
// `reclaim: false` forbids deleting an abandoned claim (used for an episode that is no longer active:
// its transcript is closed and must not be edited).
async function lookupTurn(pleId, key, message, { reclaim = true } = {}) {
  const { data, error } = await supabase
    .from('messages').select(COLS).eq('ple_id', pleId).eq('client_turn_id', key).order('created_at');
  if (error) {
    if (isMissingColumn(error)) { logMissingColumn('lookup', error); return { state: 'unavailable' }; }
    console.error('[turn-idem] lookup failed:', error.message);
    return { state: 'error', error };
  }
  const rows = data ?? [];
  const physician = rows.find((r) => r.role === 'physician');
  if (!physician) return { state: 'none' };
  // A key is bound to the text it first carried. The same key with other text is a client bug, and
  // answering it with the OLD turn would show the physician a reply to a question they did not ask.
  if (physician.content !== message) return { state: 'conflict', physician };
  const assistant = rows.find((r) => r.role === 'assistant');
  if (assistant) return { state: 'done', physician, assistant };
  const ageMs = Date.now() - new Date(physician.created_at).getTime();
  if (reclaim && Number.isFinite(ageMs) && ageMs > STALE_CLAIM_MS) {
    // Abandoned claim (the process that took it died before it could release it). Delete exactly that
    // row by id — if another retry reclaimed first, its NEW row has a different id and is untouched —
    // and let this request take the slot. Loud, because it removes a stored physician message.
    console.error(`[turn-idem] reclaiming abandoned claim ${physician.id} on PLE ${pleId} (age ${Math.round(ageMs / 1000)}s, no reply)`);
    const { error: delErr } = await supabase.from('messages').delete()
      .eq('id', physician.id).eq('ple_id', pleId).eq('role', 'physician');
    if (delErr) { console.error('[turn-idem] could not delete abandoned claim:', delErr.message); return { state: 'pending', physician }; }
    return { state: 'none' };
  }
  return { state: 'pending', physician };
}

// Take the slot: insert the physician row WITH the key. The unique index arbitrates.
//   { state: 'claimed', id }   this request owns the turn — go on to reserve + call rimpl
//   { state: 'unavailable' }   column missing — behave as an unkeyed request
//   { state: 'done' | 'pending' | 'conflict', ... }   another request got there first (same shape as lookupTurn)
//   { state: 'error', error }
async function claimTurn({ pleId, key, message, tokens }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.from('messages').insert({
      ple_id: pleId, role: 'physician', content: message, token_count: tokens, client_turn_id: key,
    }).select('id').single();
    if (!error) return { state: 'claimed', id: data?.id ?? null };
    if (isMissingColumn(error)) { logMissingColumn('claim', error); return { state: 'unavailable' }; }
    if (!isUniqueViolation(error)) {
      console.error('[turn-idem] claim failed:', error.message);
      return { state: 'error', error };
    }
    // Lost the race. Whoever won decides the outcome; if they have already released (their turn
    // failed) the slot is free again and one more attempt takes it.
    const seen = await lookupTurn(pleId, key, message);
    if (seen.state !== 'none') return seen;
  }
  // Two lost races in a row with the slot empty each time: report it as in flight rather than loop.
  return { state: 'pending', physician: null };
}

// Give the slot back when the turn did not complete (budget refused, rimpl failed, reply not saved), so
// a retry with the same key starts clean instead of finding a physician row with no reply forever.
// A failure to release is logged at error level: the row is then an orphan that only the stale-claim
// reclaim (above) can clear.
async function releaseTurn(pleId, claimId) {
  if (!claimId) return;
  const { error } = await supabase.from('messages').delete()
    .eq('id', claimId).eq('ple_id', pleId).eq('role', 'physician');
  if (error) console.error(`[turn-idem] ORPHANED claim ${claimId} on PLE ${pleId} — release failed:`, error.message);
}

module.exports = {
  lookupTurn, claimTurn, releaseTurn,
  isMissingColumn, isUniqueViolation, _resetLogThrottle,
  STALE_CLAIM_MS, PENDING_RETRY_AFTER_S,
};
