#!/usr/bin/env node
// Write DUMMY backend.env / rimpl.env for vm1's compose file, generated from the committed examples, so
// CI can render, build and boot deploy/vm1/docker-compose.yml with no secret and no live service.
//
//   node scripts/deploy/vm1-ci-env.mjs <out-dir>
//
// Only names that need a value to boot are filled; every other name in the example is left out (unset).
// A filled name missing from its example is an error, so the examples cannot drift away from what the
// apps need without this failing. Hosts use the reserved .invalid TLD: nothing here can reach a real
// service. Also imported by scripts/deploy/vm1.test.mjs.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLES = path.join(ROOT, 'deploy', 'vm1');

const TOKEN = 'ci-dummy-internal-token'; // the same in both files, as on vm1
export const DUMMY = {
  'backend.env': {
    SUPABASE_URL: 'https://supabase.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'ci-dummy-service-role',
    SUPABASE_ANON_KEY: 'ci-dummy-anon',
    INTERNAL_TOKEN: TOKEN,
    GUEST_TOKEN_SECRET: 'ci-dummy-guest-secret',
    IDENTITY_ENC_KEY: 'ci-dummy-identity-key',
    ALLOWED_ORIGINS: 'https://portal.invalid',
    SITE_URL: 'https://portal.invalid',
    LICENSE_VERIFIER_ADAPTER: 'manual',
    RECONCILE_INTERVAL_MS: '0',
  },
  'rimpl.env': {
    INTERNAL_TOKEN: TOKEN,
    ANTHROPIC_API_KEY: 'ci-dummy-anthropic',
    SUPABASE_URL: 'https://supabase.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'ci-dummy-service-role',
  },
};

// Names assigned (`NAME=`) in an example file, in order.
export function exampleNames(file) {
  return readFileSync(path.join(EXAMPLES, `${file}.example`), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

export function writeDummyEnv(outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [file, values] of Object.entries(DUMMY)) {
    const names = new Set(exampleNames(file));
    const missing = Object.keys(values).filter((n) => !names.has(n));
    if (missing.length) throw new Error(`${file}.example does not list ${missing.join(', ')}`);
    const body = Object.entries(values).map(([n, v]) => `${n}=${v}`).join('\n') + '\n';
    const out = path.join(outDir, file);
    writeFileSync(out, body);
    chmodSync(out, 0o600);
  }
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node scripts/deploy/vm1-ci-env.mjs <out-dir>'); process.exit(64); }
  writeDummyEnv(path.resolve(out));
  console.log(`dummy backend.env + rimpl.env written to ${path.resolve(out)}`);
}
