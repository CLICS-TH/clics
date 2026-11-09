// The path score table build's spend ledger (#373): every build's spend, keyed by its cases' event code, in one file at
// a path no flag moves, so every run of a build counts against one cap. A call is reserved at its worst case before it
// starts and settled when it returns, so a run that dies mid-call leaves its worst case charged. Lines are only ever
// appended. Package-free, like the other booth scripts.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const LEDGER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'path-table-runs', 'spend.jsonl');

const r6 = (x) => Math.round(x * 1e6) / 1e6;

function lines() {
  let text;
  try { text = readFileSync(LEDGER, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** What a build has spent: each charge, and each reservation at its settled cost or, never settled, its worst case. */
export function spentOn(build) {
  const own = lines().filter((l) => l.build === build);
  const settled = new Map(own.filter((l) => l.kind === 'settle').map((l) => [l.id, l.usd]));
  return r6(own.reduce((acc, l) => acc + (l.kind === 'charge' ? l.usd : l.kind === 'reserve' ? (settled.get(l.id) ?? l.usd) : 0), 0));
}

/** Reserves a call's worst case before it starts; returns the settle for when it ends. */
export function reserve(build, runId, usd) {
  const id = randomUUID();
  appendFileSync(LEDGER, `${JSON.stringify({ build, run_id: runId, kind: 'reserve', id, usd: r6(usd), at: new Date().toISOString() })}\n`);
  return (cost) => appendFileSync(LEDGER, `${JSON.stringify({ build, run_id: runId, kind: 'settle', id, usd: r6(cost) })}\n`);
}
