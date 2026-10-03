// Idempotency for a physician chat turn (POST /ples/:id/message with `client_turn_id`).
//
// THE PROBLEM. The route persists a turn only AFTER rimpl answers (up to ~100 s). A dropped connection
// looked like a failed turn to the client while the backend went on to store it, and the client's Retry
// stored the physician message a second time in the scored transcript (CREC082).
//
// THE DESIGN (db/migration-message-client-turn-id.sql).
//   - A CLAIM in `chat_turn_claims` says "a request is working on this turn". It is taken before any paid
//     work and lives OUTSIDE `messages`, so the scored transcript never holds a row for an unanswered
//     turn. A claim left by a killed request (a redeploy kills in-flight turns) is inert metadata: past
//     STALE_CLAIM_MS the next retry takes it over. Release, completion and takeover are all conditional
//     on the holder's random `claim_token`, so a late request can never undo another's claim.
//   - The physician + assistant rows are written after rimpl returns, exactly as before (same order, same
//     timestamps). The partial unique index on (ple_id, client_turn_id) WHERE role='physician' is the
//     FINAL arbiter: if a late original and the retry that took over its stale claim both get there, the
//     second physician insert fails and that request stores nothing.
//
// DEPLOY ORDER. Code ships before the migration (the 2026-09 outage rule: never require the database
// ahead of the code). A missing table or column is treated as "no key" and said in the log, throttled:
// a fallback that drops its error is worse than a 500. Any OTHER database error is surfaced, not absorbed.
const crypto = require('crypto');
const { supabase } = require('./supabase');

// The rimpl chat call is bounded by RIMPL_CHAT_TIMEOUT_MS (services/rimpl-client.js, default 100 s). A
// claim older than that plus a margin for the DB writes around it cannot belong to a request that is
// still alive. (If one somehow is, the unique index above still keeps the transcript to one turn.) Read
// the env here rather than importing rimpl-client so a test that mocks that module cannot make this NaN.
const CHAT_TIMEOUT_MS = parseInt(process.env.RIMPL_CHAT_TIMEOUT_MS || '100000', 10);
const STALE_CLAIM_MS = CHAT_TIMEOUT_MS + 20_000;
const PENDING_RETRY_AFTER_S = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MSG_COLS = 'id, role, content, refs, socratic_question, token_count, created_at';

// Unknown table: 42P01 (Postgres) / PGRST205 (PostgREST schema cache). Unknown column: 42703 / PGRST204.
function isMissingSchema(err) {
  if (!err) return false;
  if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(err.code)) return true;
  return /(chat_turn_claims|client_turn_id)/.test(err.message || '') &&
    /(does not exist|schema cache|could not find)/i.test(err.message || '');
}
const isUniqueViolation = (err) => !!err && err.code === '23505';

// Throttled: once the backend is deployed and the migration is not, every keyed turn would log.
let lastMissingLogAt = 0;
function logMissing(where, err) {
  const now = Date.now();
  if (now - lastMissingLogAt < 60_000) return;
  lastMissingLogAt = now;
  console.error(`[turn-idem] chat_turn_claims / messages.client_turn_id missing (${where}) — idempotency DISABLED, ` +
    `turns are stored without a key until db/migration-message-client-turn-id.sql is applied: ${err.message}`);
}
function _resetLogThrottle() { lastMissingLogAt = 0; }

const ageMs = (iso) => Date.now() - new Date(iso).getTime();
// A claim is FRESH while its holder could still be working on it.
const isFresh = (claim) => !!claim && claim.status === 'in_flight' && !(ageMs(claim.claimed_at) > STALE_CLAIM_MS);

// ---- the record (messages) ---------------------------------------------------------------------------
// What `messages` holds under this key. Never throws.
//   none | unavailable | error
//   done        physician + assistant stored                 → answer from the record
//   incomplete  physician stored, assistant not (yet)         → the holder is between its two inserts
//   conflict    the key was first used for DIFFERENT text      → a client bug; never answer with the old turn
async function findStoredTurn(pleId, key, message) {
  const { data, error } = await supabase
    .from('messages').select(`${MSG_COLS}, client_turn_id`).eq('ple_id', pleId).eq('client_turn_id', key).order('created_at');
  if (error) {
    if (isMissingSchema(error)) { logMissing('messages lookup', error); return { state: 'unavailable' }; }
    console.error('[turn-idem] messages lookup failed:', error.message);
    return { state: 'error', error };
  }
  const rows = data ?? [];
  const physician = rows.find((r) => r.role === 'physician');
  if (!physician) return { state: 'none' };
  if (physician.content !== message) return { state: 'conflict', physician };
  const assistant = rows.find((r) => r.role === 'assistant');
  return assistant ? { state: 'done', physician, assistant } : { state: 'incomplete', physician };
}

// ---- claims ------------------------------------------------------------------------------------------
async function readClaim(pleId, key) {
  const { data, error } = await supabase.from('chat_turn_claims')
    .select('ple_id, client_turn_id, claim_token, status, claimed_at')
    .eq('ple_id', pleId).eq('client_turn_id', key).maybeSingle();
  if (error) {
    if (isMissingSchema(error)) { logMissing('claim lookup', error); return { unavailable: true }; }
    console.error('[turn-idem] claim lookup failed:', error.message);
    return { error };
  }
  return { claim: data ?? null };
}

// Take the turn. Two attempts, because the state can move between the read and the write.
//   { state: 'claimed', token }   this request owns the turn: reserve budget, call rimpl, store
//   { state: 'busy' }             another request holds it fresh, or has completed it
//   { state: 'unavailable' }      table missing: behave as an unkeyed request
//   { state: 'error', error }
async function claimTurn(pleId, key) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await readClaim(pleId, key);
    if (read.unavailable) return { state: 'unavailable' };
    if (read.error) return { state: 'error', error: read.error };
    const claim = read.claim;
    const token = crypto.randomUUID();

    if (!claim) {
      const { error } = await supabase.from('chat_turn_claims')
        .insert({ ple_id: pleId, client_turn_id: key, claim_token: token, status: 'in_flight' });
      if (!error) return { state: 'claimed', token };
      if (isMissingSchema(error)) { logMissing('claim insert', error); return { state: 'unavailable' }; }
      if (isUniqueViolation(error)) continue;          // someone claimed between our read and insert: re-read
      console.error('[turn-idem] claim insert failed:', error.message);
      return { state: 'error', error };
    }
    if (claim.status === 'done' || isFresh(claim)) return { state: 'busy' };

    // Stale: its holder is gone. Take it over ATOMICALLY: the update matches only while the old token is
    // still there, so of two retries racing for the same stale claim exactly one gets a row back.
    const { data, error } = await supabase.from('chat_turn_claims')
      .update({ claim_token: token, status: 'in_flight', claimed_at: new Date().toISOString() })
      .eq('ple_id', pleId).eq('client_turn_id', key).eq('claim_token', claim.claim_token)
      .select('claim_token');
    if (error) {
      console.error('[turn-idem] claim takeover failed:', error.message);
      return { state: 'error', error };
    }
    if (Array.isArray(data) && data.length === 1) {
      console.warn(`[turn-idem] took over a stale claim on PLE ${pleId} (claimed ${Math.round(ageMs(claim.claimed_at) / 1000)}s ago)`);
      return { state: 'claimed', token };
    }
    // Lost the takeover race: re-read and decide again.
  }
  return { state: 'busy' };
}

// The turn ended without a stored reply: free the slot so a retry with the same key starts clean.
async function releaseClaim(pleId, key, token) {
  if (!token) return;
  const { error } = await supabase.from('chat_turn_claims').delete()
    .eq('ple_id', pleId).eq('client_turn_id', key).eq('claim_token', token);
  if (error) console.error(`[turn-idem] could not release claim on PLE ${pleId} (it goes stale on its own):`, error.message);
}

// The turn is stored: the claim stays as a 'done' marker (inert; the record is what answers retries).
async function completeClaim(pleId, key, token) {
  if (!token) return;
  const { error } = await supabase.from('chat_turn_claims').update({ status: 'done' })
    .eq('ple_id', pleId).eq('client_turn_id', key).eq('claim_token', token);
  if (error) console.error(`[turn-idem] could not mark claim done on PLE ${pleId}:`, error.message);
}

// Is any turn on this PLE being answered right now? (/end must not close the transcript under it.)
// Fails OPEN on a database error, with a log: a broken claims read must never trap a physician in a
// session they cannot end. A stale claim never counts.
async function freshClaimExists(pleId) {
  const { data, error } = await supabase.from('chat_turn_claims')
    .select('status, claimed_at').eq('ple_id', pleId).eq('status', 'in_flight');
  if (error) {
    if (isMissingSchema(error)) logMissing('end check', error);
    else console.error('[turn-idem] in-flight check failed (allowing /end):', error.message);
    return false;
  }
  return (data ?? []).some(isFresh);
}

module.exports = {
  findStoredTurn, readClaim, claimTurn, releaseClaim, completeClaim, freshClaimExists,
  isFresh, isMissingSchema, isUniqueViolation, logMissing, _resetLogThrottle,
  STALE_CLAIM_MS, PENDING_RETRY_AFTER_S, UUID_RE, MSG_COLS,
};
