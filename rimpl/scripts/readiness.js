#!/usr/bin/env node
'use strict';

// The vm1 cutover readiness command (#431). Run inside the RIMPL container:
//   npm run readiness [-- --only reachability,context] [--json] [--out FILE] [--verbose]
// Rows, flags and exit codes: deploy/vm1/README.md "Readiness command". The logic is src/lib/readiness.js;
// this file parses flags, opens the harness, and prints the report only after it passes assertSafe.
const fs = require('fs');
const lib = require('../src/lib/readiness');

const EXIT = { go: 0, noGo: 1, usage: 2, withheld: 3 };

const USAGE = `usage: npm run readiness -- [options]
  --only <id,...>        rows to run (${lib.ROW_IDS.join(', ')})
  --json                 print the report as JSON
  --out <file>           also write the JSON report to <file>
  --verbose              send the app's own log lines to stderr
${Object.entries(lib.OPTIONS).map(([name, o]) => `  ${o.flag} <n>`.padEnd(25) + `default ${lib.ticketValue(name)}`).join('\n')}
exit: 0 every measured row passed, 1 a row failed, 2 bad usage, 3 report withheld`;

function parseArgs(argv) {
  const out = { overrides: {}, only: null, json: false, out: null, verbose: false, help: false };
  const byFlag = Object.fromEntries(Object.entries(lib.OPTIONS).map(([name, o]) => [o.flag, name]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--json') out.json = true;
    else if (flag === '--verbose') out.verbose = true;
    else if (flag === '--out') out.out = value();
    else if (flag === '--only') {
      out.only = value().split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = out.only.filter((id) => !lib.ROW_IDS.includes(id));
      if (unknown.length || !out.only.length) throw new Error(`unknown row id: ${unknown.join(', ') || '(none)'}`);
    } else if (byFlag[flag]) {
      const n = Number(value());
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} needs a positive integer`);
      out.overrides[byFlag[flag]] = n;
    } else throw new Error(`unknown option: ${flag}`);
  }
  return out;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`readiness: ${e.message}\n${USAGE}\n`);
    return EXIT.usage;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.go;
  }

  // Required here, not at the top: the harness requires the app, and --help must not boot it.
  const { openHarness } = require('../src/services/readiness-harness');
  const opts = lib.resolveOptions(args.overrides);
  const harness = await openHarness({ opts, verbose: args.verbose });
  let report;
  try {
    report = await lib.runReadiness(harness.ctx, {
      only: args.only,
      onProgress: (id, status) => process.stderr.write(`readiness: ${id} ${status}\n`),
    });
  } finally {
    await harness.close();
  }

  const sensitive = [
    ...lib.sensitiveFromEnv(harness.originalEnv),
    ...lib.fixtureLiterals(),
    ...harness.registered().flatMap(lib.textLiteral),
  ];
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const text = args.json ? json : lib.formatText(report);
  const unsafe = lib.findUnsafe(`${text}\n${json}`, sensitive);
  if (unsafe) {
    process.stdout.write(`report withheld: contained ${unsafe}\n`);
    return EXIT.withheld;
  }
  if (args.out) fs.writeFileSync(args.out, json);
  process.stdout.write(text);
  return lib.exitCodeFor(report) === 0 ? EXIT.go : EXIT.noGo;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch((e) => {
      const what = /^[A-Za-z0-9_]{1,40}$/.test(String(e?.code)) ? e.code : (e?.name || 'error');
      process.stderr.write(`readiness: internal error (${what})\n`);
      return EXIT.noGo;
    })
    .then((code) => process.stdout.write('', () => process.exit(code)));
}

module.exports = { main, parseArgs, EXIT };
