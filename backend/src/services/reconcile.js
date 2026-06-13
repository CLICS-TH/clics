// Defensive sweep (soak finding F1): a session can pass the gate (status='cle_pass') but never get
// an ai_evaluations row — e.g. a transient RIMPL failure exhausted the retries — and silently lose
// credit. This re-triggers evaluation for those stranded sessions. Safe + idempotent (skips anything
// already evaluated). Shared by POST /admin/reconcile-evaluations and the scheduler in index.js.
const { supabase } = require('../lib/supabase');
const { triggerEvaluation } = require('./ple-evaluation');

async function reconcileEvaluations() {
  // Batch-bounded: recover up to 200 stranded sessions per call (re-run to drain more). OLDEST first
  // (order by ended_at) so a backlog past 200 can't perpetually starve the earliest stranded session.
  const { data: stuck, error: stuckErr } = await supabase
    .from('ples').select('id, physician_id').eq('status', 'cle_pass').order('ended_at').limit(200);
  if (stuckErr) throw new Error(`reconcile: stuck-session query failed: ${stuckErr.message}`);

  let recovered = 0, failed = 0, repaired = 0;
  for (const p of stuck ?? []) {
    try {
      const { data: ex } = await supabase
        .from('ai_evaluations').select('d1,d2,d3,d4,d5,d6,d7,composite_score').eq('ple_id', p.id).maybeSingle();
      if (ex) {
        // PARTIAL PERSIST: the ai_evaluations row landed but the snapshot/status writes failed, so the
        // session is stuck at cle_pass with a score. REPAIR it here — backfill the LPDP snapshot from
        // the existing row and flip to 'evaluated' — with NO paid re-evaluation.
        const domain = { d1: ex.d1, d2: ex.d2, d3: ex.d3, d4: ex.d4, d5: ex.d5, d6: ex.d6, d7: ex.d7 };
        const { error: lpErr } = await supabase.from('lpdp_snapshots')
          .insert({ physician_id: p.physician_id, ple_id: p.id, composite_score: ex.composite_score, domain_scores: domain });
        if (lpErr && lpErr.code !== '23505') throw new Error(`lpdp backfill: ${lpErr.message}`);
        const { error: stErr } = await supabase.from('ples').update({ status: 'evaluated' }).eq('id', p.id);
        if (stErr) throw new Error(`status flip: ${stErr.message}`);
        repaired++;
        continue;
      }

      const { data: msgs, error: msgErr } = await supabase
        .from('messages').select('role, content').eq('ple_id', p.id).order('created_at');
      // Don't evaluate an empty transcript into a bogus score on a transient query failure — skip and
      // retry next sweep.
      if (msgErr || !msgs?.length) {
        console.error(`[reconcile] PLE ${p.id}: skipped (messages ${msgErr ? 'error: ' + msgErr.message : 'empty'})`);
        failed++;
        continue;
      }
      await triggerEvaluation(p.id, msgs.map(m => ({ role: m.role, content: m.content })), p.physician_id);
      recovered++;
    } catch (e) {
      console.error(`[reconcile] PLE ${p.id} failed:`, e.message);
      failed++;
    }
  }
  return { stuck: (stuck ?? []).length, recovered, repaired, failed };
}

module.exports = { reconcileEvaluations };
