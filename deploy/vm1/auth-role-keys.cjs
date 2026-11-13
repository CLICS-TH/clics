// Mint the anon and service_role keys for the self-hosted stack (#427) from GOTRUE_JWT_SECRET, on vm1. The env
// file comes in on stdin, so the secret is on no command line, and the tool runs in the backend's base image
// (vm1's host has no node of its own):
//
//   docker run --rm -i --network none node:22-slim node -e "$(cat auth-role-keys.cjs)" < /opt/clics/env/gotrue.env
//
// Prints SUPABASE_ANON_KEY= and SUPABASE_SERVICE_ROLE_KEY= lines in the shape Supabase's own legacy keys
// have: HS256 JWTs with `role` and `iss: supabase`, valid for ten years. PostgREST maps `role` to the
// database role; GoTrue's admin API accepts service_role (GOTRUE_JWT_ADMIN_ROLES). Copy the two lines into
// the env files by hand; do not redirect them into a file of their own. Package-free, like health-gate.cjs.
'use strict';
const { readFileSync } = require('node:fs');
const { createHmac } = require('node:crypto');

const lines = readFileSync(0, 'utf8').split('\n').filter((l) => l.startsWith('GOTRUE_JWT_SECRET='));
if (lines.length !== 1) { console.error('stdin must hold exactly one GOTRUE_JWT_SECRET= line (usage: see the header)'); process.exit(65); }
const secret = lines[0].slice('GOTRUE_JWT_SECRET='.length).replace(/\r$/, '');
if (secret.length < 32) { console.error('GOTRUE_JWT_SECRET is shorter than 32 characters'); process.exit(65); }

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function sign(role, now) {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role, iat: now, exp: now + 10 * 365 * 24 * 3600 })}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

const now = Math.floor(Date.now() / 1000);
process.stdout.write(`SUPABASE_ANON_KEY=${sign('anon', now)}\nSUPABASE_SERVICE_ROLE_KEY=${sign('service_role', now)}\n`);
