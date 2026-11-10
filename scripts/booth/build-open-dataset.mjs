#!/usr/bin/env node
/*
 * Builds the open booth dataset of one booth event (#388, ADR 0010) as a local folder that the owner deposits on
 * Zenodo by hand under CC BY 4.0. It uploads nothing. The rules are in open-dataset.mjs.
 *
 * Without --go it prints its plan and reads no env and no database. With --go it refuses while the booth is switched
 * on, then reads production read-only. Run from the repo root:
 *   node scripts/booth/build-open-dataset.mjs --event NFCME-2026
 *   node --env-file=backend/.env --env-file=rimpl/.env scripts/booth/build-open-dataset.mjs --event NFCME-2026 --go
 *
 *   --version <n>     the dataset version (default 1)
 *   --out <dir>       default scripts/booth/open-dataset/<EVENT>-v<version>; the bundle is <out>/bundle
 *   --signoff <file>  default <out>/review/signoff.json, written only by a person
 *   --cap <usd>       the AI reads' spend cap (default 1); a play past it stays unread, so withheld
 *
 * Exit codes: 0 = built (or the dry run) · 1 = built nothing: a read failed, no plays, or a case version no commit
 * holds · 2 = bad arguments, misconfigured, or refused because the booth is switched on.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SAFE_EVENT_CODE } from './purge-summary.mjs';
import {
  READ_COLUMNS, sortedByRef, bangkokDate, hasTyped, freeText, textSha, scanPii, aiReadRequest, parseAiRead, flagged,
  signedKeys, transcriptState, playsCsv, transcriptsJsonl, flaggedReport, readme, dictionary,
} from './open-dataset.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const { costUsd } = require('../../backend/src/lib/pricing.js');
const { ANTHROPIC_MODEL } = require('../../rimpl/src/lib/provider-policy.js');

const USAGE = 'usage: node [--env-file=backend/.env --env-file=rimpl/.env] scripts/booth/build-open-dataset.mjs '
  + '--event <CODE> [--go] [--version <n>] [--out <dir>] [--signoff <file>] [--cap <usd>]   (run from the repo root)';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const PAGE = 1000;
const SAFE_CASE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/;
const BUNDLE_NAMES = new Set(['plays.csv', 'transcripts.jsonl', 'cases', 'README.md', 'DATA-DICTIONARY.md']);

function parseArgs(argv) {
  const opts = { event: null, go: false, version: 1, out: null, signoff: null, cap: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--go') { opts.go = true; continue; }
    if (!['--event', '--version', '--out', '--signoff', '--cap'].includes(flag)) return { error: `unknown argument ${flag}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${flag} needs a value` };
    i += 1;
    if (flag === '--event') opts.event = v;
    else if (flag === '--version') opts.version = /^[1-9][0-9]{0,5}$/.test(v) ? Number(v) : NaN;
    else if (flag === '--out') opts.out = path.resolve(v);
    else if (flag === '--signoff') opts.signoff = path.resolve(v);
    else opts.cap = /^[0-9]+(\.[0-9]+)?$/.test(v) ? Number(v) : NaN;
  }
  if (!opts.event) return { error: '--event is required' };
  if (!SAFE_EVENT_CODE.test(opts.event)) return { error: `--event ${JSON.stringify(opts.event)} is not an event code (A-Z, 0-9 and -, up to 32)` };
  if (Number.isNaN(opts.version)) return { error: '--version needs a whole number from 1' };
  if (Number.isNaN(opts.cap)) return { error: '--cap needs a number of US dollars, 0 or more' };
  opts.out ??= defaultOut(opts);
  opts.signoff ??= defaultSignoff(opts);
  return opts;
}

const defaultOut = ({ event, version }) => path.join(HERE, 'open-dataset', `${event}-v${version}`);
const defaultSignoff = ({ out }) => path.join(out, 'review', 'signoff.json');
const command = (opts) => `node --env-file=backend/.env --env-file=rimpl/.env scripts/booth/build-open-dataset.mjs --event ${opts.event}`
  + `${opts.version !== 1 ? ` --version ${opts.version}` : ''}${opts.cap !== 1 ? ` --cap ${opts.cap}` : ''}`
  + `${opts.out !== defaultOut(opts) ? ` --out ${opts.out}` : ''}${opts.signoff !== defaultSignoff(opts) ? ` --signoff ${opts.signoff}` : ''} --go`;

function plan(opts) {
  return [
    `Dry run: nothing was read, written or sent. With --go, for ${opts.event}, this build would:`,
    '  1. refuse unless the booth is switched off (app_settings booth_enabled = 0);',
    `  2. read the event's booth_plays rows, read-only: ${READ_COLUMNS} (never tag, spend_usd or scored_at);`,
    `  3. take each case version the plays name, and each current case, from backend/src/booth-cases/${opts.event} and its git history;`,
    `  4. screen each play with typed text: a PII scan, then one AI read on ${ANTHROPIC_MODEL} of its de-identified text, spending at most USD ${opts.cap};`,
    `  5. write ${path.join(opts.out, 'bundle')} (plays.csv, transcripts.jsonl, cases/, README.md, DATA-DICTIONARY.md) and ${path.join(opts.out, 'review', 'flagged.json')}, releasing flagged plays signed off in ${opts.signoff}.`,
    'It uploads nothing: the owner deposits the bundle on Zenodo by hand.',
    `Next step: ${command(opts)}`,
  ].join('\n');
}

// No UTF-8 byte bills as more than one input token; the API's own framing of a message adds a few.
const FRAMING_TOKENS = 100;
const worstUsd = (req) => costUsd(Buffer.byteLength(JSON.stringify(req)) + FRAMING_TOKENS, req.max_tokens, 'anthropic');
const unread = (reason) => ({ kind: 'unread', reason });

/**
 * @param {{ opts: object, db: object, aiRead: (req: object) => Promise<{ content: string, input_tokens?: number, output_tokens?: number }>,
 *   caseFile: (caseId: string, version: string) => Buffer|null, currentCases: () => { case_id: string, version: string }[],
 *   now: Date, log: { out: (line: string) => void, err: (line: string) => void } }} deps
 */
export async function run({ opts, db, aiRead, caseFile, currentCases, now, log }) {
  const { event, version, out, cap } = opts;
  const bundleDir = path.join(out, 'bundle');
  const reviewDir = path.join(out, 'review');

  let setting;
  try {
    const { data, error } = await db.from('app_settings').select('key, value').in('key', ['booth_enabled']);
    setting = error || !Array.isArray(data) ? undefined : data.find((r) => r.key === 'booth_enabled');
  } catch { setting = undefined; }
  if (!setting) {
    log.err('refused: could not read app_settings booth_enabled, so whether the booth is switched off is unknown.');
    return 2;
  }
  if (Number(setting.value) !== 0) {
    log.err(`refused: the booth is switched on (booth_enabled = ${setting.value}). Switch it off on the superadmin overview, then run this again.`);
    return 2;
  }

  let signed = new Set();
  try {
    signed = signedKeys(JSON.parse(readFileSync(opts.signoff, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') { log.err(`the sign-off file ${opts.signoff} is unreadable: ${e.message}`); return 2; }
  }
  const foreign = existsSync(bundleDir) ? readdirSync(bundleDir).filter((n) => !BUNDLE_NAMES.has(n)) : [];
  if (foreign.length) { log.err(`${bundleDir} holds ${foreign.join(', ')}: not a bundle this build wrote. Pass another --out.`); return 2; }

  const rows = [];
  let total;
  try {
    for (let from = 0; ; from += PAGE) {
      const { data, error, count } = await db.from('booth_plays').select(READ_COLUMNS, from === 0 ? { count: 'exact' } : undefined)
        .eq('event_code', event).order('id').range(from, from + PAGE - 1);
      if (error || !Array.isArray(data)) throw new Error(error?.message ?? 'no rows array');
      if (from === 0) total = count;
      rows.push(...data);
      if (data.length < PAGE) break;
    }
  } catch (e) {
    log.err(`booth_plays read failed: ${e.message}. Nothing was written.`);
    return 1;
  }
  // A server page smaller than PAGE would end the loop early and pass for the whole event.
  if (Number.isInteger(total) && total !== rows.length) {
    log.err(`read ${rows.length} of ${total} booth_plays rows of ${event}. Nothing was written.`);
    return 1;
  }
  if (!rows.length) { log.err(`${event} has no booth plays. Nothing was written: check the event code.`); return 1; }

  let current;
  try { current = currentCases(); } catch (e) { log.err(`the case folder of ${event} is unreadable: ${e.message}`); return 2; }
  const wanted = new Map();
  for (const [id, v] of [...rows.map((r) => [r.case_id, r.case_version]), ...current.map((c) => [c.case_id, c.version])]) {
    if (id != null && v != null) wanted.set(`${id}@${v}`, [id, String(v)]);
  }
  const cases = new Map();
  const missing = [];
  for (const [id, v] of wanted.values()) {
    const bytes = SAFE_CASE_ID.test(id) && SAFE_VERSION.test(v) ? caseFile(id, v) : null;
    if (bytes) cases.set(`${id}-v${v}.json`, bytes);
    else missing.push(`${id}@${v}`);
  }
  if (missing.length) {
    log.err(`no committed case file holds ${missing.join(', ')}. Nothing was written.`);
    return 1;
  }

  const ordered = sortedByRef(rows);
  const screens = new Map();
  let spent = 0;
  let capped = false;
  for (const { ref, row } of ordered.filter(({ row }) => hasTyped(row))) {
    const strings = freeText(row);
    const findings = strings.flatMap(scanPii);
    let ai = { kind: 'clear' };
    if (strings.length) {
      let req;
      try { req = aiReadRequest(strings); } catch (e) { ai = unread(`the PII filter failed: ${e.message}`); }
      if (req) {
        const worst = worstUsd(req);
        if (capped || spent + worst > cap) {
          capped = true;
          ai = unread('cap');
        } else {
          try {
            const res = await aiRead(req);
            spent += Number.isFinite(res.input_tokens) && Number.isFinite(res.output_tokens)
              ? costUsd(res.input_tokens, res.output_tokens, 'anthropic') : worst;
            ai = parseAiRead(res.content);
          } catch (e) {
            spent += worst;
            ai = unread(`the AI read failed: ${e.message}`);
          }
        }
      }
    }
    screens.set(ref, { ref, sha256: textSha(strings), strings, findings, ai });
  }

  const states = new Map(ordered.map(({ ref, row }) => [ref, transcriptState(row, screens.get(ref) ?? null, signed)]));
  const stateOf = (ref) => states.get(ref);
  const tally = (state) => [...states.values()].filter((s) => s === state).length;
  const counts = {
    plays: rows.length, scored: rows.filter((r) => r.status === 'scored').length,
    released: tally('released'), withheld: tally('withheld'), none: tally('none'),
  };
  const typed = [...screens.values()];
  const unreadN = typed.filter((s) => s.ai.kind === 'unread').length;
  const toSign = typed.filter((s) => flagged(s) && s.ai.kind !== 'unread' && stateOf(s.ref) === 'withheld').length;

  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(path.join(bundleDir, 'cases'), { recursive: true });
  writeFileSync(path.join(bundleDir, 'plays.csv'), playsCsv(rows, stateOf));
  writeFileSync(path.join(bundleDir, 'transcripts.jsonl'), transcriptsJsonl(rows, stateOf));
  for (const [name, bytes] of cases) writeFileSync(path.join(bundleDir, 'cases', name), bytes);
  writeFileSync(path.join(bundleDir, 'README.md'),
    readme({ event, version, commit: opts.commit ?? null, builtOn: bangkokDate(now.toISOString()), counts }));
  writeFileSync(path.join(bundleDir, 'DATA-DICTIONARY.md'), dictionary());
  mkdirSync(reviewDir, { recursive: true });
  const flaggedPath = path.join(reviewDir, 'flagged.json');
  writeFileSync(flaggedPath, `${JSON.stringify(flaggedReport(typed, stateOf), null, 2)}\n`);

  const next = unreadN
    ? `Run \`${command(opts)}\` again to read the ${unreadN} plays the AI could not read`
      + `${typed.some((s) => s.ai.reason === 'cap') ? ' (raise --cap: the cap stopped the reads)' : ''}; their transcripts stay withheld until then.`
    : toSign
      ? `Read the ${toSign} withheld plays in ${flaggedPath}. To release one, copy its signoff into ${opts.signoff} with your name in "by", then run \`${command(opts)}\` again. Or deposit ${bundleDir} on Zenodo by hand as it is: those transcripts stay out.`
      : `Deposit ${bundleDir} on Zenodo by hand, under CC BY 4.0.`;
  log.out([
    `Open booth dataset ${event} v${version}: ${counts.plays} plays, ${counts.scored} scored.`,
    `transcripts released ${counts.released}  withheld ${counts.withheld}  none ${counts.none}`,
    `plays with typed text ${typed.length}: flagged ${typed.filter(flagged).length}, waiting on a sign-off ${toSign}, AI unread ${unreadN}`,
    `AI read spend USD ${spent.toFixed(4)} of a ${cap} cap`,
    `Bundle ${bundleDir}`,
    `Review ${flaggedPath}`,
    'Uploaded nothing.',
    `Next step: ${next}`,
  ].join('\n'));
  return 0;
}

export function anthropicRead({ apiKey, fetchImpl = fetch }) {
  return async (req) => {
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ ...req, model: ANTHROPIC_MODEL }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`the Messages API answered ${res.status}`);
    const json = await res.json();
    return {
      content: (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
      input_tokens: json.usage?.input_tokens, output_tokens: json.usage?.output_tokens,
    };
  };
}

export function gitCaseFile(dir) {
  const git = (args, encoding = 'utf8') => execFileSync('git', args,
    { cwd: dir, encoding, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const versionOf = (bytes) => { try { return String(JSON.parse(bytes.toString('utf8')).version); } catch { return null; } };
  return (caseId, version) => {
    const name = `./${caseId}.json`;
    let commits;
    try {
      if (!git(['status', '--porcelain', '--', name]).trim() && existsSync(path.join(dir, name))) {
        const bytes = readFileSync(path.join(dir, name));
        if (versionOf(bytes) === version) return bytes;
      }
      commits = git(['log', '--format=%H', '--', name]).trim().split('\n').filter(Boolean);
    } catch { return null; }
    for (const commit of commits) {
      let bytes;
      try { bytes = git(['show', `${commit}:${name}`], 'buffer'); } catch { continue; }
      if (versionOf(bytes) === version) return bytes;
    }
    return null;
  };
}

export const currentCaseFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
  const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  return { case_id: raw.case_id, version: String(raw.version) };
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(`${opts.error}\n${USAGE}`);
    process.exit(2);
  }
  if (!opts.go) {
    console.log(plan(opts));
    process.exit(0);
  }
  const unset = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY'].filter((k) => !process.env[k]);
  if (unset.length) {
    console.error(`${unset.join(', ')} not set: nothing was read. Run \`${command(opts)}\` from the repo root.\n${USAGE}`);
    process.exit(2);
  }
  let createClient;
  try { ({ createClient } = createRequire(path.join(ROOT, 'backend', 'package.json'))('@supabase/supabase-js')); } catch {
    console.error('cannot resolve @supabase/supabase-js: run `npm --prefix backend install` first.');
    process.exit(2);
  }
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const casesDir = path.join(ROOT, 'backend', 'src', 'booth-cases', opts.event);
  process.exit(await run({
    opts: { ...opts, commit },
    db: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }),
    aiRead: anthropicRead({ apiKey: process.env.ANTHROPIC_API_KEY }),
    caseFile: gitCaseFile(casesDir),
    currentCases: () => currentCaseFiles(casesDir),
    now: new Date(),
    log: { out: console.log, err: console.error },
  }));
}
