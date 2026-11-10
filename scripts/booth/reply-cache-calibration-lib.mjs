// The pure half of scripts/booth/reply-cache-calibration.mjs (#387): runs rimpl's own reply cache guards
// (rimpl/src/lib/booth-cache.js) over labelled answer pairs with an embedder it is handed, and counts the unsafe
// reuses. Package-free, so CI tests it with a stub embedder and no npm install.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guards = require('../../rimpl/src/lib/booth-cache.js');

export const { KINDS } = guards;
export const LANGS = ['th', 'en'];
const KEYS = ['id', 'lang', 'kind', 'a', 'b', 'note'];

/** @typedef {{ id: string, lang: 'th' | 'en', kind: 'same' | 'negated' | 'unsafe', a: string, b: string, note: string }} Pair */

/** What is wrong with a pair set, as lines; none when it is well formed. */
export function pairProblems(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return ['the pair set is not a non-empty array'];
  const seen = new Set();
  return pairs.flatMap((p, i) => {
    const at = `pair ${i} (${p?.id ?? 'no id'})`;
    const out = [];
    if (!p || typeof p !== 'object' || Object.keys(p).sort().join() !== [...KEYS].sort().join()) out.push(`${at}: keys must be ${KEYS.join(', ')}`);
    if (!LANGS.includes(p?.lang)) out.push(`${at}: lang must be th or en`);
    if (!KINDS.includes(p?.kind)) out.push(`${at}: kind must be ${KINDS.join(', ')}`);
    for (const k of ['a', 'b']) if (typeof p?.[k] !== 'string' || p[k].trim() === '' || p[k].length > 500) out.push(`${at}: ${k} must be 1-500 characters`);
    if (seen.has(p?.id)) out.push(`${at}: duplicate id`);
    seen.add(p?.id);
    return out;
  });
}

/**
 * Both directions of every pair: would the cache reuse a's entry for b, and b's for a? An answer is embedded and cued
 * as rimpl does it, from its de-identified text (`deidentify`).
 * @param {Pair[]} pairs
 * @param {{ embed: (text: string) => Promise<number[] | null>, deidentify?: (text: string) => string, model: string }} how
 */
export async function calibrate(pairs, { embed, deidentify = (t) => t, model }) {
  const rows = [];
  for (const p of pairs) {
    const side = async (text) => {
      const clean = deidentify(text);
      const embedding = await embed(clean);
      if (!embedding) throw new Error(`no embedding for pair ${p.id}`);
      return { model, embedding, cues: guards.cuesOf(clean) };
    };
    const [a, b] = [await side(p.a), await side(p.b)];
    const reused = guards.bestReusable(b, [{ id: 'a', ...a }]) === 'a' || guards.bestReusable(a, [{ id: 'b', ...b }]) === 'b';
    const cosine = guards.cosine(a.embedding, b.embedding);
    rows.push({ id: p.id, lang: p.lang, kind: p.kind, cosine, reused, bare: cosine >= guards.THRESHOLD, cuesEqual: a.cues.join() === b.cues.join() });
  }
  const counts = Object.fromEntries(KINDS.map((kind) => {
    const of = rows.filter((r) => r.kind === kind);
    return [kind, { pairs: of.length, th: of.filter((r) => r.lang === 'th').length, en: of.filter((r) => r.lang === 'en').length,
      reused: of.filter((r) => r.reused).length, bare_reused: of.filter((r) => r.bare).length }];
  }));
  const unsafe = rows.filter((r) => r.kind !== 'same' && r.reused);
  const bareUnsafe = rows.filter((r) => r.kind !== 'same' && r.bare);
  return {
    model, threshold: guards.THRESHOLD, guard_sha: guards.guardSha(), counts, rows,
    unsafe_reuses: unsafe.length, unsafe, bare_unsafe_reuses: bareUnsafe.length, bare_unsafe: bareUnsafe,
    same_reuse_rate: counts.same.pairs ? counts.same.reused / counts.same.pairs : null,
  };
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The calibration record rimpl's calibrated() reads. Refused while any unsafe reuse remains, or any kind has no pair. */
export function recordOf(report, pairsText, date) {
  if (report.unsafe_reuses !== 0) throw new Error(`${report.unsafe_reuses} unsafe reuse(s): no record is written`);
  const missing = KINDS.find((kind) => !(report.counts[kind]?.pairs > 0));
  if (missing) throw new Error(`no ${missing} pair: no record is written`);
  return {
    model: report.model, threshold: report.threshold, guard_sha: report.guard_sha, pairs_sha: sha256(pairsText),
    unsafe_reuses: 0, counts: report.counts, same_reuse_rate: report.same_reuse_rate, date,
  };
}

/** Why --write must not write a record from `pairsFile`, or null when it may. A record binds the committed pair set
 *  only: `committed` is that file, repo-relative like `pairsFile`, and its text at HEAD (null when git cannot read it).
 *  @param {string} pairsFile @param {string} pairsText @param {{ file: string, text: string | null }} committed */
export function writeRefusal(pairsFile, pairsText, committed) {
  if (pairsFile !== committed.file) return `a record is written only from ${committed.file}`;
  if (pairsText !== committed.text) return `${committed.file} has changes not committed: commit the pair set first`;
  return null;
}

export const exitCode = (report) => (report.unsafe_reuses === 0 ? 0 : 1);

const pct = (x) => (x == null ? '-' : `${(100 * x).toFixed(1)}%`);
const listed = (rows) => rows.map((r) => `  ${r.id}  cosine ${r.cosine.toFixed(4)}${r.cuesEqual ? '' : '  (cues differ)'}`).join('\n') || '  none';

export function format(report) {
  const kinds = KINDS.map((k) => {
    const c = report.counts[k];
    return `  ${k.padEnd(8)} ${String(c.pairs).padStart(3)} pairs (th ${c.th}, en ${c.en})  reused ${c.reused}  bare threshold would reuse ${c.bare_reused}`;
  });
  return [
    `model ${report.model}  threshold ${report.threshold}  guard ${report.guard_sha.slice(0, 12)}`,
    ...kinds,
    `same-meaning reuse rate ${pct(report.same_reuse_rate)}`,
    `UNSAFE REUSES ${report.unsafe_reuses}`,
    listed(report.unsafe),
    `bare threshold (cosine >= ${report.threshold} alone) would reuse ${report.bare_unsafe_reuses} negated or unsafe pair(s):`,
    listed(report.bare_unsafe),
  ].join('\n');
}
