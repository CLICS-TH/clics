#!/usr/bin/env node
// The path score table build's spend ledger (#373, #408): one per machine, at ~/.clics/booth-spend/ledger.jsonl,
// outside every checkout, so no folder copy, edited event code, --case pick, second checkout or git checkout gives a
// build a fresh cap. It is one total over every path-table build on the machine.
//
// An append-only event log, one JSON object per line: an `init` first, then `charge` (a run's spend, as the committed
// record holds it), `reserve` (a call's worst case, taken before it starts) and `settle` (that call's cost, once it
// returns). Spend is the fold: every charge, and every reservation at its settled cost or, never settled, its worst
// case, so a run killed mid-call stays charged its worst case. A reservation re-reads the whole ledger under an
// exclusive lock and is refused when it would take the spend past the cap, so concurrent runs share one total.
//
// A ledger comes into being only through `node scripts/booth/spend-ledger.mjs init`, seeded from the committed record
// (scripts/booth/path-table-runs/spend.jsonl). A missing or empty ledger, or one that does not parse line by line,
// refuses the run: it cannot prove the spend so far. Package-free, like the other booth scripts.
import { appendFileSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECORD = path.join(HERE, 'path-table-runs', 'spend.jsonl');
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;

export function ledgerPath() {
  // An empty HOME would put the ledger under the working directory, one per checkout again.
  const home = os.homedir();
  if (!path.isAbsolute(home)) throw new Error(`the spend ledger needs an absolute home directory, not "${home}"`);
  return path.join(home, '.clics', 'booth-spend', 'ledger.jsonl');
}
const lockPath = () => path.join(path.dirname(ledgerPath()), 'ledger.lock');

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const text = (v) => typeof v === 'string' && v.length > 0;
const usd = (v) => Number.isFinite(v) && v >= 0;
const SHAPES = Object.freeze({
  init: (l) => text(l.at),
  charge: (l) => text(l.run_id) && usd(l.usd),
  reserve: (l) => text(l.id) && text(l.run_id) && usd(l.usd),
  settle: (l) => text(l.id) && usd(l.usd),
});

const refuse = (why) => { throw new Error(`the spend ledger ${ledgerPath()} ${why}`); };
const missing = () => refuse('does not exist, so the spend so far cannot be proven: create it once per machine with '
  + 'node scripts/booth/spend-ledger.mjs init');

/** The ledger's events, line by line. A line that is not one of the four kinds, an `init` that is not line 1 alone,
 *  or a settle of no open reservation refuses it. */
function parse(raw) {
  const lines = raw.split('\n');
  if (lines.pop() !== '') refuse('does not end in a newline: its last line may be torn');
  if (!lines.length) refuse('is empty: it has no init line, so the spend so far cannot be proven');
  const reserved = new Set();
  const settled = new Set();
  return lines.map((line, i) => {
    let l;
    try { l = JSON.parse(line); } catch { refuse(`line ${i + 1} is not JSON`); }
    if (!SHAPES[l?.kind]?.(l)) refuse(`line ${i + 1} is not an init, charge, reserve or settle line`);
    if ((l.kind === 'init') !== (i === 0)) refuse(i === 0 ? 'does not start with an init line' : `line ${i + 1} is a second init`);
    if (l.kind === 'reserve') reserved.add(l.id);
    if (l.kind === 'settle') {
      if (!reserved.has(l.id) || settled.has(l.id)) refuse(`line ${i + 1} settles no open reservation`);
      settled.add(l.id);
    }
    return l;
  });
}

function readRaw() {
  try { return readFileSync(ledgerPath(), 'utf8'); } catch (err) { if (err.code === 'ENOENT') missing(); throw err; }
}
const read = () => parse(readRaw());

/** Spend over `events`, or over one run's when `runId` is given. */
function fold(events, runId) {
  const own = runId ? events.filter((l) => l.run_id === runId || l.kind === 'settle') : events;
  const settled = new Map(own.filter((l) => l.kind === 'settle').map((l) => [l.id, l.usd]));
  return r6(own.reduce((acc, l) => acc + (l.kind === 'charge' ? l.usd : l.kind === 'reserve' ? (settled.get(l.id) ?? l.usd) : 0), 0));
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

/** Runs `fn` holding the ledger's lock file. A lock is never taken over: one left by a dead process stays until the
 *  operator deletes it, since nothing here can prove that process is not mid-append. */
function locked(fn) {
  const lock = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  for (;;) {
    try { fd = openSync(lock, 'wx'); break; } catch (err) {
      if (err.code === 'ENOENT') missing();
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        let pid = null;
        try { pid = Number(readFileSync(lock, 'utf8')) || null; } catch { /* gone or unreadable: named below as unknown */ }
        const holder = pid ? `process ${pid}, ${alive(pid) ? 'still running' : 'no longer running'}` : 'an unknown process';
        throw new Error(`the spend ledger's lock ${lock} has been held for ${LOCK_WAIT_MS / 1000} s by ${holder}. `
          + 'Delete it only once no table build is running.');
      }
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    return fn();
  } finally {
    unlinkSync(lock);
  }
}

/** Every path-table build's spend on this machine, or one run's. */
export const spent = (runId) => fold(read(), runId);

/** Reserves a call's worst case `usd` when the spend so far plus it stays within `cap`. Returns the reservation's id,
 *  or null when refused. */
export function reserve({ runId, build, usd: worst, cap }) {
  return locked(() => {
    if (fold(read()) + worst > cap) return null;
    const id = randomUUID();
    appendFileSync(ledgerPath(), `${JSON.stringify({ kind: 'reserve', id, run_id: runId, usd: r6(worst), at: new Date().toISOString(), build })}\n`);
    return id;
  });
}

/** Settles reservation `id` at the call's cost. */
export function settle(id, cost) {
  const line = `${JSON.stringify({ kind: 'settle', id, usd: r6(cost), at: new Date().toISOString() })}\n`;
  locked(() => {
    parse(readRaw() + line);
    appendFileSync(ledgerPath(), line);
  });
}

/** Creates this machine's ledger: an init line, then every charge in the committed record. Refuses one that exists. */
export function init(record = RECORD) {
  const charges = readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    let l;
    try { l = JSON.parse(line); } catch { throw new Error(`${record} line ${i + 1} is not JSON`); }
    if (l?.kind !== 'charge' || !SHAPES.charge(l)) throw new Error(`${record} line ${i + 1} is not a charge line`);
    return l;
  });
  const ledger = ledgerPath();
  mkdirSync(path.dirname(ledger), { recursive: true });
  const head = { kind: 'init', at: new Date().toISOString(), seeded_from: path.relative(path.join(HERE, '..', '..'), record) };
  // Written whole to a temp file and linked into place, so the ledger never exists half-written.
  const tmp = `${ledger}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx');
  try {
    try {
      writeSync(fd, [head, ...charges].map((l) => `${JSON.stringify(l)}\n`).join(''));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(tmp, ledger); } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`the spend ledger ${ledger} already exists: init runs once per machine`);
      throw err;
    }
  } finally { unlinkSync(tmp); }
  return fold([head, ...charges]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'init' || process.argv.length > 3) {
    console.error('usage: node scripts/booth/spend-ledger.mjs init');
    process.exit(2);
  }
  try {
    console.log(`Created ${ledgerPath()}: $${init().toFixed(2)} spent so far, from ${RECORD}.`);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
