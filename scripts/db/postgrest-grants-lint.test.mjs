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
  assert.deepEqual(r.violations, ['migration-zz-probe.sql\tfunction\tzz_probe']);
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
  assert.deepEqual(f('alter default privileges in schema public grant select on tables to anon;'), ['grant']);
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
