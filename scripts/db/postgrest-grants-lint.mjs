#!/usr/bin/env node
// Fails when the repo's SQL would leave anon or authenticated holding a privilege in `public` (#281, ADR 0007).
// The hermetic postgrest-surface test proves the closure migration; this proves no other SQL file undoes it.
// Two rules, over db/schema.sql and every db/migration-*.sql:
//   grant     a GRANT (or ALTER DEFAULT PRIVILEGES ... GRANT) whose grantee list names anon, authenticated or PUBLIC,
//             except USAGE on a schema, which reaches no object;
//   function  a CREATE FUNCTION / PROCEDURE in public with no REVOKE ... FROM PUBLIC on it in the same file, since
//             every new function gets the built-in PUBLIC execute and anon holds whatever PUBLIC holds.
// db/schema.sql is one ordered script, so only what follows its closure section counts there. Migration files have
// no order: findings in files that predate the closure are listed in postgrest-grants-baseline.txt, which a re-run
// of db/migration-postgrest-closed.sql neutralises. A baseline line that no longer matches fails too, so it only shrinks.
//
//   node scripts/db/postgrest-grants-lint.mjs [db-dir]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOSURE_MARK = /revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+public\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/gi;
const CLIENT = /\b(anon|authenticated)\b|\bpublic\b(?!\s*\.)/i;

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
const squash = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function findings(file, sql) {
  let text = stripComments(sql);
  if (file === 'schema.sql') {
    const marks = [...text.matchAll(CLOSURE_MARK)];
    if (!marks.length) return [{ file, rule: 'closure', key: 'schema.sql has no closure section' }];
    text = text.slice(marks.at(-1).index);
  }
  const out = [];
  for (const m of text.matchAll(/\bgrant\b[^;]*?\bto\b([^;]*);/gi)) {
    if (CLIENT.test(m[1]) && !/\bon\s+schema\b/i.test(m[0])) out.push({ file, rule: 'grant', key: squash(m[0]) });
  }
  const revoked = new Set();
  for (const m of text.matchAll(/\brevoke\b[^;]*?\bon\s+(?:function|routine|procedure)\s+(?:public\s*\.\s*)?"?(\w+)"?[^;]*?\bfrom\b([^;]*);/gi)) {
    if (/\bpublic\b(?!\s*\.)/i.test(m[2])) revoked.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s*\(/gi)) {
    const schema = (m[1] || 'public').toLowerCase();
    const name = m[2].toLowerCase();
    if (schema === 'public' && !revoked.has(name)) out.push({ file, rule: 'function', key: name });
  }
  return out;
}

export function lint(dbDir, baselineText) {
  const files = readdirSync(dbDir).filter((f) => f === 'schema.sql' || /^migration-.*\.sql$/.test(f)).sort();
  const all = files.flatMap((f) => findings(f, readFileSync(join(dbDir, f), 'utf8')));
  const line = (x) => `${x.file}\t${x.rule}\t${x.key}`;
  const baseline = new Set(baselineText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  const found = new Set(all.map(line));
  return {
    violations: [...found].filter((l) => !baseline.has(l)),
    stale: [...baseline].filter((l) => !found.has(l)),
    all: [...found],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbDir = process.argv[2] || join(HERE, '../../db');
  const { violations, stale } = lint(dbDir, readFileSync(join(HERE, 'postgrest-grants-baseline.txt'), 'utf8'));
  for (const v of violations) console.error(`FAIL ${v.replace(/\t/g, '  ')}`);
  for (const s of stale) console.error(`STALE baseline line no longer matches: ${s.replace(/\t/g, '  ')}`);
  if (violations.length || stale.length) {
    console.error('A grant to anon/authenticated/PUBLIC, or a function in public without REVOKE ... FROM PUBLIC, reopens the'
      + ' PostgREST surface (ADR 0007). Revoke PUBLIC in the same file; never grant the client roles.');
    process.exit(1);
  }
  console.log('postgrest-grants-lint: no grant to anon, authenticated or PUBLIC outside the baseline');
}
