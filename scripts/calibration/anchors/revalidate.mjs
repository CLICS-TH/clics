#!/usr/bin/env node
/*
 * Re-check a past score-local.mjs run against PRODUCTION's scoring contract, offline.
 *
 *   node scripts/calibration/anchors/revalidate.mjs <run.json> [--out <revalidated.json>]
 *
 * Each row's saved raw replies (rows[].replies[].text, in call order) are replayed through rimpl's
 * scoreWithConsistency — the same function evaluate.js calls, with the run's recorded mode and the
 * json-retry budget evaluate.js uses for it (0 when off). No model is called: the "model" is the list
 * of saved replies. So a row's revalidated outcome is exactly what production would have stored for
 * that sequence of replies:
 *   scores      — production accepted it (DomainScoresSchema .strict(), rationale an object)
 *   invalid_json / invalid_scores — production would have answered 502
 *   replay_exhausted — production would have RE-ASKED, and the run holds no reply for the re-ask
 *                  (only possible for a run made under a laxer contract than the replay's)
 *   not_revalidatable — the row has no saved replies (runs made before replies were recorded)
 *
 * Writes a NEW file (default <run>.revalidated.json); the input is never modified. Rows keep their
 * original scores as `scores_as_run`, and `changed` marks every row whose outcome moved. The output is
 * a normal run file: feed it to known-groups.mjs.
 *
 * Needs rimpl/node_modules (zod, for the schema). Makes no network call.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DOMAINS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

const same = (a, b) => (a == null && b == null) || (a != null && b != null && DOMAINS.every((d) => a[d] === b[d]));

/**
 * Replay one row's saved replies through production. Pure apart from rimpl's own module.
 * @returns {{scores: object|null, error: string|null, consistency?: object}}
 */
export async function replayRow(row, { mode = 'off', jsonRetries = 0 } = {}) {
  const { scoreWithConsistency } = require('../../../rimpl/src/services/consistency.js');
  const replies = Array.isArray(row?.replies) ? row.replies : null;
  if (!replies || !replies.length) return { scores: null, error: 'not_revalidatable' };
  let i = 0;
  class Exhausted extends Error {}
  try {
    const res = await scoreWithConsistency({
      mode, jsonRetries,
      callOnce: async () => {
        if (i >= replies.length) throw new Exhausted('replay_exhausted');
        const r = replies[i++];
        return { text: String(r?.text ?? ''), inputTokens: 0, outputTokens: Number(r?.completion_tokens) || 0 };
      },
    });
    return { scores: Object.fromEntries(DOMAINS.map((d) => [d, res.scores[d]])), error: null, consistency: res.consistency };
  } catch (e) {
    if (e instanceof Exhausted) return { scores: null, error: 'replay_exhausted' };
    return { scores: null, error: e.kind ?? e.code ?? e.name ?? 'error' };
  }
}

/** Revalidate a whole run document. Returns a new document; the input is not mutated. */
export async function revalidateRun(doc) {
  const mode = doc?.consistency ?? 'off';
  const jsonRetries = Number.isInteger(doc?.json_retries) ? doc.json_retries : (mode === 'off' ? 0 : 2);
  const rows = [];
  const tally = { rows: 0, scored: 0, changed: 0, not_revalidatable: 0, by_outcome: {} };
  for (const row of doc?.rows ?? []) {
    let out;
    if (!row?.replies?.length && row?.error && !row?.scores) {
      // A transport failure never produced a reply: nothing to replay, and nothing to change.
      out = { scores: null, error: row.error, replayed: false };
    } else {
      out = { ...(await replayRow(row, { mode, jsonRetries })), replayed: true };
    }
    const changed = out.error !== 'not_revalidatable' && !same(out.scores, row.scores);
    const next = { ...row, scores_as_run: row.scores ?? null, error_as_run: row.error ?? null,
      scores: out.error === 'not_revalidatable' ? (row.scores ?? null) : out.scores,
      error: out.error === 'not_revalidatable' ? (row.error ?? null) : out.error,
      revalidation: out.error === 'not_revalidatable' ? 'not_revalidatable' : (out.replayed ? 'replayed' : 'no_reply'),
      changed };
    rows.push(next);
    tally.rows++;
    if (next.scores) tally.scored++;
    if (changed) tally.changed++;
    if (next.revalidation === 'not_revalidatable') tally.not_revalidatable++;
    const k = next.revalidation === 'not_revalidatable' ? 'not_revalidatable' : (next.error ?? 'scored');
    tally.by_outcome[k] = (tally.by_outcome[k] ?? 0) + 1;
  }
  return {
    ...doc,
    revalidated: {
      at: new Date().toISOString(),
      contract: 'rimpl scoreWithConsistency → pis7 scoreFromText (DomainScoresSchema .strict())',
      mode, json_retries: jsonRetries, ...tally,
    },
    rows,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
  if (!file) { console.error('usage: revalidate.mjs <run.json> [--out <revalidated.json>]'); process.exit(2); }
  const oi = argv.indexOf('--out');
  const out = path.resolve(oi > -1 ? argv[oi + 1] : file.replace(/\.json$/, '') + '.revalidated.json');
  if (path.resolve(file) === out) { console.error('refusing to overwrite the input run'); process.exit(2); }
  const doc = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  const res = await revalidateRun(doc);
  await writeFile(out, JSON.stringify(res, null, 2) + '\n');
  const t = res.revalidated;
  console.log(`\nrevalidated ${path.basename(file)} against production's contract (mode ${t.mode}, json_retries ${t.json_retries})`);
  console.log(`  rows ${t.rows} · scored ${t.scored} · changed ${t.changed} · not re-validatable ${t.not_revalidatable}`);
  console.log(`  outcomes ${JSON.stringify(t.by_outcome)}`);
  for (const r of res.rows.filter((x) => x.changed)) {
    console.log(`  changed ${r.id} #${r.run}: ${r.scores_as_run ? 'scored' : r.error_as_run} → ${r.scores ? 'scored' : r.error}`);
  }
  if (t.not_revalidatable) {
    console.log(`\n  ${t.not_revalidatable} row(s) carry no saved replies (run made before score-local recorded them).`);
    console.log('  Their scores came from the older lenient parser and cannot be checked offline; re-score them');
    console.log('  with the current score-local.mjs if the strict contract matters for this run.');
  }
  console.log(`\n  → ${out}\n`);
}
