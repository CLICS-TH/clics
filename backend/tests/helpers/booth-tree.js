const { treeSha } = require('../../src/booth-cases/tree-sha');

const TREE_BOUND = ['safety_review', 'sandbox', 'owner_waiver'];

// A safety review names the tree it read in its findings too (tree-sha.js reviewedSha).
const NAMED = /\s*Tree sha256 [0-9a-f]{64}\.?/gi;
const named = (record, sha) => ({ ...record, findings: `${record.findings.replace(NAMED, '')} Tree sha256 ${sha}.` });

/** A test case as a review and a build would leave it: its table, if any, and each record that judges its tree,
 *  stamped with the hash of the tree the test made, the safety review's findings included. */
const stamped = (k) => {
  const sha = treeSha(k);
  const admission = k.admission && Object.fromEntries(Object.entries(k.admission)
    .map(([name, record]) => [name, TREE_BOUND.includes(name) ? { ...(name === 'safety_review' ? named(record, sha) : record), tree_sha256: sha } : record]));
  return {
    ...k,
    ...(admission ? { admission } : {}),
    ...(k.path_score_table ? { path_score_table: { ...k.path_score_table, provenance: { ...k.path_score_table.provenance, tree_sha256: sha } } } : {}),
  };
};

module.exports = { stamped };
