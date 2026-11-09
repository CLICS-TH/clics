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

module.exports = { canonical, treeSha };
