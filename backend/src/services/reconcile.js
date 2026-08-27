// Defensive sweep for sessions stranded short of a terminal status:
//   * status='ended'    — tier-1 passed but tier-2 screening never finished (process death during the
//                         /end RIMPL call, or a persistent RIMPL blip that returned 202). Re-run tier-2.
//   * status='cle_pass' — screening passed but the PIS-7 evaluation row never landed (a transient
//                         RIMPL failure exhausted the retries). Re-run the evaluation (or repair a
//                         partial persist with NO paid re-eval).
// Both are recoverable here so a credit-eligible session is never permanently stuck. Safe + idempotent.
// Shared by POST /admin/reconcile-evaluations and the scheduler in index.js.
const { supabase } = require('../lib/supabase');
const { triggerEvaluation } = require('./cle-evaluation');
const { finalizeScreening } = require('./cle-finalize');
const { isDeterministicRimplError } = require('./rimpl-client');
const reflection = require('./reflection');

// Don't touch a session that just ended — its /end handler is likely still finalizing tier-2 / firing
// the PIS-7 eval. Reconciling inside that window would race it and double-pay Anthropic (F9).
const RECENCY_SKIP_MS = 2 * 60 * 1000;

async function reconcileEvaluations(now = Date.now()) {
  const cutoff = new Date(now - RECENCY_SKIP_MS).toISOString();
  // Batch-bounded: recover up to 200 stranded sessions per call (re-run to drain more). OLDEST first
  // (order by ended_at) so a backlog past 200 can't perpetually starve the earliest stranded session.
  const { data: stuck, error: stuckErr } = await supabase
    // socratic_reason + is_test: finalizeScreening needs them to decide whether this session feeds
    // the consecutive-failure counter. Omitted, every swept session would look natural and real.
    .from('cles').select('id, physician_id, status, c1_pass, c2_pass, c3_pass, socratic_reason, is_test')
    .in('status', ['ended', 'cle_pass']).lt('ended_at', cutoff)
    .order('ended_at').limit(200);
  if (stuckErr) throw new Error(`reconcile: stuck-session query failed: ${stuckErr.message}`);

  let recovered = 0, failed = 0, repaired = 0, flagged = 0;
  for (const p of stuck ?? []) {
    try {
      const { data: msgs, error: msgErr } = await supabase
        .from('messages').select('role, content').eq('cle_id', p.id).order('created_at');
      // Don't score an empty transcript into a bogus result on a transient query failure — skip and
      // retry next sweep.
      if (msgErr || !msgs?.length) {
        console.error(`[reconcile] CLE ${p.id}: skipped (messages ${msgErr ? 'error: ' + msgErr.message : 'empty'})`);
        failed++;
        continue;
      }
      let transcript = msgs.map(m => ({ role: m.role, content: m.content }));
      // Patient identifier → scrubbed from the transcript on-prem before the cloud eval. This sweep runs
      // server-side (NOT as the owner), so read by cle_id only — the service-role key bypasses RLS.
      const { data: pref } = await supabase.from('cle_patient_refs')
        .select('patient_ref').eq('cle_id', p.id).maybeSingle();
      const patientRef = pref?.patient_ref ?? null;

      if (p.status === 'ended') {
        // A session can rest at 'ended' for a second reason now: the physician was asked for a
        // reflection and has not written one. Sweeping it here IS the intended backstop — after the
        // 6-hourly window they have plainly abandoned it — but the reflection has to be included if
        // one did arrive, or the sweep would score a session on a transcript missing evidence the
        // database already holds.
        transcript = await reflection.withReflection(p.id, transcript);
        // Tier-2 pending: finish screening from the persisted tier-1 (cle_flag_t2, or cle_pass + fire
        // the PIS-7 eval). This is what makes 'ended' recoverable after a death/blip during /end.
        await finalizeScreening({
          cleId: p.id, physicianId: p.physician_id, transcript,
          tier1: { c1: p.c1_pass, c2: p.c2_pass, c3: p.c3_pass },
          patient_ref: patientRef,
          cle: p, // socratic_reason + is_test for the consecutive-failure counter
        });
        recovered++;
        continue;
      }

      // status === 'cle_pass': the PIS-7 evaluation is missing or only partially persisted.
      const { data: ex } = await supabase
        .from('ai_evaluations').select('d1,d2,d3,d4,d5,d6,d7,composite_score').eq('cle_id', p.id).maybeSingle();
      if (ex) {
        // PARTIAL PERSIST: the ai_evaluations row landed but the snapshot/status writes failed. REPAIR
        // here — backfill the LPDP snapshot from the existing row and flip to 'evaluated' — NO paid re-eval.
        const domain = { d1: ex.d1, d2: ex.d2, d3: ex.d3, d4: ex.d4, d5: ex.d5, d6: ex.d6, d7: ex.d7 };
        const { error: lpErr } = await supabase.from('lpdp_snapshots')
          .insert({ physician_id: p.physician_id, cle_id: p.id, composite_score: ex.composite_score, domain_scores: domain });
        if (lpErr && lpErr.code !== '23505') throw new Error(`lpdp backfill: ${lpErr.message}`);
        const { error: stErr } = await supabase.from('cles').update({ status: 'evaluated' }).eq('id', p.id);
        if (stErr) throw new Error(`status flip: ${stErr.message}`);
        repaired++;
        continue;
      }
      await triggerEvaluation(p.id, transcript, p.physician_id, patientRef);
      recovered++;
    } catch (e) {
      // A DETERMINISTIC RIMPL failure (bad/out-of-range model output → 502, or token misconfig → 401)
      // will NEVER self-heal — route to manual QA (cle_flag_t2) so the sweep stops re-paying Anthropic
      // every run (F7). A transient failure is left as-is to retry next sweep.
      if (isDeterministicRimplError(e)) {
        const { error: fErr } = await supabase.from('cles').update({ status: 'cle_flag_t2' }).eq('id', p.id);
        console.error(`[reconcile] CLE ${p.id} deterministic eval failure (${e.status}) -> manual QA${fErr ? ' (flag write failed: ' + fErr.message + ')' : ''}`);
        flagged++;
      } else {
        console.error(`[reconcile] CLE ${p.id} failed (transient):`, e.message);
        failed++;
      }
    }
  }
  return { stuck: (stuck ?? []).length, recovered, repaired, flagged, failed };
}

module.exports = { reconcileEvaluations };
