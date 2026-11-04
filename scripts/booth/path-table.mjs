// The path score table build's pure half (#373, ADR 0009): the reviewed-tree check, the median per domain, the
// difficulty re-check and the committed summary. Package-free, like the other booth scripts, so CI tests it with no
// install.
import treeHash from '../../backend/src/booth-cases/tree-sha.js';
import { PATH_GROUPS, verdicts } from './sandbox-verdict.mjs';

const { canonical, treeSha } = treeHash;
export { treeSha };

/**
 * Whether a case's tree is the one its safety review read. The review read the tree of the first commit that holds
 * that review (the review is recorded in the case's PR, after its fixes), so the current tree must hash the same.
 * @param {{ commit: string, raw: object }[]} history the case file at each commit that touched it, oldest first
 * @param {object} current the case file as it is now
 * @returns {{ tree_sha256: string, reviewed_commit: string } | { why: string }}
 */
export function reviewedTree(history, current) {
  const review = current?.admission?.safety_review;
  if (!review) return { why: 'has no safety review' };
  const reviewed = history.find((v) => canonical(v.raw?.admission?.safety_review) === canonical(review));
  if (!reviewed) return { why: 'has a safety review that no commit holds' };
  const sha = treeSha(reviewed.raw);
  if (treeSha(current) !== sha) return { why: `changed its tree since the safety review in ${reviewed.commit.slice(0, 8)}` };
  return { tree_sha256: sha, reviewed_commit: reviewed.commit };
}

/** The table entry of one path: per domain, the median of its samples' whole scores (an odd count, so a whole). */
export function medianDomains(samples) {
  if (!samples.length || samples.length % 2 === 0) throw new Error(`a median needs an odd number of samples, got ${samples.length}`);
  return Object.fromEntries(Object.keys(samples[0]).map((k) => {
    const xs = samples.map((s) => s[k]).sort((a, b) => a - b);
    return [k, xs[(xs.length - 1) / 2]];
  }));
}

/**
 * ADR 0005's difficulty check, re-run on the table's own samples: each scripted group is its path's sample
 * composites (best, mixed and weakest, as the sandbox plays them), judged against this build's pool.
 * @param {Record<string, Record<string, number[]>>} composites per case id, then per tier path
 * @param {Record<string, string>} paths the tier path of each scripted group
 */
export function recheck(composites, paths, { samples, incomplete } = {}) {
  const table = Object.fromEntries(Object.entries(composites).map(([id, byPath]) => [id,
    Object.fromEntries(PATH_GROUPS.map((g) => [g, byPath[paths[g]] ?? []]))]));
  return verdicts(table, PATH_GROUPS, { runs: Object.fromEntries(PATH_GROUPS.map((g) => [g, samples])), incomplete });
}

/** The short summary fit to commit: each case's tree check and table, its score per tier path, and the re-check. */
export function summaryMarkdown(report) {
  const ids = Object.keys(report.cases);
  const built = ids.filter((id) => report.cases[id].table);
  const failing = ids.filter((id) => report.recheck.cases[id] && !report.recheck.cases[id].pass);
  const paths = Object.keys(report.cases[built[0]]?.composites ?? {});
  const lines = [
    `# Booth path score tables, run ${report.run_id}`,
    '',
    `${report.date}. ${report.scored} of ${report.planned} samples scored, $${report.spent_usd.toFixed(2)} spent of a `
      + `$${report.cap_usd} cap${report.stopped ? ', stopped at the cap' : ''}${report.over_cap ? ', OVER the cap' : ''}. `
      + `Evaluator ${report.evaluator?.model ?? 'none'} via rimpl (${report.evaluator?.provider ?? 'none'}), prompt `
      + `${report.evaluator?.prompt_version ?? 'none'}. ${report.samples} samples per tier path, median per domain. `
      + `${built.length} of ${ids.length} cases have a table.`,
    '',
    '| Case | Version | Tree | Table | Re-check |',
    '|---|---|---|---|---|',
    ...ids.map((id) => {
      const c = report.cases[id];
      const v = report.recheck.cases[id];
      return `| ${id} | ${c.version} | ${c.tree_sha256 ? `${c.tree_sha256.slice(0, 12)} (review ${c.reviewed_commit.slice(0, 8)})` : `refused: ${c.why}`} `
        + `| ${c.table ? 'built' : c.tree_sha256 ? `none: ${c.why}` : 'none'} | ${v ? (v.pass ? 'pass' : 'FAIL') : 'not run'} |`;
    }),
    '',
    '## Difficulty re-check (ADR 0005)',
    '',
    `Each group is its tier path's ${report.samples} sample composites (best BBB, mixed BRW, weakest WWW), judged `
      + `against this run's pool: every group mean within its band of the pool median, and best at least `
      + `${report.recheck.gap_min} above weakest.`,
    '',
    `| Case | ${PATH_GROUPS.join(' | ')} | Best − weakest | Verdict |`,
    `|---|${PATH_GROUPS.map(() => '---').join('|')}|---|---|`,
    ...Object.entries(report.recheck.cases).map(([id, v]) => `| ${id} | ${PATH_GROUPS.map((g) => (v.means[g] == null ? 'none' : `${v.means[g]} ± ${v.sd[g]}`)).join(' | ')} | ${v.separation ?? 'none'} | ${v.pass ? 'pass' : 'FAIL'} |`),
    `| pool median (cases) | ${PATH_GROUPS.map((g) => `${report.recheck.medians[g] ?? 'none'} (${report.recheck.pool_n[g]})`).join(' | ')} | | |`,
    `| band (±) | ${PATH_GROUPS.map((g) => report.recheck.bands[g] ?? 'none').join(' | ')} | ${report.recheck.gap_min} | |`,
  ];
  if (failing.length) {
    lines.push('', '### Why cases failed', '', ...failing.map((id) => `- ${id}: ${report.recheck.cases[id].reasons.join('; ')}`),
      '', `Each failing case needs the owner to waive it again against run ${report.run_id}, or to switch it off.`);
  }
  if (paths.length) {
    lines.push('', '## Demo score per tier path', '', 'The composite of each table entry: what a play on that path scores.', '',
      `| Path | ${built.join(' | ')} |`, `|---|${built.map(() => '---').join('|')}|`,
      ...paths.map((p) => `| ${p} | ${built.map((id) => report.cases[id].composites[p]).join(' | ')} |`));
  }
  return `${lines.join('\n')}\n`;
}
