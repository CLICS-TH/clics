// Read side of the hash-chained audit_log (db/migration-audit-log-chain.sql).
//
// The chain itself is built by a database trigger, not here: logEvent() is fire-and-forget at 41 of
// its 42 call sites, so concurrent inserts computing "the previous hash" in Node would race. This
// module only asks the database to check its own chain and to report the head.
//
// Both functions tolerate the migration not being applied yet (code ships before its migration), and
// report that as `not_installed` rather than as a failure or — worse — as a pass.
const { supabase } = require('../lib/supabase');

// Unknown function: 42883 (Postgres) / PGRST202 (PostgREST schema cache).
const isMissingFn = (err) => !!err && (['42883', 'PGRST202'].includes(err.code) ||
  /could not find the function|does not exist/i.test(err.message || ''));

const firstRow = (data) => (Array.isArray(data) ? data[0] : data) || null;

// Full walk of the chain. O(rows) — on demand only, never on a health probe.
async function verifyChain() {
  const { data, error } = await supabase.rpc('audit_log_verify');
  if (isMissingFn(error)) return { status: 'not_installed' };
  if (error) return { status: 'error', error: error.message || String(error) };
  const r = firstRow(data);
  if (!r) return { status: 'error', error: 'empty verify result' };
  return {
    status: r.ok ? 'intact' : 'broken',
    checked: Number(r.checked) || 0,
    first_bad_seq: r.first_bad_seq == null ? null : Number(r.first_bad_seq),
    reason: r.reason ?? null,
    head_seq: r.head_seq == null ? null : Number(r.head_seq),
    head_hash: r.head_hash ?? null,
  };
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
