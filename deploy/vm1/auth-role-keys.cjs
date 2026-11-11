#!/usr/bin/env node
// Mint the anon and service_role keys for the self-hosted stack (#427) from GOTRUE_JWT_SECRET, on vm1:
//
//   node auth-role-keys.cjs /opt/clics/env/gotrue.env > /root/role-keys   (then copy the two lines by hand)
//
// Prints SUPABASE_ANON_KEY= and SUPABASE_SERVICE_ROLE_KEY= lines in the shape Supabase's own legacy keys
// have: HS256 JWTs with `role` and `iss: supabase`, valid for ten years. PostgREST maps `role` to the
// database role; GoTrue's admin API accepts service_role (GOTRUE_JWT_ADMIN_ROLES). The secret is read from
// the env file, so it is never on a command line. Package-free, like health-gate.cjs.
'use strict';
const { readFileSync } = require('node:fs');
const { createHmac } = require('node:crypto');

const file = process.argv[2];
if (!file) { console.error('usage: node auth-role-keys.cjs /opt/clics/env/gotrue.env'); process.exit(64); }
const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('GOTRUE_JWT_SECRET='));
if (lines.length !== 1) { console.error(`${file} must hold exactly one GOTRUE_JWT_SECRET= line`); process.exit(65); }
const secret = lines[0].slice('GOTRUE_JWT_SECRET='.length).replace(/\r$/, '');
if (secret.length < 32) { console.error('GOTRUE_JWT_SECRET is shorter than 32 characters'); process.exit(65); }

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function sign(role, now) {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role, iat: now, exp: now + 10 * 365 * 24 * 3600 })}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

const now = Math.floor(Date.now() / 1000);
process.stdout.write(`SUPABASE_ANON_KEY=${sign('anon', now)}\nSUPABASE_SERVICE_ROLE_KEY=${sign('service_role', now)}\n`);
