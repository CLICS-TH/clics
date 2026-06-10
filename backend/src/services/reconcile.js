// Defensive sweep (soak finding F1): a session can pass the gate (status='cle_pass') but never get
// an ai_evaluations row — e.g. a transient RIMPL failure exhausted the retries — and silently lose
// credit. This re-triggers evaluation for those stranded sessions. Safe + idempotent (skips anything
// already evaluated). Shared by POST /admin/reconcile-evaluations and the scheduler in index.js.
const { supabase } = require('../lib/supabase');
const { triggerEvaluation } = require('./ple-evaluation');

async function reconcileEvaluations() {
  // Batch-bounded: recover up to 200 stranded sessions per call (re-run to drain more).
  const { data: stuck } = await supabase.from('ples').select('id, physician_id').eq('status', 'cle_pass').limit(200);
  let recovered = 0, failed = 0;
  for (const p of stuck ?? []) {
    const { data: ex } = await supabase.from('ai_evaluations').select('id').eq('ple_id', p.id).maybeSingle();
    if (ex) continue;
    const { data: msgs } = await supabase.from('messages').select('role, content').eq('ple_id', p.id).order('created_at');
    try { await triggerEvaluation(p.id, (msgs ?? []).map(m => ({ role: m.role, content: m.content })), p.physician_id); recovered++; }
    catch { failed++; }
  }
  return { stuck: (stuck ?? []).length, recovered, failed };
}

module.exports = { reconcileEvaluations };
