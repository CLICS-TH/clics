// Defensive sweep for sessions stranded short of a terminal status:
//   * status='ended'    — tier-1 passed but tier-2 screening never finished (process death during the
//                         /end RIMPL call, or a persistent RIMPL blip that returned 202). Re-run tier-2.
//   * status='ple_pass' — screening passed but the PIS-7 evaluation row never landed (a transient
//                         RIMPL failure exhausted the retries). Re-run the evaluation (or repair a
//                         partial persist with NO paid re-eval).
// Both are recoverable here so a credit-eligible session is never permanently stuck. Safe + idempotent.
// Shared by POST /admin/reconcile-evaluations and the scheduler in index.js.
const { supabase } = require('../lib/supabase');
const { finalizeScreening } = require('./ple-finalize');
const evalDrain = require('./eval-drain');
const { resolveScope } = require('../lib/eval-scope');
const { isDeterministicRimplError } = require('./rimpl-client');
const reflection = require('./reflection');

// Don't touch a session that just ended — its /end handler is likely still finalizing tier-2.
// Reconciling inside that window would race it (F9). Note this window says nothing about whether the
// PIS-7 evaluation has run: since the durable queue, a ple_pass row can legitimately wait far longer
// than this for the drain, which is why the ple_pass branch below only wakes the drain and never
// resets a row's place in the queue.
const RECENCY_SKIP_MS = 2 * 60 * 1000;

async function reconcileEvaluations(now = Date.now()) {
  const cutoff = new Date(now - RECENCY_SKIP_MS).toISOString();
  // Batch-bounded: recover up to 200 stranded sessions per call (re-run to drain more). OLDEST first
  // (order by ended_at) so a backlog past 200 can't perpetually starve the earliest stranded session.
  const { data: stuck, error: stuckErr } = await supabase
    // socratic_reason + is_test: finalizeScreening needs them to decide whether this session feeds
    // the consecutive-failure counter. Omitted, every swept session would look natural and real.
    // chief_complaint: seeds RIMPL's token numbering for the classifier (never shown to it).
    .from('ples').select('id, physician_id, status, c1_pass, c2_pass, c3_pass, socratic_reason, is_test, council_id, eval_enqueued_at, ended_at, chief_complaint')
    .in('status', ['ended', 'ple_pass']).lt('ended_at', cutoff)
    .order('ended_at').limit(200);
  if (stuckErr) throw new Error(`reconcile: stuck-session query failed: ${stuckErr.message}`);

  let recovered = 0, failed = 0, repaired = 0, flagged = 0, requeued = 0, queued = 0, skipped = 0;
  // Council partition (lib/eval-scope.js): a council being scored by a laptop stack on the local model
  // must not be touched by THIS process, or the same PLE is evaluated on two different models. If the
  // partition cannot be resolved the sweep does NOT run unpartitioned — that is the confound itself.
  let scope;
  try { scope = await resolveScope(); }
  catch (e) { throw new Error(`reconcile: council scope unavailable, sweep skipped (${e.message})`); }
  if (scope.failedClosed) throw new Error(`reconcile: council scope failed closed (${scope.failedClosed}), sweep skipped`);
  const inScope = (p) => !(scope.exclude && p.council_id && scope.exclude.includes(p.council_id))
    && !(scope.include && !(p.council_id && scope.include.includes(p.council_id)));
  for (const p of stuck ?? []) {
    if (!inScope(p)) { skipped++; continue; }
    try {
      if (p.status === 'ended') {
        const { data: msgs, error: msgErr } = await supabase
          .from('messages').select('role, content').eq('ple_id', p.id).order('created_at');
        // Don't score an empty transcript into a bogus result on a transient query failure — skip and
        // retry next sweep.
        if (msgErr || !msgs?.length) {
          console.error(`[reconcile] PLE ${p.id}: skipped (messages ${msgErr ? 'error: ' + msgErr.message : 'empty'})`);
          failed++;
          continue;
        }
        let transcript = msgs.map(m => ({ role: m.role, content: m.content }));
        // Patient identifier → scrubbed from the transcript on-prem before any model call. This sweep
        // runs server-side (NOT as the owner), so read by ple_id only — the service-role key bypasses RLS.
        // A READ ERROR must not become "no patient_ref": the classifier would then get the transcript
        // without its scrub hints, and an untitled patient name would reach the model. Skip and retry
        // next sweep, exactly as for a failed messages read. No row is fine (none was recorded).
        const { data: pref, error: prefErr } = await supabase.from('ple_patient_refs')
          .select('patient_ref').eq('ple_id', p.id).maybeSingle();
        if (prefErr) {
          console.error(`[reconcile] PLE ${p.id}: skipped (patient_ref read error: ${prefErr.message})`);
          failed++;
          continue;
        }
        const patientRef = pref?.patient_ref ?? null;
        // A session can rest at 'ended' for a second reason now: the physician was asked for a
        // reflection and has not written one. Sweeping it here IS the intended backstop — after the
        // 6-hourly window they have plainly abandoned it — but the reflection has to be included if
        // one did arrive, or the sweep would score a session on a transcript missing evidence the
        // database already holds.
        transcript = await reflection.withReflection(p.id, transcript);
        // Tier-2 pending: finish screening from the persisted tier-1 (ple_flag_t2, or ple_pass + fire
        // the PIS-7 eval). This is what makes 'ended' recoverable after a death/blip during /end.
        await finalizeScreening({
          pleId: p.id, physicianId: p.physician_id, transcript,
          tier1: { c1: p.c1_pass, c2: p.c2_pass, c3: p.c3_pass },
          patient_ref: patientRef,
          chief_complaint: p.chief_complaint ?? null,
          ple: p, // socratic_reason + is_test for the consecutive-failure counter
        });
        recovered++;
        continue;
      }

      // status === 'ple_pass': the PIS-7 evaluation is missing or only partially persisted.
      const { data: ex } = await supabase
        .from('ai_evaluations').select('d1,d2,d3,d4,d5,d6,d7,composite_score').eq('ple_id', p.id).maybeSingle();
      if (ex) {
        // PARTIAL PERSIST: the ai_evaluations row landed but the snapshot/status writes failed. REPAIR
        // here — backfill the LPDP snapshot from the existing row and flip to 'evaluated' — NO paid re-eval.
        const domain = { d1: ex.d1, d2: ex.d2, d3: ex.d3, d4: ex.d4, d5: ex.d5, d6: ex.d6, d7: ex.d7 };
        const { error: lpErr } = await supabase.from('lpdp_snapshots')
          .insert({ physician_id: p.physician_id, ple_id: p.id, composite_score: ex.composite_score, domain_scores: domain });
        if (lpErr && lpErr.code !== '23505') throw new Error(`lpdp backfill: ${lpErr.message}`);
        const { error: stErr } = await supabase.from('ples').update({ status: 'evaluated' }).eq('id', p.id);
        if (stErr) throw new Error(`status flip: ${stErr.message}`);
        repaired++;
        continue;
      }
      // Stranded at ple_pass with no evaluation: the row IS already in the queue (services/eval-drain.js
      // claims ple_pass rows directly), so the sweep must NOT re-enqueue it — that would reset its
      // claim, attempts and backoff, and a row in flight would be claimed a second time (a duplicate
      // evaluation). Only a legacy row with no position timestamp gets one — its ended_at, so it keeps
      // its rightful place — and then the drain is woken. The sweep never evaluates directly.
      if (!p.eval_enqueued_at) {
        const { error: qErr } = await supabase.from('ples')
          .update({ eval_enqueued_at: p.ended_at ?? new Date(now).toISOString() }).eq('id', p.id);
        if (qErr) throw new Error(`queue stamp: ${qErr.message}`);
        requeued++;
      } else {
        queued++;
      }
      evalDrain.kick();
    } catch (e) {
      // A DETERMINISTIC RIMPL failure (bad/out-of-range model output → 502, or token misconfig → 401)
      // will NEVER self-heal — route to manual QA (ple_flag_t2) so the sweep stops re-paying Anthropic
      // every run (F7). A transient failure is left as-is to retry next sweep.
      if (isDeterministicRimplError(e)) {
        const { error: fErr } = await supabase.from('ples').update({ status: 'ple_flag_t2' }).eq('id', p.id);
        console.error(`[reconcile] PLE ${p.id} deterministic eval failure (${e.status}) -> manual QA${fErr ? ' (flag write failed: ' + fErr.message + ')' : ''}`);
        flagged++;
      } else {
        console.error(`[reconcile] PLE ${p.id} failed (transient):`, e.message);
        failed++;
      }
    }
  }
  return { stuck: (stuck ?? []).length, recovered, repaired, flagged, failed, requeued, queued, skipped };
}

module.exports = { reconcileEvaluations };
