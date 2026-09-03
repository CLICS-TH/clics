// The 100% human privacy review (CREC082 ICF §5-6, Declaration "Privacy gate", Infrastructure
// Statement "Privacy review").
//
// The protocol promises automated PII/PHI screening AND a human reading every transcript before it
// reaches an expert rater or the primary analysis, with anything containing patient data routed to
// quarantine / redaction / exclusion. Only the automated half existed: rimpl's pii-filter runs on
// the outbound cloud call, and a scored session went straight into the auditor queue.
//
// MODELLED AS A CLEARANCE, NOT A STATUS. The obvious implementation is a `privacy_review` status
// between 'evaluated' and assignable, but the scoring lifecycle and the privacy clearance are two
// different axes: a session is scored or not, and separately cleared or not. Folding them into one
// column would mean rewriting a dozen `.eq('status','evaluated')` filters across the admin queue,
// the auditor queue, the sampler, the physician result release and the dashboard's types — a large
// change to a live system to express something that is not actually a lifecycle stage.
//
// The cost of the column approach is that the gate has to be applied at each exposure point rather
// than falling out of one status check. There are four, and they are enumerated in CLEARED_SQL's
// callers so a fifth is hard to add without noticing.

// A human looked and said the transcript is safe to hand on. 'redacted' counts: a reviewer found
// something, fixed it, and cleared what remains — that is the protocol's "de-identify" outcome.
const CLEARED = ['passed', 'redacted'];

// Everything else withholds the session. 'pending' means nobody has looked yet, which is the
// default and the honest state for any session predating the gate.
const DECISIONS = ['pending', 'passed', 'redacted', 'quarantined', 'excluded'];

// Applies the clearance filter to a PostgREST query over `ples`.
//
// Takes `required` rather than reading the setting itself, so a caller that already resolved it
// does not pay a second settings read, and so the filter is a pure function of its inputs.
function whereCleared(q, required) {
  return required ? q.in('privacy_review_status', CLEARED) : q;
}

// Is THIS session cleared to be handed to a rater? Mirrors whereCleared for single-row checks.
//
// A row with no privacy_review_status at all (pre-migration, or a select that did not ask for the
// column) is treated as NOT cleared when the gate is on. Failing closed is the only safe default
// for a gate whose whole purpose is to stop unreviewed patient data reaching a third party.
function isCleared(ple, required) {
  if (!required) return true;
  return CLEARED.includes(ple?.privacy_review_status);
}

module.exports = { CLEARED, DECISIONS, whereCleared, isCleared };
