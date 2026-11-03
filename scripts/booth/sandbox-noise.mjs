#!/usr/bin/env node
/*
 * Measures the play-to-play noise the sandbox verdict is sized from (SIGMA in sandbox-verdict.mjs), from two or more
 * full sandbox reports of the same cases:
 *
 *   node scripts/booth/sandbox-noise.mjs scripts/booth/sandbox-runs/<run1>.json scripts/booth/sandbox-runs/<run2>.json
 *
 * path: each scripted path's scored plays, one per run, compared run to run: sigma = sqrt(mean(d^2) / 2) over the
 * differences d of the first two runs. persona: the pooled within-run SD of each persona's runs per case.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PATH_GROUPS } from './sandbox-verdict.mjs';

const r2 = (x) => Math.round(x * 100) / 100;

/** @param {{ plays: { case_id: string, group: string, composite: number | null }[] }[]} reports */
export function noise(reports) {
  const scored = (r, id, g) => r.plays.filter((p) => p.case_id === id && p.group === g && p.composite != null).map((p) => p.composite);
  const ids = [...new Set(reports.flatMap((r) => r.plays.map((p) => p.case_id)))];
  const diffs = [];
  for (const id of ids) {
    for (const g of PATH_GROUPS) {
      const [a, b] = reports.slice(0, 2).map((r) => scored(r, id, g));
      // Paired run against run: the k-th play of each run.
      for (let k = 0; k < Math.min(a.length, b.length); k += 1) diffs.push(b[k] - a[k]);
    }
  }
  let ss = 0;
  let df = 0;
  for (const r of reports) {
    for (const id of ids) {
      for (const g of new Set(r.plays.map((p) => p.group))) {
        if (PATH_GROUPS.includes(g)) continue;
        const xs = scored(r, id, g);
        if (xs.length < 2) continue;
        const m = xs.reduce((s, x) => s + x, 0) / xs.length;
        ss += xs.reduce((s, x) => s + (x - m) ** 2, 0);
        df += xs.length - 1;
      }
    }
  }
  const abs = diffs.map(Math.abs).sort((x, y) => x - y);
  return {
    path: { sigma: diffs.length ? r2(Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length / 2)) : null,
      pairs: diffs.length, median_abs_diff: abs.length ? abs[Math.floor((abs.length - 1) / 2)] : null, max_abs_diff: abs.at(-1) ?? null },
    persona: { sigma: df ? r2(Math.sqrt(ss / df)) : null, df },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (files.length < 2) {
    console.error('usage: sandbox-noise.mjs <report.json> <report.json> [...]');
    process.exit(2);
  }
  console.log(JSON.stringify(noise(files.map((f) => JSON.parse(readFileSync(f, 'utf8')))), null, 2));
}
