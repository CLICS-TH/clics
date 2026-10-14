// The transcript a reader who must NOT see identifiers is shown (the auditor). docs/CONSENT-TEMPLATE.md
// tells participants "Auditors see only the de-identified transcript", and the stored `messages` are
// RAW — they are the evidentiary record and stay that way. So the masking happens on the way out, in
// RIMPL (rimplDeidentify), never here: the one place identifiers are handled is the on-prem layer.
//
// What is masked: every free-text field a turn carries to the reader —
//   content             every role: the physician's turns, the reflection, AND the assistant's replies
//                       (a reply can echo an identifier the filter let through to the model);
//   socratic_question   assistant text, copied out of the reply;
//   refs[].source/title citation text, copied out of the reply (the dashboard renders it).
// Nothing else passes through except `role` and `created_at` (fixed vocabulary and a timestamp). A
// field added to the caller's select later is DROPPED here until it is handled below — never passed
// through raw by default.
//
// ONE request, ONE registry: every turn's content first, in transcript order — the order /chat numbers
// them in, so a token the model wrote into its own stored reply names the same person here — then the
// copied fields after ALL turns, so they cannot shift the transcript's numbering.
//
// Throws on any failure (rimplDeidentify does too). The caller fails closed; there is no raw fallback.
const { rimplDeidentify } = require('./rimpl-client');

const PASS_THROUGH = ['role', 'created_at'];
const REF_TEXT = ['source', 'title'];

async function deidentifyTranscript(messages, { patientRef = null, chiefComplaint = null } = {}) {
  const turns = Array.isArray(messages) ? messages : [];
  const entries = turns.map(m => ({ role: String(m?.role ?? ''), content: typeof m?.content === 'string' ? m.content : '' }));
  // Copied fields: queued AFTER every turn, each with the setter that puts its masked text back.
  const setters = [];
  const queue = (role, text, put) => { entries.push({ role, content: text }); setters.push(put); };

  const out = turns.map((m, i) => {
    const o = {};
    for (const k of PASS_THROUGH) if (m && k in m) o[k] = m[k];
    o.content = null; // filled from the masked copy below; null (never raw) for a non-string
    const role = entries[i].role;
    if (m && 'socratic_question' in m) {
      const q = m.socratic_question;
      o.socratic_question = q === '' ? '' : null;
      if (typeof q === 'string' && q) queue(role, q, (t) => { o.socratic_question = t; });
    }
    if (m && 'refs' in m) {
      o.refs = Array.isArray(m.refs)
        ? m.refs.map((r, j) => {
          if (typeof r === 'string') { queue(role, r, (t) => { o.refs[j] = t; }); return null; }
          if (!r || typeof r !== 'object') return null;
          const ref = {};
          for (const key of REF_TEXT) if (typeof r[key] === 'string') queue(role, r[key], (t) => { ref[key] = t; });
          return ref;
        })
        : (m.refs == null ? m.refs : null);
    }
    return o;
  });

  const masked = await rimplDeidentify({ messages: entries, patient_ref: patientRef, chief_complaint: chiefComplaint });
  turns.forEach((m, i) => { if (typeof m?.content === 'string') out[i].content = masked.messages[i].content; });
  setters.forEach((put, k) => put(masked.messages[turns.length + k].content));
  return out;
}

module.exports = { deidentifyTranscript };
