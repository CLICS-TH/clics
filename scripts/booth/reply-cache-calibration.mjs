#!/usr/bin/env node
// Booth reply cache calibration (#387): runs rimpl's real embedder and guards over the labelled answer pairs and
// reports, per kind, how many pairs the cache would reuse, every UNSAFE reuse (a negated or unsafe pair reused) with
// its cosine, the same-meaning reuse rate, and how many unsafe pairs the bare cosine threshold alone would reuse.
//
//   node scripts/booth/reply-cache-calibration.mjs [--pairs <file>] [--write]
//
// Exits 1 on any unsafe reuse. --write writes the calibration record rimpl reads (rimpl/src/lib/booth-cache-
// calibration.json), and only when there is none: committing that record, with the owner's go-ahead, is what lets
// rimpl reuse a reply at all. Needs rimpl's packages and the fetched model (it says how when they are missing).
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairProblems, calibrate, recordOf, exitCode, format } from './reply-cache-calibration-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const pairsFile = args.includes('--pairs') ? path.resolve(args[args.indexOf('--pairs') + 1]) : path.join(here, 'reply-cache-pairs.json');
const write = args.includes('--write');

const pairsText = readFileSync(pairsFile, 'utf8');
const pairs = JSON.parse(pairsText);
const problems = pairProblems(pairs);
if (problems.length) {
  console.error(`the pair set ${pairsFile} is malformed:\n${problems.join('\n')}`);
  process.exit(2);
}

const embedder = require(path.join(root, 'rimpl/src/services/embed.js'));
const { stripPii, makeRegistry } = require(path.join(root, 'rimpl/src/services/pii-filter.js'));
const revision = path.join(embedder.modelDir(), embedder.MODEL, embedder.REVISION_FILE);
if (!existsSync(path.join(root, 'rimpl/node_modules/@huggingface/transformers')) || !existsSync(revision)) {
  console.error('the embedder is not ready. Install rimpl\'s packages and fetch the model first:\n'
    + '  cd rimpl && npm ci && node scripts/fetch-embed-model.js');
  process.exit(2);
}

const report = await calibrate(pairs, {
  embed: embedder.embed, deidentify: (text) => stripPii(text, makeRegistry()), model: embedder.MODEL_ID,
});
console.log(`pairs ${path.relative(root, pairsFile)}`);
console.log(format(report));
if (write) {
  if (report.unsafe_reuses === 0) {
    const out = path.join(root, 'rimpl/src/lib/booth-cache-calibration.json');
    writeFileSync(out, `${JSON.stringify(recordOf(report, pairsText, new Date().toISOString().slice(0, 10)), null, 2)}\n`);
    console.log(`wrote ${path.relative(root, out)}`);
  } else {
    console.log('not written: a record needs zero unsafe reuses');
  }
}
process.exit(exitCode(report));
