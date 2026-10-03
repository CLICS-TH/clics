// The DB side of import-sandbox.mjs / import-shadow.mjs — loaded ONLY under --confirm (a dry run
// never imports this file's client, never reads backend/.env, never opens a connection).
//
// Service role from backend/.env (or the shell), @supabase/supabase-js resolved from backend/'s
// node_modules — the same pair three-way.js uses, without needing NODE_PATH.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_CODE, PROVIDER_USED, assertSandboxCouncil } from './sandbox-import-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function connect({ envFile } = {}) {
  const file = envFile ?? path.join(REPO, 'backend', '.env');
  if (!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    if (!existsSync(file)) throw new Error(`no SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY in the shell and no ${file} (pass --env <file>)`);
    process.loadEnvFile(file);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error(`SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (looked in ${file})`);
  let createClient;
  try { ({ createClient } = createRequire(path.join(REPO, 'backend', 'package.json'))('@supabase/supabase-js')); }
  catch { throw new Error('cannot resolve @supabase/supabase-js — run `npm --prefix backend install` first'); }
  const host = (() => { try { return new URL(process.env.SUPABASE_URL).host; } catch { return '?'; } })();
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return { db, host };
}

const must = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

/** The SANDBOX check against the live row. Throws unless councilId IS the SANDBOX council. */
export async function fetchSandboxCouncil(db, councilId) {
  const row = must(await db.from('councils').select('id, code, name_en').eq('id', councilId).maybeSingle(), 'read councils');
  assertSandboxCouncil(row, councilId);
  return row;
}

/** The physician must exist, be a physician, and belong to that SANDBOX council. */
export async function assertSandboxPhysician(db, physicianId, councilId) {
  const p = must(await db.from('professionals').select('id, role, council_id, status').eq('id', physicianId).maybeSingle(), 'read professionals');
  if (!p) throw new Error(`physician ${physicianId} does not exist`);
  if (p.role !== 'physician') throw new Error(`${physicianId} has role ${p.role}, not physician`);
  if (p.council_id !== councilId) throw new Error(`physician ${physicianId} belongs to council ${p.council_id}, not the ${SANDBOX_CODE} council ${councilId}`);
  return p;
}

/** Select in chunks (PostgREST URL length). */
export async function selectIn(db, table, cols, key, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...must(await db.from(table).select(cols).in(key, ids.slice(i, i + 100)), `read ${table}`));
  return out;
}

/**
 * Every row in `ids` must be an imported anchor PLE in the SANDBOX council: is_test, provider_used
 * 'anchor-synthetic', council = councilId. Anything else is refused — a hand-edited manifest must
 * not be able to point a write or a delete at a real session.
 */
export async function assertAnchorPles(db, ids, councilId) {
  const rows = await selectIn(db, 'ples', 'id, is_test, provider_used, council_id', 'id', ids);
  const bad = rows.filter((r) => !r.is_test || r.provider_used !== PROVIDER_USED || r.council_id !== councilId);
  if (bad.length) throw new Error(`${bad.length} PLE(s) are not SANDBOX anchor imports (is_test/provider_used/council mismatch): ${bad.slice(0, 5).map((r) => r.id).join(', ')} — refusing`);
  return rows;
}

export { must };
