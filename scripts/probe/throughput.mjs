#!/usr/bin/env node
// throughput.mjs — sizing, NOT a gate.
//
// Gate 0 asks "can this model do the job at all". This script asks the next question: "how many
// physicians can be on it at once", so LOCAL_MAX_CONCURRENCY (read by getRunner() in createLocalProvider,
// rimpl/src/services/providers/local-factory.js) comes from a measurement instead of a guess.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// "Concurrency is not a problem" is a statement about QUOTA — nobody is going to bill or rate-limit
// you on your own hardware. It is not a statement about CAPACITY. A dedicated GPU is still bounded
// by VRAM (weights + KV cache per active sequence) and by the server's batch scheduler. Past the
// point where the KV cache is full, a serving stack does one of two things, and both look fine
// right up until they do not:
//   * vLLM / SGLang QUEUE the excess — total tokens/sec stays flat while per-request latency climbs
//     linearly. Nobody errors; everyone just waits. rimpl's 85s LOCAL_AI_TIMEOUT_MS then starts
//     firing, and the backend's 100s RIMPL_EVAL_TIMEOUT_MS behind it.
//   * Some stacks PREEMPT or evict sequences, so long generations restart and burn the GPU twice.
// The number you want is the concurrency at which aggregate tokens/sec stops rising. Set
// LOCAL_MAX_CONCURRENCY at or below that: rimpl's queue is a far better place to wait than the
// GPU's, because rimpl's queue is FIFO, observable, and bounded by a timeout you control.
//
// Usage:
//   LOCAL_AI_BASE_URL=… LOCAL_AI_MODEL=… node scripts/probe/throughput.mjs
//     --levels 1,2,4,8,16,32   concurrency levels (default)
//     --reqs <n>               requests per level (default: 3× the level, min 6)
//     --max-tokens <n>         default 512 — a fixed, deterministic generation length
//     --prompt <text>          override the fixed prompt
//     --no-warmup              skip the discarded warm-up request
//     --out <file>             write a JSON report

import {
  readConfig, printTarget, chatCompletion, hr, table, parseArgs, writeReport, fail,
  bold, dim, green, red, yellow, percentile, mean, ms, progress, progressDone,
} from './lib.mjs';

const { flags } = parseArgs();
const cfg = readConfig({ needModel: true });

const levels = String(flags.levels && flags.levels !== true ? flags.levels : '1,2,4,8,16,32')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
if (!levels.length) fail('--levels must be a comma-separated list of positive integers, e.g. 1,2,4,8');

const maxTokens = Math.max(64, Number(flags['max-tokens']) || 512);
const reqsOverride = Number(flags.reqs) || 0;
const warmup = !flags['no-warmup'];

// A fixed prompt, deliberately. Throughput must be measured at a constant workload: varying the
// prompt varies prefill cost and generation length, and then the numbers are not comparable across
// levels. English + a length instruction keeps generation close to `maxTokens` on every request.
const PROMPT = flags.prompt && flags.prompt !== true
  ? String(flags.prompt)
  : 'Explain, in about 300 words, how to interpret an elevated high-sensitivity troponin in a patient presenting with chest pain. Be specific and complete.';

printTarget(cfg, {
  levels: levels.join(', '),
  max_tokens: String(maxTokens),
  prompt: `fixed, ${PROMPT.length} chars`,
});

hr('read this before trusting any number below');
console.log(`  ${yellow('“Concurrency is not a problem” is an assurance about QUOTA, not a measured ceiling.')}`);
console.log(`  ${dim('A dedicated GPU is still bounded by VRAM (weights + KV cache per active sequence)')}`);
console.log(`  ${dim('and by the batch scheduler. Past saturation most servers QUEUE rather than error:')}`);
console.log(`  ${dim('aggregate tokens/sec goes flat while p95 latency climbs linearly, and nothing')}`);
console.log(`  ${dim('fails until rimpl\'s 85s timeout fires. That knee is the number this script exists')}`);
console.log(`  ${dim('to find. Everything above it is queueing, not capacity.')}`);
console.log(`\n  ${dim('Also bounding these numbers, and NOT the GPU:')}`);
console.log(`  ${dim('  · this client and its socket pool;')}`);
console.log(`  ${dim('  · the tailnet path — WireGuard over a laptop\'s wifi is not the production path.')}`);
console.log(`  ${dim('    Run this from a machine on the same footing rimpl will have, or the ceiling')}`);
console.log(`  ${dim('    you measure is your own network\'s.')}`);
console.log(`  ${dim('  · whether anyone else is using the box right now — ask before you start.')}`);
console.log(`  ${dim('If p50 latency rises from the very first level, suspect the path, not the GPU.')}`);

/* ------------------------------------------------------------------ warmup */

if (warmup) {
  console.log(`\n  ${dim('warm-up request (discarded — first call pays model load / cache priming)…')}`);
  const w = await chatCompletion(cfg, { messages: [{ role: 'user', content: PROMPT }], maxTokens: 64 });
  if (!w.ok) {
    fail(`the warm-up request failed, so there is nothing to measure:\n  ${w.error}\n\n` +
      'Run discover.mjs first — this is almost always a wrong base URL, a wrong model id, or a\n' +
      'tailnet ACL that permits the UI port but not the inference port.', 1);
  }
  console.log(`  ${dim(`warm-up ok (${Math.round(w.ms)}ms) — measuring.`)}`);
}

/* -------------------------------------------------------------------- run */

async function runLevel(concurrency) {
  const total = reqsOverride || Math.max(6, concurrency * 3);
  const samples = [];
  let cursor = 0;
  const t0 = performance.now();

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    // Each worker pulls the next request the instant it finishes, so `concurrency` requests really
    // are in flight for the whole window — a fixed batch of N would drain toward the end and
    // under-report both latency and load.
    while (cursor < total) {
      cursor++;
      const r = await chatCompletion(cfg, { messages: [{ role: 'user', content: PROMPT }], maxTokens });
      samples.push(r);
    }
  }));

  const wallMs = performance.now() - t0;
  const ok = samples.filter((s) => s.ok);
  const outTokens = ok.reduce((a, s) => a + (s.completionTokens || 0), 0);
  const lat = ok.map((s) => s.ms);
  return {
    concurrency, total,
    ok: ok.length,
    failed: samples.length - ok.length,
    errors: [...new Set(samples.filter((s) => !s.ok).map((s) => String(s.error).slice(0, 80)))],
    wallMs,
    p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.length ? Math.max(...lat) : null,
    outTokens,
    // Aggregate: total generated tokens ÷ wall-clock for the whole level. This is the throughput
    // number that matters — per-request tok/s always falls as concurrency rises even while the box
    // is doing strictly more work.
    aggTps: wallMs > 0 ? outTokens / (wallMs / 1000) : 0,
    perReqTps: ok.length ? mean(ok.filter((s) => s.ms > 0 && s.completionTokens > 0).map((s) => s.completionTokens / (s.ms / 1000))) : null,
  };
}

hr('ramp');
const rows = [];
for (const level of levels) {
  progress(`concurrency ${level}…`);
  const r = await runLevel(level);
  rows.push(r);
  const flag = r.failed > r.total / 2 ? red(' MOSTLY FAILING') : r.failed ? yellow(` ${r.failed} failed`) : '';
  console.log(`  concurrency ${String(level).padStart(2)}  ` +
    `n=${String(r.total).padStart(3)}  p50 ${String(Math.round(r.p50 ?? 0)).padStart(6)}ms  ` +
    `p95 ${String(Math.round(r.p95 ?? 0)).padStart(6)}ms  ` +
    `agg ${r.aggTps.toFixed(1).padStart(7)} tok/s${flag}`);
  if (r.failed > r.total / 2) {
    console.log(`  ${red('stopping the ramp:')} ${dim('most requests at this level failed — ' + (r.errors[0] || ''))}`);
    console.log(`  ${dim('Higher levels would measure the failure mode, not capacity.')}`);
    break;
  }
}
progressDone();

/* ----------------------------------------------------------------- report */

hr('results');
table(
  ['conc', 'reqs', 'ok', 'fail', 'p50', 'p95', 'max', 'agg tok/s', 'per-req tok/s'],
  rows.map((r) => [
    r.concurrency, r.total, r.ok, r.failed ? red(String(r.failed)) : '0',
    ms(r.p50), ms(r.p95), ms(r.max),
    r.aggTps.toFixed(1),
    r.perReqTps == null ? '—' : r.perReqTps.toFixed(1),
  ]),
  ['r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
);
console.log(`  ${dim('agg tok/s     = all generated tokens ÷ wall-clock for the level. THIS is capacity.')}`);
console.log(`  ${dim('per-req tok/s = mean single-stream speed. It always falls as concurrency rises;')}`);
console.log(`  ${dim('                that fall is normal batching, not a problem, until agg goes flat.')}`);
const smallest = Math.min(...rows.map((r) => r.total));
if (smallest < 20) {
  console.log(`\n  ${yellow(`⚠ p95 at n=${smallest} is one or two samples.`)} ${dim('Treat it as a hint. Re-run with')}`);
  console.log(`  ${dim('--reqs 30 or more before putting any of these numbers in a capacity plan.')}`);
}

/* ------------------------------------------------------------- the knee */

hr('where does it saturate?');
let knee = null;
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1];
  const cur = rows[i];
  // Doubling concurrency should raise aggregate throughput materially. Under +15% means the extra
  // requests are queueing, not being served.
  const gain = prev.aggTps > 0 ? (cur.aggTps - prev.aggTps) / prev.aggTps : 1;
  const marker = gain < 0.15 ? red('◀ flat') : gain < 0.5 ? yellow('· slowing') : green('· scaling');
  const signed = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`;
  const p95Delta = prev.p95 ? signed((cur.p95 - prev.p95) / prev.p95) : '—';
  console.log(`  ${String(prev.concurrency).padStart(2)} → ${String(cur.concurrency).padStart(2)}   ` +
    `agg ${signed(gain).padStart(6)}   p95 ${String(p95Delta).padStart(6)}   ${marker}`);
  if (knee === null && gain < 0.15) knee = prev.concurrency;
}
if (rows.length < 2) {
  console.log(`  ${dim('only one level ran — nothing to compare.')}`);
} else if (knee === null) {
  console.log(`\n  ${green('throughput was still climbing at the top level.')} ${dim(`The real ceiling is above ${rows[rows.length - 1].concurrency};`)}`);
  console.log(`  ${dim('re-run with a higher --levels to find it before sizing LOCAL_MAX_CONCURRENCY.')}`);
} else {
  console.log(`\n  ${bold('saturation knee ≈ concurrency ' + knee)} ${dim('(aggregate throughput stopped rising past here)')}`);
}

hr('what to put in rimpl');
const suggested = knee ?? (rows.length ? rows[rows.length - 1].concurrency : null);
console.log(`  LOCAL_MAX_CONCURRENCY=${suggested ?? '<measure first>'}`);
console.log(`  ${dim('rimpl defaults this to 2 (getRunner() in rimpl/src/services/providers/local-factory.js, from the')}`);
console.log(`  ${dim('DGX measurement: two concurrent PIS-7 evaluations already push p95 to 114 s). Set it at or below')}`);
console.log(`  ${dim('the knee so the excess waits in rimpl\'s two-lane queue (visible in /health/deep queues, and')}`);
console.log(`  ${dim('bounded: beyond LOCAL_MAX_QUEUE_* it is refused with 503 queue_full) rather than invisibly')}`);
console.log(`  ${dim('inside the GPU scheduler.')}`);
const worstP95 = rows.length ? Math.max(...rows.filter((r) => r.concurrency <= (suggested ?? Infinity)).map((r) => r.p95 ?? 0)) : 0;
if (worstP95 > 85000) {
  console.log(`\n  ${red(`⚠ p95 at that level is ${Math.round(worstP95 / 1000)}s, past rimpl's 85s LOCAL_AI_TIMEOUT_MS.`)}`);
  console.log(`  ${dim('Requests would time out before finishing. Lower the concurrency, or raise both')}`);
  console.log(`  ${dim('LOCAL_AI_TIMEOUT_MS and the backend\'s RIMPL_EVAL_TIMEOUT_MS (100s) together —')}`);
  console.log(`  ${dim('raising only one makes the outer timeout fire first and hides the cause.')}`);
} else if (worstP95 > 60000) {
  console.log(`\n  ${yellow(`⚠ p95 is ${Math.round(worstP95 / 1000)}s — inside the 85s timeout, but not by much.`)}`);
}
console.log(`\n  ${dim(`Note: this measured a short prompt with a ${maxTokens}-token output ceiling. PIS-7 scoring`)}`);
console.log(`  ${dim('sends a WHOLE transcript (prefill-heavy — tens of thousands of input tokens) and')}`);
console.log(`  ${dim('allows 4096 output tokens, so its per-request cost is much larger and its')}`);
console.log(`  ${dim('concurrency ceiling correspondingly lower: KV cache is consumed per token held,')}`);
console.log(`  ${dim('not per request. Size for the mix you expect at clinic-hours peak, not this prompt.')}`);

await writeReport(flags.out, {
  probe: 'throughput', at: new Date().toISOString(),
  target: { baseUrl: cfg.baseUrl, model: cfg.model },
  config: { levels, maxTokens, reqsPerLevel: reqsOverride || 'auto (3× level, min 6)', promptChars: PROMPT.length, warmup },
  levels: rows.map((r) => ({
    concurrency: r.concurrency, requests: r.total, ok: r.ok, failed: r.failed, errors: r.errors,
    wallMs: Math.round(r.wallMs), p50Ms: r.p50, p95Ms: r.p95, maxMs: r.max,
    outputTokens: r.outTokens, aggregateTokensPerSec: r.aggTps, perRequestTokensPerSec: r.perReqTps,
  })),
  saturationKnee: knee,
  suggestedLocalMaxConcurrency: suggested,
  caveat: 'Bounded by the client, the tailnet path and other users of the box as well as by the GPU. Not a quota measurement.',
});

process.exit(0);
