#!/usr/bin/env node
/*
 * One-off check of db/migration-message-client-turn-id.sql against a REAL Postgres: the store_chat_turn()
 * function, the claims table and the partial unique index. The hermetic jest suite plays the database with
 * an in-memory model; this is the check that the SQL itself does what that model assumes.
 *
 * NEVER against production. It applies the migration (twice — it must be re-runnable), creates two
 * throwaway PLEs, calls the function, and deletes its PLEs again (cascade) at the end.
 *
 * Targets:
 *   - `supabase start` (local)                      DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres
 *   - a Supabase BRANCH (pass --branch-ok)           DATABASE_URL=<branch connection string>
 *   - a throwaway local Postgres (pass --bootstrap-minimal to create stand-in roles/tables)
 * Optional, to also exercise the API path the backend uses (PostgREST + supabase-js):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 * Without them (or with --sql-only) the same checks run in SQL as `set role service_role`.
 *
 * Checks: migration applies twice · happy path returns 2 ids and the reply is stamped after the question ·
 * an unkeyed (NULL key) turn stores 2 rows · an ended PLE raises CT409 and stores nothing · a duplicate key
 * raises 23505 and stores nothing · the replace (repair) path swaps the orphan for the new pair, and is
 * refused with the orphan intact on an ended PLE · anon and authenticated get 42501.
 *
 * Refuses to run unless every URL is localhost, or --branch-ok is passed; refuses the production project
 * ref ALWAYS. Needs `psql` on PATH.
 *
 * Run: node scripts/db/verify-store-chat-turn.mjs [--branch-ok] [--sql-only] [--bootstrap-minimal]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MIGRATION = fileURLToPath(new URL('../../db/migration-message-client-turn-id.sql', import.meta.url));
const PROD_REF = 'rgwnnexokstctugwtwub';   // physician-ui/public/js/config.js — production. Never.
const args = new Set(process.argv.slice(2));
const DB = process.env.DATABASE_URL;
const API = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

function die(msg) { console.error(`verify-store-chat-turn: ${msg}`); process.exit(2); }
if (!DB) die('set DATABASE_URL (local `supabase start`, a Supabase branch, or a throwaway Postgres).');
const isLocal = (u) => { try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };
for (const u of [DB, API].filter(Boolean)) {
  if (u.includes(PROD_REF)) die('that is the PRODUCTION project. Refusing, with or without --branch-ok.');
  if (!isLocal(u) && !args.has('--branch-ok')) die(`${new URL(u).hostname} is not localhost. Pass --branch-ok only for a Supabase branch.`);
}
if (args.has('--bootstrap-minimal') && !isLocal(DB)) die('--bootstrap-minimal creates stand-in tables: localhost only.');

// ---- psql -------------------------------------------------------------------------------------------
function psql(sql, { file } = {}) {
  const r = spawnSync('psql', [DB, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
    ...(file ? ['-f', file] : [])], { input: file ? undefined : sql, encoding: 'utf8' });
  if (r.error) die(`psql: ${r.error.message}`);
  const code = (r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/) || [])[1] || null;
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim(), code };
}
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const one = (sql) => { const r = psql(sql); if (!r.ok) throw new Error(`${sql.slice(0, 80)}… → ${r.err}`); return r.out; };

const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };

// ---- the call under test: through PostgREST when we have it, else in SQL as service_role -------------
const require = createRequire(fileURLToPath(new URL('../../backend/package.json', import.meta.url)));
const useApi = !!(API && SERVICE_KEY) && !args.has('--sql-only');
const sbService = useApi ? require('@supabase/supabase-js').createClient(API, SERVICE_KEY, { auth: { persistSession: false } }) : null;
const sbAnon = useApi && ANON_KEY ? require('@supabase/supabase-js').createClient(API, ANON_KEY, { auth: { persistSession: false } }) : null;

const ARGS = (o) => ({
  p_ple_id: o.ple, p_client_turn_id: o.key ?? null,
  p_physician_content: o.q ?? 'question', p_physician_tokens: 3,
  p_assistant_content: o.a ?? 'answer', p_refs: null, p_socratic_question: null, p_assistant_tokens: 120,
  p_provider: 'local', p_model: 'verify', p_prompt_version: 'verify', p_replace_physician_id: o.replace ?? null,
});
async function store(o, role = 'service_role') {
  if (useApi && role === 'service_role') {
    const { data, error } = await sbService.rpc('store_chat_turn', ARGS(o));
    if (error) return { ok: false, code: error.code, err: error.message };
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: true, physician: row?.physician_id, assistant: row?.assistant_id };
  }
  const a = ARGS(o);
  const call = `select physician_id || '|' || assistant_id from public.store_chat_turn(${q(a.p_ple_id)}, ${q(a.p_client_turn_id)}, ` +
    `${q(a.p_physician_content)}, 3, ${q(a.p_assistant_content)}, null, null, 120, 'local', 'verify', 'verify', ${q(a.p_replace_physician_id)});`;
  const r = psql(`begin; set local role ${role}; ${call} commit;`);
  if (!r.ok) return { ok: false, code: r.code, err: r.err };
  const [physician, assistant] = r.out.split('\n').filter((l) => l.includes('|')).pop().split('|');
  return { ok: true, physician, assistant };
}

// ---- run ---------------------------------------------------------------------------------------------
const created = [];
try {
  if (args.has('--bootstrap-minimal') && one(`select to_regclass('public.ples') is null;`) === 't') {
    one(`do $$ begin
           if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
           if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
           if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
         end $$;
         create table public.ples (id uuid primary key default gen_random_uuid(), status text not null default 'active');
         create table public.messages (id uuid primary key default gen_random_uuid(),
           ple_id uuid not null references public.ples(id) on delete cascade,
           role text not null check (role in ('physician','assistant')), content text not null,
           refs jsonb default '[]'::jsonb, socratic_question text, token_count integer default 0,
           created_at timestamptz default now(), provider text, model text, prompt_version text);
         grant usage on schema public to service_role;
         grant select, insert, update, delete on public.ples, public.messages to service_role;`);
    console.log('bootstrapped minimal stand-in schema (ples, messages, roles)');
  }

  for (const n of [1, 2]) {
    const r = psql(null, { file: MIGRATION });
    check(r.ok, `migration applies (run ${n})${r.ok ? '' : ': ' + r.err.split('\n')[0]}`);
    if (!r.ok) throw new Error('migration failed');
  }

  // Throwaway PLEs. On a real schema a PLE needs a professional: borrow any existing one (is_test = true).
  const real = one(`select to_regclass('public.professionals') is not null;`) === 't';
  const mk = (status) => one(real
    ? `insert into public.ples (physician_id, is_test, status) select id, true, ${q(status)} from public.professionals limit 1 returning id;`
    : `insert into public.ples (status) values (${q(status)}) returning id;`);
  const active = mk('active'); const ended = mk('ended');
  if (!active || !ended) throw new Error('could not create fixture PLEs (no professional to borrow?)');
  created.push(active, ended);
  console.log(`fixtures: active ${active}, ended ${ended}  (via ${useApi ? 'PostgREST/supabase-js' : 'SQL as service_role'})`);

  const K1 = one('select gen_random_uuid();'), K2 = one('select gen_random_uuid();');
  const count = (where) => Number(one(`select count(*) from public.messages where ${where};`));

  // 1. happy path
  const h = await store({ ple: active, key: K1 });
  check(h.ok && h.physician && h.assistant, `happy path returns 2 ids${h.ok ? '' : ': ' + h.code + ' ' + h.err}`);
  if (h.ok) {
    const later = one(`select (select created_at from public.messages where id = ${q(h.assistant)}) >
                              (select created_at from public.messages where id = ${q(h.physician)});`);
    check(later === 't', 'the reply is stamped strictly AFTER the question (clock_timestamp, no tie)');
  }

  // 2. unkeyed
  const u = await store({ ple: active, key: null, q: 'unkeyed q', a: 'unkeyed a' });
  check(u.ok && count(`ple_id = ${q(active)} and client_turn_id is null`) === 2, 'an unkeyed (NULL key) turn stores both rows');

  // 3. ended PLE
  const e = await store({ ple: ended, key: K2 });
  check(!e.ok && e.code === 'CT409', `ended PLE raises CT409 (got ${e.code})`);
  check(count(`ple_id = ${q(ended)}`) === 0, 'nothing stored on the ended PLE');

  // 4. duplicate key
  const before = count(`ple_id = ${q(active)}`);
  const d = await store({ ple: active, key: K1, a: 'SECOND' });
  check(!d.ok && d.code === '23505', `duplicate key raises 23505 (got ${d.code})`);
  check(count(`ple_id = ${q(active)}`) === before, 'and stores zero new rows (both rolled back)');

  // 5. replace (repair): an orphaned question of key K2 is swapped for the new pair, in one transaction
  const orphan = one(`insert into public.messages (ple_id, role, content, client_turn_id) values (${q(active)}, 'physician', 'question', ${q(K2)}) returning id;`);
  const rp = await store({ ple: active, key: K2, replace: orphan });
  check(rp.ok && rp.physician !== orphan, 'replace path stores the new pair');
  check(count(`id = ${q(orphan)}`) === 0 && count(`ple_id = ${q(active)} and client_turn_id = ${q(K2)}`) === 2, 'the orphan is gone; the key has exactly one pair');

  // 6. replace on an ended PLE: refused, orphan untouched
  const orphan2 = one(`insert into public.messages (ple_id, role, content, client_turn_id) values (${q(ended)}, 'physician', 'question', ${q(K1)}) returning id;`);
  const rx = await store({ ple: ended, key: K1, replace: orphan2 });
  check(!rx.ok && rx.code === 'CT409' && count(`id = ${q(orphan2)}`) === 1, 'replace on an ended PLE: CT409 and the orphan is untouched');

  // 7. privileges
  for (const role of ['anon', 'authenticated']) {
    const r = await store({ ple: active, key: one('select gen_random_uuid();') }, role);
    check(!r.ok && r.code === '42501', `${role} cannot execute (got ${r.code})`);
  }
  if (sbAnon) {
    const { error } = await sbAnon.rpc('store_chat_turn', ARGS({ ple: active, key: one('select gen_random_uuid();') }));
    check(error && error.code === '42501', `anon key through PostgREST is refused (got ${error?.code})`);
  }
} catch (e) {
  check(false, `aborted: ${e.message}`);
} finally {
  if (created.length) {
    const r = psql(`delete from public.ples where id in (${created.map(q).join(', ')});`);
    console.log(r.ok ? `cleanup: removed ${created.length} fixture PLEs (cascade)` : `cleanup FAILED: ${r.err}`);
  }
}
console.log(fails.length ? `\nFAILED: ${fails.length}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
