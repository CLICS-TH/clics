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
//   - Where the database has it, the pair is written by ONE call, store_chat_turn() (same migration): one
//     transaction, each row stamped clock_timestamp() so order and timestamps mean what they always did,
//     refused when the PLE is no longer active. A crash can then never leave half a turn behind. Without
//     the function (code ahead of the migration, or a schema cache behind it) the route falls back to the
//     two inserts it always made, and keeps the compensating delete and the orphan repair for that path.
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

// Unknown table: 42P01 / PGRST205. Unknown column: 42703 / PGRST204. Unknown function: 42883 / PGRST202.
const MISSING_CODES = ['42P01', 'PGRST205', '42703', 'PGRST204', '42883', 'PGRST202'];
function isMissingSchema(err) {
  if (!err) return false;
  if (MISSING_CODES.includes(err.code)) return true;
  return /(chat_turn_claims|client_turn_id|store_chat_turn)/.test(err.message || '') &&
    /(does not exist|schema cache|could not find)/i.test(err.message || '');
}
const isUniqueViolation = (err) => !!err && err.code === '23505';

// Name the object that is actually missing, so the log says what to apply rather than a list to guess from.
function missingObject(err) {
  const msg = String(err?.message || '');
  if (/store_chat_turn/.test(msg) || ['42883', 'PGRST202'].includes(err?.code)) return 'function public.store_chat_turn()';
  if (/chat_turn_claims/.test(msg) || ['42P01', 'PGRST205'].includes(err?.code)) return 'table public.chat_turn_claims';
  if (/client_turn_id/.test(msg) || ['42703', 'PGRST204'].includes(err?.code)) return 'column public.messages.client_turn_id';
  return 'an object from db/migration-message-client-turn-id.sql';
}
const MISSING_EFFECT = {
  'function public.store_chat_turn()': 'turns are stored by two separate inserts (not atomic) until',
};

// Throttled PER OBJECT: once the backend is deployed and the migration is not, every keyed turn would log.
const lastMissingLogAt = new Map();
function logMissing(where, err) {
  const object = missingObject(err);
  const now = Date.now();
  if (now - (lastMissingLogAt.get(object) || 0) < 60_000) return;
  lastMissingLogAt.set(object, now);
  const effect = MISSING_EFFECT[object] || 'idempotency DISABLED, turns are stored without a key until';
  console.error(`[turn-idem] missing ${object} (${where}) — ${effect} db/migration-message-client-turn-id.sql ` +
    `is applied: ${err.message}`);
}
function _resetLogThrottle() { lastMissingLogAt.clear(); }

// CLOCKS. Every age here compares a timestamp written by the DATABASE clock (claimed_at default now(),
// created_at clock_timestamp()) with this process's clock (Date.now()). Skew between the two shifts each
// window by the skew: the margins (+20 s on the claim ceiling, the 30 s orphan grace) absorb ordinary NTP
// drift. A skew larger than a margin can make a live claim look stale (or an orphan look young); that
// costs a 202 or a takeover, never a duplicate — the unique physician index still decides what is stored.
const ageMs = (iso) => Date.now() - new Date(iso).getTime();
// A claim is FRESH while its holder could still be working on it.
const isFresh = (claim) => !!claim && claim.status === 'in_flight' && !(ageMs(claim.claimed_at) > STALE_CLAIM_MS);

// ---- the record (messages) ---------------------------------------------------------------------------
// What `messages` holds under this key. Never throws.
//   none | unavailable | error
//   done        physician + its reply stored                  → answer from the record
//   incomplete  physician stored, no reply at or after it      → (fallback path only) between the two
//               inserts, or a crash left half a turn: see classifyIncomplete
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
  // The reply is the assistant row written AT OR AFTER the question, never one that predates it.
  const asked = new Date(physician.created_at).getTime();
  const assistant = rows.find((r) => r.role === 'assistant' && !(new Date(r.created_at).getTime() < asked));
  if (assistant) return { state: 'done', physician, assistant };
  return { state: 'incomplete', physician, keyedAssistant: rows.some((r) => r.role === 'assistant') };
}

// A physician row with no reply. Only reachable on the two-insert fallback path (store_chat_turn writes
// both rows or neither). What to do with it:
//   pending  a request is (or may still be) between its two inserts: a live claim, or the row is young
//   repair   an orphan from a request that died: take the claim, delete the orphan, run the turn again
//   refuse   it cannot be repaired here (session closed, or some reply row carries the key)
const ORPHAN_GRACE_MS = 30_000;
async function classifyIncomplete(ple, key, stored) {
  const read = await readClaim(ple.id, key);
  if (read.claim && isFresh(read.claim)) return 'pending';
  if (ageMs(stored.physician.created_at) < ORPHAN_GRACE_MS) return 'pending';
  if (ple.status !== 'active' || stored.keyedAssistant) return 'refuse';
  return 'repair';
}

// Delete an orphaned physician row, and only that row: id + PLE + role + key, so a different row can never
// match. The caller holds the turn's claim, so no live request is writing this key meanwhile. Used ONLY on
// the two-insert fallback, right before the new pair is written; with store_chat_turn the delete happens
// inside the store's own transaction instead.
async function deleteOrphan(pleId, key, physicianId) {
  const { error } = await supabase.from('messages').delete()
    .eq('id', physicianId).eq('ple_id', pleId).eq('role', 'physician').eq('client_turn_id', key);
  if (error) console.error(`[turn-idem] PLE ${pleId}: could not delete orphaned physician row ${physicianId}:`, error.message);
  else console.warn(`[turn-idem] PLE ${pleId}: removed orphaned physician row ${physicianId} (no reply, request gone) before re-running the turn`);
  return !error;
}

// Fallback path, a write reported as failed: remove EVERY row carrying this key (the error may have been
// reported for a write that committed), so the transcript keeps no half turn and a retry starts clean.
// Only ever called by the request that holds the key's claim and whose own insert did not hit the unique
// index — i.e. the key's rows, if any, are this request's own.
async function deleteKeyRows(pleId, key) {
  const { error } = await supabase.from('messages').delete().eq('ple_id', pleId).eq('client_turn_id', key);
  if (error) console.error(`[turn-idem] PLE ${pleId}: could not remove the rows of a failed turn:`, error.message);
}

// ---- the atomic write ---------------------------------------------------------------------------------
// store_chat_turn(): both rows in one transaction, refused when the PLE is not active. `key` may be null
// (an unkeyed turn: same atomicity and refusal, no idempotency). `replacePhysicianId` names an orphaned
// question to delete INSIDE the same transaction before the pair is written (the repair path), so the
// delete happens only if the new pair is stored, and never in a session that has ended.
//
// The EXTRAS (db/migration-chat-turn-flags.sql): the turn's whitelisted `middlewareFlags` and a streamed
// `supersededDraft` + `supersededReason` go on the assistant row in the same transaction, as three
// trailing, defaulted params. The caller passes them already vetted (services/middleware-flags.js
// sanitizeMiddlewareFlags; a reason from services/superseded-draft.js knownReason, else null).
//
// CODE AHEAD OF THE MIGRATION (either order is safe; migration first is preferred, since this path costs a
// failed call per turn). Until that migration is applied the database has only the 12-param function, and
// a call naming the new params fails as a missing function (PGRST202 / 42883). It is then made ONCE more
// with the old params — exactly the call this code made before — and the result says `withExtras: false`:
// the caller writes the draft and the flags the old, separate way. No function at all → that second call
// fails the same way → 'unavailable' (two inserts), as before.
//   { state: 'stored', physicianId, assistantId, withExtras }
//   { state: 'duplicate' }     the physician key already exists (23505): both rows rolled back
//   { state: 'not_active' }    the session ended while the AI was answering: nothing stored
//   { state: 'unavailable' }   function missing: fall back to the two inserts (logged)
//   { state: 'error', error, withExtras }  anything else (which may include a commit whose reply was lost)
// `withExtras` says whether the call that produced the result carried the extras — so a commit that is
// read back after an error also tells the caller whether the extras are already in it.
const NOT_ACTIVE_SQLSTATE = 'CT409';
const MISSING_FUNCTION_CODES = ['42883', 'PGRST202'];
const CHECK_VIOLATION = '23514';
// Said AFTER the old-signature retry, so the line names the path that was actually taken:
//   'old'   the 12-param function answered (stored, or refused for its own reason): the turn went through
//           the old signature, and the extras are written by separate updates
//   'none'  the retry was a missing function too: there is no store_chat_turn at all, so the turn goes to
//           the two-insert fallback (logMissing('store') says that too) and the extras to separate updates
// Throttled per path.
function logMissingExtras(path, err) {
  const key = `store_chat_turn extras:${path}`;
  const now = Date.now();
  if (now - (lastMissingLogAt.get(key) || 0) < 60_000) return;
  lastMissingLogAt.set(key, now);
  if (path === 'old') {
    console.error('[turn-idem] store_chat_turn has only its old 12-param signature (no p_middleware_flags / p_superseded_draft): ' +
      'db/migration-chat-turn-flags.sql is not applied, or PostgREST has not reloaded. Turns go through the old ' +
      `signature; middleware_flags and a streamed draft are written by separate updates (not atomic) until it is: ${err.message}`);
  } else {
    console.error('[turn-idem] store_chat_turn is missing in BOTH signatures (neither db/migration-message-client-turn-id.sql ' +
      'nor db/migration-chat-turn-flags.sql is applied): the turn is stored by two separate inserts, and middleware_flags ' +
      `and a streamed draft by separate updates (not atomic): ${err.message}`);
  }
}
async function storeTurnAtomic({ pleId, key, physician, assistant, replacePhysicianId = null,
  middlewareFlags = null, supersededDraft = null, supersededReason = null }) {
  const base = {
    p_ple_id: pleId,
    p_client_turn_id: key,
    p_physician_content: physician.content,
    p_physician_tokens: physician.token_count,
    p_assistant_content: assistant.content,
    p_refs: assistant.refs ?? null,
    p_socratic_question: assistant.socratic_question ?? null,
    p_assistant_tokens: assistant.token_count ?? null,
    p_provider: assistant.provider ?? null,
    p_model: assistant.model ?? null,
    p_prompt_version: assistant.prompt_version ?? null,
    p_replace_physician_id: replacePhysicianId,
  };
  const extras = {
    p_middleware_flags: middlewareFlags ?? null,
    p_superseded_draft: supersededDraft ?? null,
    p_superseded_reason: supersededDraft != null ? (supersededReason ?? null) : null,
  };
  let withExtras = true;
  let { data, error } = await supabase.rpc('store_chat_turn', { ...base, ...extras });
  if (error && error.code === CHECK_VIOLATION && extras.p_superseded_reason != null) {
    // The reason was refused (a reason added in code ahead of the constraint). Nothing was stored — the
    // transaction rolled back. Never lose the TURN over a label: store it again with the reason NULL.
    console.error(`[turn-idem] store_chat_turn refused superseded_reason '${extras.p_superseded_reason}' (${error.message}) — ` +
      'storing the turn with the draft and a NULL reason');
    ({ data, error } = await supabase.rpc('store_chat_turn', { ...base, ...extras, p_superseded_reason: null }));
  }
  if (error && MISSING_FUNCTION_CODES.includes(error.code)) {
    const firstError = error;
    withExtras = false;
    ({ data, error } = await supabase.rpc('store_chat_turn', base));
    logMissingExtras(error && MISSING_FUNCTION_CODES.includes(error.code) ? 'none' : 'old', firstError);
  }
  if (error) {
    if (isMissingSchema(error)) { logMissing('store', error); return { state: 'unavailable' }; }
    if (isUniqueViolation(error)) return { state: 'duplicate' };
    if (error.code === NOT_ACTIVE_SQLSTATE || /ple_not_active/.test(error.message || '')) return { state: 'not_active' };
    console.error('[turn-idem] store_chat_turn failed:', error.message);
    return { state: 'error', error, withExtras };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.physician_id || !row?.assistant_id) {
    console.error('[turn-idem] store_chat_turn returned no ids:', JSON.stringify(data));
    return { state: 'error', error: new Error('store_chat_turn returned no ids'), withExtras };
  }
  return { state: 'stored', physicianId: row.physician_id, assistantId: row.assistant_id, withExtras };
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
  findStoredTurn, classifyIncomplete, deleteOrphan, deleteKeyRows, storeTurnAtomic,
  readClaim, claimTurn, releaseClaim, completeClaim, freshClaimExists,
  isFresh, isMissingSchema, isUniqueViolation, logMissing, missingObject, _resetLogThrottle,
  STALE_CLAIM_MS, ORPHAN_GRACE_MS, PENDING_RETRY_AFTER_S, NOT_ACTIVE_SQLSTATE, UUID_RE, MSG_COLS,
};
