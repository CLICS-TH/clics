#!/usr/bin/env node
// coverage-paired.mjs — the pre-registered before/after verdict on per-reply evidence coverage (C-1,
// docs/QUALITY-GATES.md, amended 2026-10-02): an exact one-sided McNemar test over the bank items the
// two runs share, at alpha 0.025 per direction. Compare ONE arm with itself — same model, same bank,
// same cite-verify version, inputs identical except the prompt. It warns when the two runs disagree
// on bank, model, checker version or prompt labels. Per item, it compares the messages each run
// actually sent (request.messages) and EXCLUDES from the verdict every item whose input differs,
// naming them (the reason is in checks.mjs pairedCoverage).
//
// Two runs of the SAME prompt (identical prompt_versions) are a noise check, not a before/after —
// e.g. the fresh local baseline against the committed 2026-10-02 local run. It runs the same way and
// says so.
//
// Usage:
//   node scripts/quality/coverage-paired.mjs <before.json> <before.cites.json> <after.json> <after.cites.json> [--json]
//
// Offline: reads four files, makes no network call and no AI call.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { checkReport, pairedCoverage, inputsById } from './checks.mjs';
import { fmtRate } from './stats.mjs';

/** Provenance differences that would make the pairing measure something other than the prompt. */
export function pairingWarnings(beforeReport, afterReport, beforeCites, afterCites) {
  const w = [];
  const pb = beforeReport.provenance ?? {};
  const pa = afterReport.provenance ?? {};
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  if (!same(pb.bank_sha, pa.bank_sha)) w.push(`different banks: ${pb.bank_sha} vs ${pa.bank_sha}`);
  if (!same(pb.models_reported, pa.models_reported)) w.push(`different models: ${JSON.stringify(pb.models_reported)} vs ${JSON.stringify(pa.models_reported)}`);
  if (!same(beforeCites.known_sources_version, afterCites.known_sources_version)) {
    w.push(`different cite-verify sources: ${beforeCites.known_sources_version} vs ${afterCites.known_sources_version} — re-verify both with one version`);
  }
  if (same(pb.prompt_versions, pa.prompt_versions)) w.push('identical prompt_versions — this compares two runs of the same prompt (a noise check, not a before/after)');
  for (const [label, r, c] of [['before', beforeReport, beforeCites], ['after', afterReport, afterCites]]) {
    if (c.report_label && r.label && c.report_label !== r.label) w.push(`${label}: cites file is for "${c.report_label}", report is "${r.label}"`);
  }
  // Per item: did the model receive the same messages both times? (The system prompt is not part of
  // request.messages, so a prompt change alone leaves these equal.) pairedCoverage EXCLUDES the
  // differing items from the verdict; this names every one, rescue items included.
  const ib = inputsById(beforeReport);
  const ia = inputsById(afterReport);
  const differ = [...ib.keys()].filter((id) => ia.has(id) && ib.get(id) !== ia.get(id)).sort();
  if (differ.length) w.push(`${differ.length} item(s) received different input in the two runs and are excluded from the verdict: ${differ.join(', ')}`);
  const afterIds = new Set((afterReport.items ?? []).map((e) => e.id));
  const unrecorded = (beforeReport.items ?? []).map((e) => e.id).filter((id) => afterIds.has(id) && (!ib.has(id) || !ia.has(id)));
  if (unrecorded.length) w.push(`${unrecorded.length} item(s) in both runs have no recorded request on one side — their inputs could not be compared: ${unrecorded.join(', ')}`);
  return w;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (args.length !== 4) {
    console.error('usage: node scripts/quality/coverage-paired.mjs <before.json> <before.cites.json> <after.json> <after.cites.json> [--json]');
    process.exit(2);
  }
  const [rb, cb, ra, ca] = await Promise.all(args.map(async (f) => JSON.parse(await readFile(f, 'utf8'))));
  const { loadBank } = await import('./bank.mjs');
  const { items } = await loadBank();
  const bankById = new Map(items.map((it) => [it.id, it]));
  const before = { results: checkReport(rb, bankById).results, cites: cb, inputs: inputsById(rb) };
  const after = { results: checkReport(ra, bankById).results, cites: ca, inputs: inputsById(ra) };
  const r = pairedCoverage(before, after);
  const warnings = pairingWarnings(rb, ra, cb, ca);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ before: args[0], after: args[2], warnings, ...r }, null, 2));
    return;
  }
  console.log(`\n  per-reply evidence coverage, paired (exact one-sided McNemar, alpha ${r.alpha} per direction)`);
  console.log(`    before  ${rb.label}   ${fmtRate(r.before)}`);
  console.log(`    after   ${ra.label}   ${fmtRate(r.after)}`);
  console.log(`    paired n ${r.n_paired}: both ${r.both}, gained ${r.gained}, lost ${r.lost}, neither ${r.neither}`);
  console.log(`    p(improved) ${r.p_improved.toPrecision(3)}   p(worse) ${r.p_worse.toPrecision(3)}   verdict: ${r.verdict.toUpperCase()}`);
  if (r.excluded.length) {
    console.log(`    excluded (${r.excluded.length}): ${r.excluded.map((e) => `${e.id} [${e.reason ?? `${e.before}/${e.after}`}]`).join(', ')}`);
  }
  if (r.inputs_unchecked.length) console.log(`    inputs not compared for ${r.inputs_unchecked.length} paired item(s): ${r.inputs_unchecked.join(', ')}`);
  for (const w of warnings) console.log(`    ⚠ ${w}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
