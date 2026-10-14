// Read side of the hash-chained audit_log (db/migration-audit-log-chain.sql).
//
// The chain itself is built by a database trigger, not here: logEvent() is fire-and-forget at 41 of
// its 42 call sites, so concurrent inserts computing "the previous hash" in Node would race. This
// module only asks the database to check its own chain and to report the head.
//
// Both functions tolerate the migration not being applied yet (code ships before its migration), and
// report that as `not_installed` rather than as a failure or — worse — as a pass.
const { supabase } = require('../lib/supabase');

// Unknown function: 42883 (Postgres) / PGRST202 (PostgREST schema cache). Deliberately narrow: a
// broader "does not exist" match would report a later column or relation error as not_installed.
const isMissingFn = (err) => !!err && (['42883', 'PGRST202'].includes(err.code) ||
  /could not find the function/i.test(err.message || ''));

const firstRow = (data) => (Array.isArray(data) ? data[0] : data) || null;

// What a walk WITHOUT an anchor can and cannot say. Whoever can disable the triggers can cut rows off
// the end, or edit a row and re-hash everything after it, and the chain still links. Only a head hash
// held outside Supabase catches those — so an unanchored pass is `consistent`, never `intact`.
const UNANCHORED_LIMIT = 'Internally consistent. Without an anchor (a head seq + hash recorded outside the '
  + 'database) a truncated tail or a re-hashed chain would also pass.';

// Full walk of the chain. O(rows) — on demand only, never on a health probe.
// `anchor` = { seq, hash } from an earlier GET /health/deep head, held somewhere Supabase cannot rewrite.
async function verifyChain(anchor = null) {
  const args = anchor ? { p_anchor_seq: anchor.seq, p_anchor_hash: anchor.hash } : {};
  const { data, error } = await supabase.rpc('audit_log_verify', args);
  if (isMissingFn(error)) return { status: 'not_installed' };
  if (error) return { status: 'error', error: error.message || String(error) };
  const r = firstRow(data);
  if (!r) return { status: 'error', error: 'empty verify result' };
  const out = {
    status: !r.ok ? 'broken' : (r.anchored ? 'intact' : 'consistent'),
    anchored: !!r.anchored,
    checked: Number(r.checked) || 0,
    first_bad_seq: r.first_bad_seq == null ? null : Number(r.first_bad_seq),
    reason: r.reason ?? null,
    head_seq: r.head_seq == null ? null : Number(r.head_seq),
    head_hash: r.head_hash ?? null,
  };
  if (out.status === 'consistent') out.limits = UNANCHORED_LIMIT;
  return out;
}

// The latest (seq, hash). Cheap — an index lookup — so /health/deep can report it. Copying this value
// somewhere Supabase cannot rewrite is what makes a wholesale re-chain detectable.
async function chainHead() {
  const { data, error } = await supabase.rpc('audit_log_head');
  if (isMissingFn(error)) return { status: 'not_installed' };
  if (error) return { status: 'error', error: error.message || String(error) };
  const r = firstRow(data);
  if (!r) return { status: 'empty' };
  return { status: 'up', head_seq: Number(r.head_seq), head_hash: r.head_hash, head_at: r.head_at };
}

module.exports = { verifyChain, chainHead };
