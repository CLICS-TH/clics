// The PIS-7 weighted composite: the one number a physician's CME credit is decided on.
//
// WHY THIS IS ITS OWN FILE. compositeOf lived in lib/pis7.js, which needs zod for the score schema.
// The probe harness (scripts/probe/) must report agreement on exactly this number, but its CI job runs
// on a bare checkout with no npm install, so it could not load pis7.js — and four probe scripts
// re-implemented the composite instead, as an UNWEIGHTED d1..d7 sum on a 0–35 scale that production
// never computes. This file needs only ./versions (node's crypto plus the prompt text), so anything can
// load it. pis7.js re-exports it: there is still exactly one definition.
//
// Keep it package-free. A require() of anything in node_modules here breaks the probe CI job, and
// scripts/probe/agreement-stats.test.mjs fails locally first, where node_modules would hide it.
const { WEIGHTS } = require('./versions');

// ×20 gives a 0–100 range: max = 5 × 1.0 × 20 = 100.
function compositeOf(scores) {
  const raw = Object.entries(WEIGHTS).reduce((acc, [key, w]) => acc + scores[key] * w, 0) * 20;
  return Math.round(raw * 100) / 100;
}

module.exports = { compositeOf };
