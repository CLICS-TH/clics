#!/usr/bin/env node
// Generate rimpl/src/model-manifest.json from the code (CCME R2), or check that the committed copy is
// what the code generates.
//
//   node scripts/manifest/build.mjs            write the file, print its sha256
//   node scripts/manifest/build.mjs --check    exit 1 if the committed file differs from what the code
//                                              generates (CI runs this under `env -i PATH="$PATH"`)
//
//   --declared <path>   the hand-maintained input (default rimpl/src/model-manifest.declared.json)
//   --out <path>        the manifest to write / check (default rimpl/src/model-manifest.json)
//
// Everything is computed by rimpl/src/lib/manifest.js, the SAME module rimpl loads at runtime to report
// drift, so the check and the runtime cannot disagree about what the code says. PACKAGE-FREE: CI runs this
// on a bare checkout with no `npm install`. The output depends on the code and the declared file only —
// no timestamp, no node version, no env value (the code defaults are resolved against an empty env).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const M = require('../../rimpl/src/lib/manifest.js');

function parseArgs(argv) {
  const out = { check: false, declared: M.DECLARED_FILE, file: M.MANIFEST_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--declared') out.declared = path.resolve(argv[++i] ?? '');
    else if (a === '--out') out.file = path.resolve(argv[++i] ?? '');
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)} (try --help)`);
  }
  return out;
}

// The first line where two texts differ, for a --check failure that says WHERE, not just "differs".
function firstDifference(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return { line: i + 1, committed: x[i] ?? '(end of file)', generated: y[i] ?? '(end of file)' };
  }
  return null;
}

export function generate(declaredFile = M.DECLARED_FILE) {
  const manifest = M.buildManifest(M.readDeclared(declaredFile));
  return { manifest, text: M.canonicalJson(manifest) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const { manifest, text } = generate(args.declared);
  const rel = path.relative(process.cwd(), args.file) || args.file;

  if (args.check) {
    let committed;
    try { committed = readFileSync(args.file, 'utf8'); } catch {
      console.error(`manifest --check: ${rel} is missing. Generate it: node scripts/manifest/build.mjs`);
      return 1;
    }
    if (committed === text) {
      console.log(`manifest --check: ${rel} is current (sha256 ${manifest.sha256})`);
      return 0;
    }
    const d = firstDifference(committed, text);
    console.error(`manifest --check: ${rel} is NOT what the code generates.`);
    if (d) console.error(`  first difference at line ${d.line}\n    committed: ${d.committed}\n    generated: ${d.generated}`);
    console.error('  Regenerate it (node scripts/manifest/build.mjs) and commit the result with the change that moved it.');
    return 1;
  }

  writeFileSync(args.file, text);
  console.log(`wrote ${rel} (sha256 ${manifest.sha256})`);
  return 0;
}

// Run as a script, not when imported (the test imports generate()).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`manifest: ${e.message}`);
    process.exitCode = 1;
  }
}
