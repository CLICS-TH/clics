const { treeSha } = require('../../src/booth-cases/tree-sha');

/** A test case as a build would leave it: its table, if any, stamped with the hash of the tree the test made. */
const stamped = (k) => (k.path_score_table
  ? { ...k, path_score_table: { ...k.path_score_table, provenance: { ...k.path_score_table.provenance, tree_sha256: treeSha(k) } } }
  : k);

module.exports = { stamped };
