// CLE lifecycle statuses, and the one predicate that says "this CLE counted".
//
// WHY THIS FILE EXISTS. `cle_pass` looks like a terminal success state and is not one. It is written
// by cle-finalize.js when tier-2 screening passes, and then cle-evaluation.js overwrites it with
// 'evaluated' as soon as the PIS-7 score lands — normally within seconds. So a row only sits at
// 'cle_pass' during the gap between screening and scoring, or when the evaluation genuinely failed
// and reconcile has not yet swept it. Production has never had a single row resting there.
//
// Five separate call sites nonetheless counted completed CLEs with .eq('status','cle_pass'), and so
// counted zero every time: the ≤3-episode cap never fired, and the compensation pipeline reported
// ฿0 owed to physicians who had in fact completed sessions. The bug is invisible in code review
// because the status name reads as success; it is only visible against real data.
//
// Anything asking "did this CLE complete and count?" must use COMPLETED_STATUSES. Anything asking
// "is this CLE still moving?" (queue buckets, progress views) should keep treating 'cle_pass' as
// in-progress — there, "score pending" is the accurate reading.

// Screening passed. Either the score has landed ('evaluated') or it is still on its way
// ('cle_pass'); both mean the physician finished a session that counts toward their 3.
const COMPLETED_STATUSES = ['cle_pass', 'evaluated'];

// Applies the completed filter to a PostgREST query builder, so no call site has to remember
// whether it is one status or two.
const whereCompleted = (q) => q.in('status', COMPLETED_STATUSES);

module.exports = { COMPLETED_STATUSES, whereCompleted };
