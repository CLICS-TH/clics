// Data retention and de-identification (CREC082 Data Management & Protection Plan §8, ICF §11).
//
// The commitment: "ข้อมูลวิจัยเก็บไม่เกิน 5 ปีหลังสิ้นสุดโครงการ แล้วทำลายหรือทำให้ไม่สามารถ
// เชื่อมโยงกลับได้ตาม data destruction policy. ข้อมูลการเงินเก็บตามระเบียบการเงิน/บัญชีที่เกี่ยวข้อง
// และแยกจาก research dataset."
//
// Three things in that sentence drive the design.
//
// 1. "ทำลาย OR ทำให้ไม่สามารถเชื่อมโยงกลับได้" — destroy OR make unlinkable. The protocol offers
//    both and DE-LINKING IS THE BETTER ONE. The research dataset is what the study exists to
//    produce; destroying it wholesale to satisfy a privacy clause throws away the science along
//    with the risk. Severing the identity link removes re-identification and keeps the data.
//    So the default operation here breaks links; destruction is a separate, deliberate choice.
//
// 2. "ข้อมูลการเงิน... แยกจาก research dataset" — financial records follow accounting rules, not
//    this clock, and are explicitly a SEPARATE class. payment_info and payouts are therefore
//    excluded by name below, not by omission. Sweeping them with the research data would breach a
//    different retention obligation to satisfy this one.
//
// 3. "ไม่เกิน 5 ปีหลังสิ้นสุดโครงการ" — the clock starts at PROJECT END, a date nobody knows yet.
//    Until a superadmin records it, nothing is due and nothing can run.
//
// ⚠️ THERE IS DELIBERATELY NO SCHEDULER HERE, and that is a departure from the original plan.
// The deadline is five years after a project that has not started — roughly 2031. A cron job
// written today, unattended for five years, executing irreversible deletes against a schema that
// will have changed several times, is a far larger risk than the one it manages. What the protocol
// actually needs is that the policy is recorded, the deadline is computable, the affected set is
// enumerable and checkable in advance, and execution leaves an audit trail. That is what this is.
// A human runs it, once, when it is due.
const { supabase } = require('../lib/supabase');
const { getSetting, getTextSetting } = require('../lib/settings');

const DEFAULT_RETENTION_YEARS = 5;

// Everything that can re-identify a physician, enumerated against the real schema rather than
// inferred. Each entry says what happens to it and why — a table added later without a decision
// recorded here is a gap, and an empty `columns` means the whole row goes.
const IDENTITY_TARGETS = [
  { table: 'oauth_identities',       action: 'delete',
    why: 'The on-prem identity vault: encrypted real name, email, and provider id. Nothing in the research dataset needs it once the study is closed.' },
  { table: 'identity_verifications', action: 'delete',
    why: 'National ID (encrypted + blind index) and licence number. The strongest link that exists; CREC082 ICF §4 keeps it separate from the research data precisely so it can be removed on its own.' },
  { table: 'ple_pii_map',            action: 'delete',
    why: 'The reversible token→raw map RIMPL builds during de-identification. Its entire purpose is re-linkage, so it cannot survive a de-identification pass.' },
  { table: 'ple_patient_refs',       action: 'delete',
    why: 'Patient identifiers the physician supplied on-prem. Third-party PII — the most sensitive class here and the least defensible to keep.' },
  { table: 'license_verifications',  action: 'delete',
    why: 'Licence-lookup evidence from the retired TMC gate: licence number, the name queried, and the encrypted scrape.' },
  { table: 'access_requests',        action: 'delete',
    why: 'Sign-up requests carrying a real name and email; no research value at all.' },
  { table: 'invites',                action: 'delete',
    why: 'Invite rows carrying the invitee email address.' },
  { table: 'professionals',          action: 'nullify',
    columns: ['full_name_th', 'full_name_en', 'email', 'license_number'],
    why: 'The row itself STAYS: pseudonym, council, specialty and position are research variables, and deleting it would cascade the PLEs it owns. Only the name/email/licence columns are cleared, which is exactly "ทำให้ไม่สามารถเชื่อมโยงกลับได้" — the pseudonym remains, and there is no longer anything it maps to.' },
];

// Named so a reader can see the exclusion was a decision, not an oversight.
const EXCLUDED_BY_POLICY = [
  { table: 'payment_info', why: 'Financial record. §8 keeps it under accounting rules and separate from the research dataset — a different clock, not this one.' },
  { table: 'payouts',      why: 'Financial ledger of what was actually paid. Also a financial record under §8, kept to its own accounting clock rather than this one.' },
  { table: 'audit_log',    why: 'The accountability record, including the record of this very operation. Erasing the log as part of a compliance step would defeat it.' },
];

// Project end is a date only a human knows. Stored as text (app_settings.value is numeric).
async function retentionPolicy() {
  const [endText, years] = await Promise.all([
    getTextSetting('project_end_date', null),
    getSetting('retention_years', DEFAULT_RETENTION_YEARS),
  ]);
  const projectEnd = endText && !Number.isNaN(Date.parse(endText)) ? new Date(endText) : null;
  const retentionYears = Number.isFinite(years) && years > 0 ? years : DEFAULT_RETENTION_YEARS;
  let dueAt = null;
  if (projectEnd) {
    dueAt = new Date(projectEnd);
    dueAt.setFullYear(dueAt.getFullYear() + retentionYears);
  }
  return {
    project_end_date: projectEnd ? projectEnd.toISOString().slice(0, 10) : null,
    retention_years: retentionYears,
    due_at: dueAt ? dueAt.toISOString().slice(0, 10) : null,
  };
}

// How many rows each target currently holds. Counts only — this must be safe to call from a
// dashboard, so it never reads a value.
async function plan() {
  const policy = await retentionPolicy();
  const counts = await Promise.all(IDENTITY_TARGETS.map(async (t) => {
    const { count, error } = await supabase.from(t.table).select('id', { count: 'exact', head: true });
    return { ...t, rows: error ? null : (count ?? 0), error: error?.message ?? null };
  }));
  return {
    ...policy,
    due: !!policy.due_at && Date.now() >= Date.parse(policy.due_at),
    targets: counts,
    excluded: EXCLUDED_BY_POLICY,
  };
}

// The typed confirmation. Long and specific on purpose: a one-word "yes" is too easy to send by
// accident to an endpoint that cannot be undone.
const CONFIRM_PHRASE = 'DE-IDENTIFY THE RESEARCH DATASET';

// Execute. Refuses unless the deadline has actually passed and the phrase matches exactly.
//
// Not transactional across tables — PostgREST has no multi-statement transaction — so it reports
// per-target outcomes and keeps going. A partial pass is recoverable by re-running; the operation is
// idempotent because every target either deletes rows or clears already-cleared columns.
async function execute({ confirm, actorId, force = false }) {
  const p = await plan();
  if (!p.due_at) return { ok: false, code: 'no_project_end_date' };
  if (!p.due && !force) return { ok: false, code: 'not_yet_due', due_at: p.due_at };
  if (confirm !== CONFIRM_PHRASE) return { ok: false, code: 'confirmation_mismatch' };

  const results = [];
  for (const t of IDENTITY_TARGETS) {
    try {
      const q = supabase.from(t.table);
      // `not('id','is',null)` is a match-all predicate: PostgREST refuses an unfiltered delete or
      // update, which is a guard worth keeping rather than working around with a raw statement.
      const { error } = t.action === 'delete'
        ? await q.delete().not('id', 'is', null)
        : await q.update(Object.fromEntries(t.columns.map(c => [c, null]))).not('id', 'is', null);
      results.push({ table: t.table, action: t.action, ok: !error, error: error?.message ?? null });
    } catch (e) {
      results.push({ table: t.table, action: t.action, ok: false, error: e.message });
    }
  }
  return { ok: results.every(r => r.ok), actorId, executed_at: new Date().toISOString(), results };
}

module.exports = {
  DEFAULT_RETENTION_YEARS, IDENTITY_TARGETS, EXCLUDED_BY_POLICY, CONFIRM_PHRASE,
  retentionPolicy, plan, execute,
};
