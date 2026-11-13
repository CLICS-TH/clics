// The hash of a booth case's tree (ADR 0005, ADR 0009): every field of the case file but version, admission and the
// path score table, keys sorted. None of those three is text a visitor reads, so a case keeps its safety review and
// its table while they change; any other edit changes the hash. Package-free: scripts/booth/path-table.mjs uses it.
const { createHash } = require('crypto');

const NOT_TREE = new Set(['version', 'admission', 'path_score_table']);

const canonical = (x) => (Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`
    : JSON.stringify(x));

const treeSha = (raw) => createHash('sha256')
  .update(canonical(Object.fromEntries(Object.entries(raw).filter(([k]) => !NOT_TREE.has(k))))).digest('hex');

// The tree a safety review read, in its reviewer's own words: `findings` names it as "tree sha256 <64 hex>" (AUTHORING.md,
// "Moving a staged case into place"). The mover writes `tree_sha256`; a tree_sha256 recomputed after an edit no longer
// matches the findings, so the edit is refused. Undefined unless the findings name exactly one hash, so a review
// that names none, or two, binds no tree.
const TREE_NAMED = /\btree sha256 ([0-9a-f]{64})(?![0-9a-f])/gi;
const reviewedSha = (findings) => {
  const named = new Set([...String(findings ?? '').matchAll(TREE_NAMED)].map((m) => m[1].toLowerCase()));
  return named.size === 1 ? [...named][0] : undefined;
};

module.exports = { canonical, treeSha, reviewedSha };
