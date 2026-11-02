import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint, findings } from './postgrest-grants-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, '../../db');
const BASELINE = readFileSync(join(HERE, 'postgrest-grants-baseline.txt'), 'utf8');

// The repo's db/ plus one extra migration file, the way a new PR would add it.
function withMigration(name, sql) {
  const dir = mkdtempSync(join(tmpdir(), 'grants-lint-'));
  cpSync(DB, dir, { recursive: true });
  writeFileSync(join(dir, name), sql);
  return lint(dir, BASELINE);
}

test('the repo passes with its baseline', () => {
  const r = lint(DB, BASELINE);
  assert.deepEqual([r.violations, r.stale], [[], []]);
});

test('a new migration granting a table to authenticated fails', () => {
  const r = withMigration('migration-zz-probe.sql', 'grant select on public.ples to authenticated;\n');
  assert.deepEqual(r.violations, ['migration-zz-probe.sql\tgrant\tgrant select on public.ples to authenticated;']);
});

test('a new migration creating a function without revoking PUBLIC fails', () => {
  const r = withMigration('migration-zz-probe.sql', "create function public.zz_probe() returns int language sql as 'select 1';\n");
  assert.deepEqual(r.violations, ['migration-zz-probe.sql\tfunction\tzz_probe()']);
});

test('the same function passes once the file revokes PUBLIC', () => {
  const r = withMigration('migration-zz-probe.sql', "create or replace function zz_probe() returns int language sql as 'select 1';\n"
    + 'revoke all on function public.zz_probe() from public, anon, authenticated;\n'
    + 'grant execute on function public.zz_probe() to service_role;\n');
  assert.deepEqual(r.violations, []);
});

test('grants to PUBLIC, to anon in a default ACL, and on a column fail; schema usage and service_role pass', () => {
  const f = (sql) => findings('migration-x.sql', sql).map((x) => x.rule);
  assert.deepEqual(f('grant usage on sequence public.s to public;'), ['grant']);
  assert.deepEqual(f('alter default privileges in schema public grant select on tables to anon;'), ['defacl']);
  assert.deepEqual(f('grant select (content)\n  on public.messages to anon, authenticated;'), ['grant']);
  assert.deepEqual(f('grant usage on schema public to anon, authenticated;'), []);
  assert.deepEqual(f('grant all on public.t to service_role;'), []);
  assert.deepEqual(f('-- grant select on public.t to anon;'), []);
});

test('a function in another schema is out of scope', () => {
  assert.deepEqual(findings('migration-x.sql', "create function auth.uid() returns uuid language sql as 'select null';"), []);
});

test('db/schema.sql counts only what follows its closure section', () => {
  const closure = 'revoke all on all tables in schema public from public, anon, authenticated;\n';
  assert.deepEqual(findings('schema.sql', `grant select on public.t to anon;\n${closure}`), []);
  assert.deepEqual(findings('schema.sql', `${closure}grant select on public.t to anon;\n`).map((x) => x.rule), ['grant']);
  assert.deepEqual(findings('schema.sql', 'grant select on public.t to anon;\n').map((x) => x.rule), ['closure']);
});

test('a baseline line that no longer matches fails as stale', () => {
  const r = lint(DB, `${BASELINE}\nmigration-gone.sql\tfunction\tgone\n`);
  assert.deepEqual(r.stale, ['migration-gone.sql\tfunction\tgone']);
});

test('a schema privilege other than USAGE fails (R3)', () => {
  const r = withMigration('migration-zz-probe.sql', 'grant create on schema public to anon;\n');
  assert.deepEqual(r.violations, ['migration-zz-probe.sql\tgrant\tgrant create on schema public to anon;']);
  assert.deepEqual(findings('migration-x.sql', 'grant usage, create on schema public to authenticated;').map((x) => x.rule), ['grant']);
});

test('a PUBLIC revoke covers only the signature it names (R4)', () => {
  const r = withMigration('migration-zz-probe.sql', "create function public.zz(a int) returns int language sql as 'select 1';\n"
    + 'revoke all on function public.zz(int) from public;\n'
    + "create function public.zz(a text) returns int language sql as 'select 1';\n");
  assert.deepEqual(r.violations, ['migration-zz-probe.sql\tfunction\tzz(text)']);
});

test('signatures ignore parameter names, modes, defaults, OUT parameters and type aliases', () => {
  const f = (sql) => findings('migration-x.sql', sql);
  assert.deepEqual(f("create function public.g(in p_a integer default 1, out o text, p_b timestamp with time zone = now()) returns record language sql as 'select 1';\n"
    + 'revoke all on function public.g(int4, timestamptz) from public;'), []);
  assert.deepEqual(f("create function public.h(p_ids uuid[], p_n varchar(20)) returns int language sql as 'select 1';\n"
    + 'revoke execute on function public.h(uuid [], character varying) from public, anon;'), []);
});

test('a new overload in a baselined file is not covered by that file\'s line (R8)', () => {
  const file = 'migration-usage-limits.sql';
  const r = withMigration(file, readFileSync(join(DB, file), 'utf8')
    + "\ncreate function public.increment_usage(a text) returns int language sql as 'select 1';\n");
  assert.deepEqual(r.violations, [`${file}\tfunction\tincrement_usage(text)`]);
});

test('ownership given to a client role fails (R7)', () => {
  const r = withMigration('migration-zz-probe.sql', 'alter table public.ples owner to anon;\n');
  assert.deepEqual(r.violations, ['migration-zz-probe.sql\towner\talter table public.ples owner to anon;']);
  const f = (sql) => findings('migration-x.sql', sql).map((x) => x.rule);
  for (const sql of ['alter view public.v owner to authenticated;', 'alter sequence public.s owner to anon;',
    'alter function public.fn(int) owner to anon;', 'alter schema public owner to authenticated;',
    'create schema leak authorization anon;']) assert.deepEqual(f(sql), ['owner'], sql);
  assert.deepEqual(f('alter table public.ples owner to postgres;'), []);
});

test('in db/schema.sql, default privileges, schema grants and ownership count before the closure too', () => {
  const closure = 'revoke all on all tables in schema public from public, anon, authenticated;\n';
  const f = (sql) => findings('schema.sql', sql + closure).map((x) => x.rule);
  assert.deepEqual(f('alter default privileges in schema public grant all on tables to anon;\n'), ['defacl']);
  assert.deepEqual(f('grant create on schema public to authenticated;\n'), ['grant']);
  assert.deepEqual(f('alter table public.t owner to anon;\n'), ['owner']);
});
