#!/usr/bin/env node
/*
 * Rehearsal gate for booth scoring: reads the `[booth] score ...` lines scorePlay logs (backend/src/services/booth.js)
 * and says whether prod scored every play from its case's path score table (ADR 0009) inside the 60 s cap.
 *
 *   railway logs --service backend --since 2h --filter '"[booth] score"' | node scripts/booth/score-latency.mjs
 *   node scripts/booth/score-latency.mjs backend.log [--min 5]
 *
 * Counts distinct plays, not lines. PASS needs at least --min scored plays (default 5), no unavailable play, p95
 * under 60 s and every scored play on provider table. Exit 0 on PASS, 1 on FAIL, 2 on a bad argument.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P95_LIMIT_MS = 60_000;
// Matched anywhere in the line: Railway prefixes its own timestamp and level.
const SCORED = /\[booth\] score scored play=(\S+) ms=(\d+) provider=(\S+)/;
const REPLAY = 'replay';
const UNAVAILABLE = /\[booth\] score unavailable play=(\S+) ms=(\d+) reason=(\S+)/;

/** @returns {{ scored: { play: string, ms: number, provider: string }[], unavailable: { play: string, ms: number, reason: string }[] }} */
export function parseLog(text) {
  const scored = [];
  const unavailable = [];
  for (const line of text.split(/\r?\n/)) {
    const s = SCORED.exec(line);
    if (s) { scored.push({ play: s[1], ms: Number(s[2]), provider: s[3] }); continue; }
    const u = UNAVAILABLE.exec(line);
    if (u) unavailable.push({ play: u[1], ms: Number(u[2]), reason: u[3] });
  }
  return { scored, unavailable };
}

/** Nearest-rank percentile of an ascending list; null for an empty one. */
export function nearestRank(sorted, p) {
  return sorted.length ? sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1] : null;
}

/**
 * Per distinct play: a replayed /score answers again from the stored row and logs again, so a play counts once, with
 * the ms and provider of its first live scored line (a replay logs provider=replay and carries neither). A play with
 * any unavailable line counts as unavailable, even if it also scored.
 */
function plays({ scored, unavailable }) {
  const missed = new Set(unavailable.map((u) => u.play));
  const first = new Map();
  for (const s of scored) {
    if (s.provider !== REPLAY && !missed.has(s.play) && !first.has(s.play)) first.set(s.play, s);
  }
  return { scored: [...first.values()], unavailable: missed.size };
}

export function summarize(log, { min = 5 } = {}) {
  const { scored, unavailable } = plays(log);
  const ms = scored.map((s) => s.ms).sort((a, b) => a - b);
  const providers = {};
  for (const s of scored) providers[s.provider] = (providers[s.provider] ?? 0) + 1;
  const p95 = nearestRank(ms, 95);
  const failures = [
    ms.length < min && `only ${ms.length} scored plays, need ${min}`,
    unavailable > 0 && `${unavailable} unavailable`,
    p95 != null && p95 >= P95_LIMIT_MS && `p95 ${(p95 / 1000).toFixed(1)} s is not under 60 s`,
    scored.some((s) => s.provider !== 'table') && 'a scored play was not read from a path score table',
  ].filter(Boolean);
  return {
    n: ms.length,
    unavailable,
    p50_s: seconds(nearestRank(ms, 50)),
    p95_s: seconds(p95),
    max_s: seconds(ms.at(-1) ?? null),
    providers,
    pass: failures.length === 0,
    failures,
  };
}

const seconds = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);

export function report(s) {
  const fmt = (x) => (x == null ? '-' : `${x.toFixed(1)} s`);
  const providers = Object.entries(s.providers).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
  return [
    `scored n=${s.n}  unavailable=${s.unavailable}`,
    `p50 ${fmt(s.p50_s)}  p95 ${fmt(s.p95_s)}  max ${fmt(s.max_s)}`,
    `providers ${providers}`,
    s.pass ? 'PASS' : `FAIL: ${s.failures.join('; ')}`,
  ].join('\n');
}

function parseArgs(argv) {
  let min = 5;
  let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--min') {
      min = Number(argv[++i]);
      if (!Number.isInteger(min) || min < 1) throw new Error('--min needs a whole number of at least 1');
    } else if (!file && !argv[i].startsWith('--')) file = argv[i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { min, file };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: node scripts/booth/score-latency.mjs [log-file] [--min 5]   (or pipe the log on stdin)`);
    process.exit(2);
  }
  const summary = summarize(parseLog(readFileSync(args.file ?? 0, 'utf8')), { min: args.min });
  console.log(report(summary));
  process.exit(summary.pass ? 0 : 1);
}
