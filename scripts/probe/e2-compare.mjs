#!/usr/bin/env node
/*
 * Compare saved E2 evaluator reports without opening a transcript fixture or calling either model.
 *
 * WHY THIS EXISTS. The local PIS-7 evaluator's self-consistency rule has single-call, adaptive
 * two-call, and always-three-call median variants, each optionally constrained by a Σ|Δ|
 * pair-agreement bound. Choosing among them means comparing several repeat-consistency.mjs --out
 * reports side by side against the repeat-noise and JSON-contract bars, then relating the winner's
 * noise floor to one model-agreement.mjs --out report. That comparison otherwise happens by eye
 * across terminal scrollback.
 *
 * This reader opens report JSON only. It rejects any input resolving inside the fixture directory,
 * and its output is limited to report labels, split/model-consistency identifiers, counts, and
 * numeric summaries—never transcript content.
 */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dim, red, green, yellow, hr, table, percentile, fail } from './lib.mjs';

const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(SCRIPT_DIR, 'fixtures');
const HELP = `Usage:
  node scripts/probe/e2-compare.mjs --repeat a.json [--repeat b.json ...]
       [--agreement x.json] [--json] [--allow-heldout]

Compare saved repeat-consistency reports against the E2 noise/JSON bars and, optionally,
summarize one saved local-vs-cloud agreement report. This command never opens a fixture.`;

if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
  console.log(HELP);
  process.exit(0);
}

class InputError extends Error {}

function parseCli(argv) {
  const options = { repeats: [], agreement: null, json: false, allowHeldout: false };
  const valueFor = (arg, index, name) => {
    const equal = arg.indexOf('=');
    if (equal !== -1) {
      const value = arg.slice(equal + 1);
      if (!value) throw new InputError(`--${name} needs a file path`);
      return { value, next: index };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new InputError(`--${name} needs a file path`);
    return { value, next: index + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repeat' || arg.startsWith('--repeat=')) {
      const parsed = valueFor(arg, i, 'repeat');
      options.repeats.push(parsed.value);
      i = parsed.next;
    } else if (arg === '--agreement' || arg.startsWith('--agreement=')) {
      if (options.agreement !== null) throw new InputError('--agreement may be given only once');
      const parsed = valueFor(arg, i, 'agreement');
      options.agreement = parsed.value;
      i = parsed.next;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--allow-heldout') {
      options.allowHeldout = true;
    } else {
      throw new InputError(`unknown argument ${JSON.stringify(arg)}\n\n${HELP}`);
    }
  }

  if (!options.repeats.length) throw new InputError('at least one --repeat report is required');
  return options;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const range = (values) => values.length ? Math.max(...values) - Math.min(...values) : null;
const fmt = (value, digits = 2) => value === null ? '—' : value.toFixed(digits);
const splitLabel = (name) => name === null ? '(none)' : name;

function splitName(report, reportName) {
  if (report.split === null) return null;
  if (!isObject(report.split) || typeof report.split.name !== 'string' || !report.split.name) {
    throw new InputError(`${reportName} must contain split: null or split.name as a non-empty string`);
  }
  return report.split.name;
}

function assertScores(scores, context) {
  if (!isObject(scores)) throw new InputError(`${context} must be a d1..d7 score object`);
  for (const domain of DOMAINS) {
    if (!Number.isFinite(scores[domain])) throw new InputError(`${context}.${domain} must be a number`);
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readReport(file, kind) {
  let resolved;
  try {
    resolved = await realpath(file);
  } catch (error) {
    throw new InputError(`cannot resolve ${kind} report ${JSON.stringify(file)}: ${error.message}`);
  }
  if (isWithin(FIXTURE_DIR, resolved)) {
    throw new InputError(`refusing to open ${JSON.stringify(file)}: report inputs must not be inside scripts/probe/fixtures/`);
  }
  let text;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (error) {
    throw new InputError(`cannot read ${kind} report ${JSON.stringify(file)}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(`${kind} report ${JSON.stringify(file)} is not valid JSON: ${error.message}`);
  }
}

function validateRepeat(report, reportName) {
  if (!isObject(report)) throw new InputError(`${reportName} must contain a JSON object`);
  splitName(report, reportName);
  // A report written before repeat-consistency recorded the rule (2026-09-02) is a single-call run by
  // construction — read it as 'off' rather than refusing the only baseline that exists.
  if (report.consistency === undefined) report.consistency = 'off';
  if (report.agree_sum === undefined) report.agree_sum = 0;
  if (!['off', 'adaptive', 'median3'].includes(report.consistency)) {
    throw new InputError(`${reportName}.consistency must be off, adaptive, or median3`);
  }
  if (!Number.isFinite(report.agree_sum)) throw new InputError(`${reportName}.agree_sum must be a number`);
  if (!Number.isFinite(report.repeats) || report.repeats < 1) {
    throw new InputError(`${reportName}.repeats must be a positive number`);
  }
  if (!Array.isArray(report.results)) throw new InputError(`${reportName}.results must be an array`);

  report.results.forEach((result, resultIndex) => {
    const context = `${reportName}.results[${resultIndex}]`;
    if (!isObject(result) || !['local', 'cloud'].includes(result.arm)) {
      throw new InputError(`${context}.arm must be local or cloud`);
    }
    if (typeof result.fixture !== 'string' && typeof result.fixture !== 'number') {
      throw new InputError(`${context}.fixture must be an id`);
    }
    // `calls` arrived with the rule field; a legacy row has one model call per repeat by construction.
    if (result.calls === undefined && Array.isArray(result.ms)) result.calls = result.ms.map(() => 1);
    if (!Array.isArray(result.runs) || !Array.isArray(result.ms) || !Array.isArray(result.calls)) {
      throw new InputError(`${context} must contain runs, ms, and calls arrays`);
    }
    if (result.runs.length > result.ms.length) {
      throw new InputError(`${context}.runs cannot outnumber attempted runs in .ms`);
    }
    if (result.calls.length !== result.ms.length) {
      throw new InputError(`${context}.calls and .ms must describe the same attempted runs`);
    }
    result.runs.forEach((scores, runIndex) => assertScores(scores, `${context}.runs[${runIndex}]`));
    result.ms.forEach((value, attemptIndex) => {
      if (!Number.isFinite(value)) throw new InputError(`${context}.ms[${attemptIndex}] must be a number`);
    });
    result.calls.forEach((value, attemptIndex) => {
      if (value !== null && !Number.isFinite(value)) {
        throw new InputError(`${context}.calls[${attemptIndex}] must be a number or null`);
      }
    });
  });
}

function summarizeRepeat(report) {
  const local = report.results.filter((result) => result.arm === 'local');
  // A transport error or a timeout is the BOX failing, not the model breaking its JSON contract, so it
  // must not sit in this denominator — see the same reasoning in repeat-consistency.mjs localArm() and
  // screening-verdict.mjs. Reports written before 2026-09-04 have no `errors` array; those fall back to
  // the old count and are flagged, rather than being silently rated on a different basis.
  // ONLY a transport failure leaves the denominator. `Pis7ScoreError` stays in: pis7.js throws it for
  // invalid_json/invalid_scores after the re-ask budget is spent, i.e. the model failing its contract —
  // excluding it would switch this bar off. See the longer note in screening-verdict.mjs.
  const nonModel = (e) => e != null && /^transport\b/i.test(String(e));
  const legacyJson = local.some((result) => !Array.isArray(result.errors));
  const excludedNonModel = local.reduce(
    (sum, result) => sum + (Array.isArray(result.errors) ? result.errors.filter(nonModel).length : 0), 0);
  const parsed = local.reduce((sum, result) => sum + result.runs.length, 0);
  const attempted = local.reduce((sum, result) => sum + result.ms.length, 0) - excludedNonModel;
  const calls = local.flatMap((result) => result.calls).filter((value) => value !== null);
  const milliseconds = local.flatMap((result) => result.ms);
  // A fixture with FEWER THAN TWO parsed runs has a range of 0 on every domain — by construction, not
  // by measurement. Counting it as "no noise" pulls the median down in the flattering direction: on the
  // 2026-09-02 baseline it read median 3 against a true 6. Spread needs at least two observations.
  const measurable = local.filter((result) => result.runs.length >= 2);
  const fixtureStats = measurable.map((result) => {
    const domainRanges = Object.fromEntries(DOMAINS.map((domain) => [
      domain,
      range(result.runs.map((scores) => scores[domain])),
    ]));
    const compositeRange = range(result.runs.map((scores) =>
      DOMAINS.reduce((sum, domain) => sum + scores[domain], 0)));
    const domainValues = Object.values(domainRanges).filter((value) => value !== null);
    return {
      domain_ranges: domainRanges,
      noise_sum_abs_delta: domainValues.length === DOMAINS.length
        ? domainValues.reduce((sum, value) => sum + value, 0)
        : null,
      composite_range: compositeRange,
    };
  });
  const noiseValues = fixtureStats.map((item) => item.noise_sum_abs_delta).filter((value) => value !== null);
  const compositeRanges = fixtureStats.map((item) => item.composite_range).filter((value) => value !== null);
  const noiseMedian = percentile(noiseValues, 50);
  const jsonPercent = attempted ? (parsed / attempted) * 100 : null;
  const noisePass = noiseMedian !== null && noiseMedian <= 2;
  const jsonPass = jsonPercent !== null && jsonPercent >= 98;
  const label = `${report.consistency}${report.agree_sum ? `+sum≤${report.agree_sum}` : ''}`;

  return {
    label,
    consistency: report.consistency,
    agree_sum: report.agree_sum,
    fixtures: local.length,
    fixtures_with_spread: measurable.length,
    repeats: report.repeats,
    parsed_repeats: parsed,
    attempted_repeats: attempted,
    excluded_non_model: excludedNonModel,
    json_legacy: legacyJson,
    json_percent: jsonPercent,
    noise_sum_abs_delta: {
      median: noiseMedian,
      max: noiseValues.length ? Math.max(...noiseValues) : null,
      fixtures_at_most_2: noiseValues.filter((value) => value <= 2).length,
      fixtures_measured: noiseValues.length,
    },
    composite_range_median: percentile(compositeRanges, 50),
    mean_calls_per_repeat: mean(calls),
    mean_seconds_per_repeat: mean(milliseconds) === null ? null : mean(milliseconds) / 1000,
    domain_mean_ranges: Object.fromEntries(DOMAINS.map((domain) => [
      domain,
      mean(fixtureStats.map((item) => item.domain_ranges[domain]).filter((value) => value !== null)),
    ])),
    bars: {
      noise_median_at_most_2: noisePass,
      json_at_least_98_percent: jsonPass,
      pass: noisePass && jsonPass,
    },
  };
}

function validateAgreement(report, reportName) {
  if (!isObject(report)) throw new InputError(`${reportName} must contain a JSON object`);
  splitName(report, reportName);
  if (!Array.isArray(report.rows)) throw new InputError(`${reportName}.rows must be an array`);
  report.rows.forEach((row, rowIndex) => {
    const context = `${reportName}.rows[${rowIndex}]`;
    if (!isObject(row)) throw new InputError(`${context} must be an object`);
    if (typeof row.id !== 'string' && typeof row.id !== 'number') throw new InputError(`${context}.id must be an id`);
    for (const arm of ['local', 'cloud']) {
      if (row[arm] !== null) assertScores(row[arm], `${context}.${arm}`);
    }
    if (!Number.isFinite(row.localMs) || !Number.isFinite(row.cloudMs)) {
      throw new InputError(`${context}.localMs and .cloudMs must be numbers`);
    }
    if (row.consistency !== null) {
      if (!isObject(row.consistency)) throw new InputError(`${context}.consistency must be an object or null`);
      if (row.consistency.calls !== null && !Number.isFinite(row.consistency.calls)) {
        throw new InputError(`${context}.consistency.calls must be a number or null`);
      }
    }
  });
}

// --- ICC(A,1): two-way mixed, absolute agreement, single measure -------------------------------
// The statistic CREC082 §8.2 names for AI-vs-reference. Two raters here (the two models), n targets.
// Written out rather than pulled from a library so the formula is auditable next to the number.
function iccA1(pairs) {
  const n = pairs.length; if (n < 2) return null;
  const k = 2;
  const grand = pairs.flat().reduce((a, b) => a + b, 0) / (n * k);
  const rowMeans = pairs.map((p) => (p[0] + p[1]) / 2);
  const colMeans = [0, 1].map((j) => pairs.reduce((a, p) => a + p[j], 0) / n);
  const MSR = (k * rowMeans.reduce((a, m) => a + (m - grand) ** 2, 0)) / (n - 1);
  const MSC = (n * colMeans.reduce((a, m) => a + (m - grand) ** 2, 0)) / (k - 1);
  let sse = 0;
  pairs.forEach((p, i) => p.forEach((v, j) => { sse += (v - rowMeans[i] - colMeans[j] + grand) ** 2; }));
  const MSE = sse / ((n - 1) * (k - 1));
  const denom = MSR + (k - 1) * MSE + (k * (MSC - MSE)) / n;
  return denom === 0 ? null : (MSR - MSE) / denom;
}

function summarizeAgreement(report, bestRepeatNoiseMedian) {
  const paired = report.rows.filter((row) => row.local !== null && row.cloud !== null);
  const domains = Object.fromEntries(DOMAINS.map((domain) => {
    const deltas = paired.map((row) => row.local[domain] - row.cloud[domain]);
    return [domain, { mean_delta: mean(deltas), mean_abs_delta: mean(deltas.map(Math.abs)) }];
  }));
  const compositePairs = paired.map((row) => [
    DOMAINS.reduce((sum, domain) => sum + row.local[domain], 0),
    DOMAINS.reduce((sum, domain) => sum + row.cloud[domain], 0),
  ]);
  const compositeDeltas = compositePairs.map(([local, cloud]) => local - cloud);
  const sumAbsDeltas = paired.map((row) => DOMAINS.reduce(
    (sum, domain) => sum + Math.abs(row.local[domain] - row.cloud[domain]), 0));
  const calls = paired.map((row) => row.consistency?.calls ?? null);
  const agreementMedian = percentile(sumAbsDeltas, 50);

  return {
    rows: report.rows.length,
    paired_rows: paired.length,
    domains,
    composite: {
      icc_a1: iccA1(compositePairs),
      bias_local_minus_cloud: mean(compositeDeltas),
    },
    sum_abs_delta_median: agreementMedian,
    unparseable: {
      local: report.rows.filter((row) => row.local === null).length,
      cloud: report.rows.filter((row) => row.cloud === null).length,
    },
    consistency_calls: {
      2: calls.filter((value) => value === 2).length,
      3: calls.filter((value) => value === 3).length,
    },
    repeat_noise_comparison: {
      best_repeat_noise_median: bestRepeatNoiseMedian,
      agreement_at_or_below_noise_floor: agreementMedian !== null
        && bestRepeatNoiseMedian !== null
        && agreementMedian <= bestRepeatNoiseMedian,
    },
  };
}

function printHuman(report) {
  hr('E2 self-consistency variants');
  console.log(`  split  ${report.split === null ? dim('(none)') : report.split}\n`);
  table(
    ['variant', 'fixtures', 'repeats', 'JSON%', 'noise Σ|Δ| med', 'noise Σ|Δ| max', 'noise ≤2', 'comp range med', 'calls/repeat', 'sec/repeat', 'bar'],
    report.repeats.map((item) => [
      // A legacy row's JSON% is computed on a different basis from a fresh one's; putting them in one
      // table unmarked let a bad afternoon on the box read FAIL beside a PASS decided another way.
      item.json_legacy ? `${item.label} ${yellow('[legacy]')}` : item.label,
      String(item.fixtures),
      String(item.repeats),
      fmt(item.json_percent, 1),
      fmt(item.noise_sum_abs_delta.median, 0),
      fmt(item.noise_sum_abs_delta.max, 0),
      `${item.noise_sum_abs_delta.fixtures_at_most_2}/${item.noise_sum_abs_delta.fixtures_measured}`,
      fmt(item.composite_range_median, 0),
      fmt(item.mean_calls_per_repeat, 2),
      fmt(item.mean_seconds_per_repeat, 2),
      item.bars.pass ? green('PASS') : red('FAIL'),
    ]),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
  );

  hr('per-domain mean range across fixtures');
  table(
    ['domain', ...report.repeats.map((item) => item.label)],
    DOMAINS.map((domain) => [domain, ...report.repeats.map((item) => fmt(item.domain_mean_ranges[domain], 2))]),
    ['l', ...report.repeats.map(() => 'r')],
  );

  if (report.agreement) {
    hr('local vs cloud — paired parsed rows');
    table(
      ['domain', 'mean Δ', 'mean |Δ|'],
      DOMAINS.map((domain) => [
        domain,
        fmt(report.agreement.domains[domain].mean_delta, 2),
        fmt(report.agreement.domains[domain].mean_abs_delta, 2),
      ]),
      ['l', 'r', 'r'],
    );
    console.log('');
    table(
      ['metric', 'value'],
      [
        ['paired rows', `${report.agreement.paired_rows}/${report.agreement.rows}`],
        ['ICC(A,1), unweighted composite', fmt(report.agreement.composite.icc_a1, 3)],
        ['composite bias (local − cloud)', fmt(report.agreement.composite.bias_local_minus_cloud, 2)],
        ['Σ|Δ| median, local vs cloud', fmt(report.agreement.sum_abs_delta_median, 0)],
        ['local-unparseable rows', String(report.agreement.unparseable.local)],
        ['cloud-unparseable rows', String(report.agreement.unparseable.cloud)],
        ['consistency.calls = 2', String(report.agreement.consistency_calls[2])],
        ['consistency.calls = 3', String(report.agreement.consistency_calls[3])],
      ],
      ['l', 'r'],
    );
    const agreementMedian = report.agreement.sum_abs_delta_median;
    const bestNoise = report.agreement.repeat_noise_comparison.best_repeat_noise_median;
    const comparison = `Agreement Σ|Δ| median ${fmt(agreementMedian, 0)} vs best repeat-noise median ${fmt(bestNoise, 0)}: an agreement Σ|Δ| at or below the noise floor carries no signal about the two models differing.`;
    console.log(`\n  ${report.agreement.repeat_noise_comparison.agreement_at_or_below_noise_floor ? yellow(comparison) : dim(comparison)}`);
  }

  hr('how to read this');
  console.log(`  ${dim('JSON% is parsed ÷ attempted local-arm repeats, excluding ONLY transport failures')}`);
  console.log(`  ${dim('(a reply the model could not make valid is always counted); the bar is ≥ 98%.')}`);
  console.log(`  ${dim('Rows marked [legacy] predate error kinds — their JSON% still charges transport to the model.')}`);
  console.log(`  ${dim('Noise Σ|Δ| sums each fixture’s seven within-model score ranges; its median bar is ≤ 2.')}`);
  console.log(`  ${dim('PASS requires both bars. Composite range is the range of the unweighted d1..d7 sum.')}`);
  if (report.agreement) {
    console.log(`  ${dim('Agreement and call counts use paired parsed rows; unparseable counts use all rows.')}`);
  }
  console.log('');
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const repeatEntries = [];
  for (let i = 0; i < options.repeats.length; i++) {
    const name = `repeat report ${JSON.stringify(options.repeats[i])}`;
    const data = await readReport(options.repeats[i], 'repeat');
    validateRepeat(data, name);
    repeatEntries.push({ name, data, split: splitName(data, name) });
  }

  let agreementEntry = null;
  if (options.agreement !== null) {
    const name = `agreement report ${JSON.stringify(options.agreement)}`;
    const data = await readReport(options.agreement, 'agreement');
    validateAgreement(data, name);
    agreementEntry = { name, data, split: splitName(data, name) };
  }

  const entries = agreementEntry ? [...repeatEntries, agreementEntry] : repeatEntries;
  const expected = entries[0];
  for (const entry of entries.slice(1)) {
    if (entry.split !== expected.split) {
      throw new InputError(`split.name mismatch: ${entry.name} has ${JSON.stringify(splitLabel(entry.split))}; ${expected.name} has ${JSON.stringify(splitLabel(expected.split))}`);
    }
  }
  if (expected.split === 'heldout' && !options.allowHeldout) {
    throw new InputError('the held-out split is reserved for the single gate run (D13); pass --allow-heldout to compare it explicitly');
  }

  const repeats = repeatEntries.map((entry) => summarizeRepeat(entry.data));
  const noiseMedians = repeats.map((item) => item.noise_sum_abs_delta.median).filter((value) => value !== null);
  const bestRepeatNoiseMedian = noiseMedians.length ? Math.min(...noiseMedians) : null;
  const report = {
    split: expected.split,
    repeats,
    agreement: agreementEntry ? summarizeAgreement(agreementEntry.data, bestRepeatNoiseMedian) : null,
  };

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
}

await main().catch((error) => {
  if (error instanceof InputError) fail(error.message);
  fail(`could not compare reports: ${error.message}`);
});
