// PLE lifecycle statuses, and the one predicate that says "this PLE counted".
//
// WHY THIS FILE EXISTS. `ple_pass` looks like a terminal success state and is not one. It is written
// by ple-finalize.js when tier-2 screening passes, and then ple-evaluation.js overwrites it with
// 'evaluated' as soon as the PIS-7 score lands — normally within seconds. So a row only sits at
// 'ple_pass' during the gap between screening and scoring, or when the evaluation genuinely failed
// and reconcile has not yet swept it. Production has never had a single row resting there.
//
// Five separate call sites nonetheless counted completed PLEs with .eq('status','ple_pass'), and so
// counted zero every time: the ≤3-episode cap never fired, and the compensation pipeline reported
// ฿0 owed to physicians who had in fact completed sessions. The bug is invisible in code review
// because the status name reads as success; it is only visible against real data.
//
// Anything asking "did this PLE complete and count?" must use COMPLETED_STATUSES. Anything asking
// "is this PLE still moving?" (queue buckets, progress views) should keep treating 'ple_pass' as
// in-progress — there, "score pending" is the accurate reading.

// Screening passed. Either the score has landed ('evaluated') or it is still on its way
// ('ple_pass'); both mean the physician finished a session that counts toward their 3.
const COMPLETED_STATUSES = ['ple_pass', 'evaluated'];

// Applies the completed filter to a PostgREST query builder, so no call site has to remember
// whether it is one status or two.
const whereCompleted = (q) => q.in('status', COMPLETED_STATUSES);

module.exports = { COMPLETED_STATUSES, whereCompleted };
