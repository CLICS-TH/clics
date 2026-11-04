#!/usr/bin/env node
/*
 * Rehearsal gates for the booth's AI calls: reads the `[booth] score ...` lines scorePlay logs and the
 * `[booth] reply ...` lines replyToStep logs (backend/src/services/booth.js).
 *
 *   railway logs --service backend --since 2h --filter '"[booth]"' | node scripts/booth/score-latency.mjs
 *   node scripts/booth/score-latency.mjs backend.log [--min 5] [--min-replies 30]
 *
 * Score gate: counts distinct plays, not lines. PASS needs at least --min scored plays (default 5), no unavailable
 * play, p95 under 60 s and every scored play on provider anthropic.
 * Reply gate: counts distinct (play, step) replies, an empty one included (the visitor waited for it too). PASS needs
 * p95 under 15 s over at least --min-replies (default 30); fewer is TOO FEW. Empty and unavailable replies and the
 * providers are reported but do not fail it.
 * Exit 0 when both gates pass, 1 otherwise, 2 on a bad argument.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P95_LIMIT_MS = 60_000;
// Matched anywhere in the line: Railway prefixes its own timestamp and level.
const SCORED = /\[booth\] score scored play=(\S+) ms=(\d+) provider=(\S+)/;
const REPLAY = 'replay';
const UNAVAILABLE = /\[booth\] score unavailable play=(\S+) ms=(\d+) reason=(\S+)/;
const REPLY_P95_LIMIT_MS = 15_000;
const REPLY = /\[booth\] reply (replied|empty|unavailable) play=(\S+) step=(\S+) ms=(\d+)(?: provider=(\S+))?/;

/**
 * @typedef {{ kind: 'replied' | 'empty' | 'unavailable', play: string, step: string, ms: number, provider?: string }} Reply
 * @returns {{ scored: { play: string, ms: number, provider: string }[], unavailable: { play: string, ms: number, reason: string }[],
 *   replies: Reply[] }}
 */
export function parseLog(text) {
  const scored = [];
  const unavailable = [];
  const replies = [];
  for (const line of text.split(/\r?\n/)) {
    const s = SCORED.exec(line);
    if (s) { scored.push({ play: s[1], ms: Number(s[2]), provider: s[3] }); continue; }
    const u = UNAVAILABLE.exec(line);
    if (u) { unavailable.push({ play: u[1], ms: Number(u[2]), reason: u[3] }); continue; }
    const r = REPLY.exec(line);
    if (r) replies.push({ kind: r[1], play: r[2], step: r[3], ms: Number(r[4]), ...(r[5] ? { provider: r[5] } : {}) });
  }
  return { scored, unavailable, replies };
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
    scored.some((s) => s.provider !== 'anthropic') && 'a scored play did not run on anthropic',
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

/** One reply per (play, step), the first line kept: a log line saved twice must not count twice. */
export function summarizeReplies({ replies }, { min = 30 } = {}) {
  const first = new Map();
  for (const r of replies) if (!first.has(`${r.play} ${r.step}`)) first.set(`${r.play} ${r.step}`, r);
  const answered = [...first.values()].filter((r) => r.kind !== 'unavailable');
  const ms = answered.map((r) => r.ms).sort((a, b) => a - b);
  const providers = {};
  for (const r of answered) providers[r.provider] = (providers[r.provider] ?? 0) + 1;
  const p95 = nearestRank(ms, 95);
  let verdict = 'PASS';
  let failure = null;
  if (ms.length < min) [verdict, failure] = ['TOO FEW', `only ${ms.length} replies, need ${min}`];
  else if (p95 >= REPLY_P95_LIMIT_MS) [verdict, failure] = ['FAIL', `p95 ${(p95 / 1000).toFixed(1)} s is not under 15 s`];
  return {
    n: ms.length,
    empty: answered.filter((r) => r.kind === 'empty').length,
    unavailable: first.size - answered.length,
    p50_s: seconds(nearestRank(ms, 50)),
    p95_s: seconds(p95),
    max_s: seconds(ms.at(-1) ?? null),
    providers,
    verdict,
    failure,
  };
}

const fmt = (x) => (x == null ? '-' : `${x.toFixed(1)} s`);
const listed = (providers) => Object.entries(providers).map(([k, v]) => `${k}=${v}`).join(' ') || '-';

export function report(s, r) {
  return [
    `scored n=${s.n}  unavailable=${s.unavailable}`,
    `p50 ${fmt(s.p50_s)}  p95 ${fmt(s.p95_s)}  max ${fmt(s.max_s)}`,
    `providers ${listed(s.providers)}`,
    s.pass ? 'score PASS' : `score FAIL: ${s.failures.join('; ')}`,
    `replies n=${r.n}  empty=${r.empty}  unavailable=${r.unavailable}`,
    `reply p50 ${fmt(r.p50_s)}  p95 ${fmt(r.p95_s)}  max ${fmt(r.max_s)}`,
    `reply providers ${listed(r.providers)}`,
    r.failure ? `reply ${r.verdict}: ${r.failure}` : 'reply PASS',
    s.pass && r.verdict === 'PASS' ? 'PASS' : 'FAIL',
  ].join('\n');
}

function parseArgs(argv) {
  const mins = { '--min': 5, '--min-replies': 30 };
  let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] in mins) {
      const flag = argv[i];
      mins[flag] = Number(argv[++i]);
      if (!Number.isInteger(mins[flag]) || mins[flag] < 1) throw new Error(`${flag} needs a whole number of at least 1`);
    } else if (!file && !argv[i].startsWith('--')) file = argv[i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { min: mins['--min'], minReplies: mins['--min-replies'], file };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: node scripts/booth/score-latency.mjs [log-file] [--min 5] [--min-replies 30]   (or pipe the log on stdin)`);
    process.exit(2);
  }
  const log = parseLog(readFileSync(args.file ?? 0, 'utf8'));
  const score = summarize(log, { min: args.min });
  const reply = summarizeReplies(log, { min: args.minReplies });
  console.log(report(score, reply));
  process.exit(score.pass && reply.verdict === 'PASS' ? 0 : 1);
}
