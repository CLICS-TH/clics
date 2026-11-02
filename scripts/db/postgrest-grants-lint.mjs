#!/usr/bin/env node
// Fails when the repo's SQL would leave anon or authenticated holding a privilege in `public` (#281, ADR 0007).
// The hermetic postgrest-surface test proves the closure migration; this proves no other SQL file undoes it.
// Rules, over db/schema.sql and every db/migration-*.sql:
//   grant     a GRANT whose grantee list names anon, authenticated or PUBLIC, except USAGE alone on a schema;
//   defacl    an ALTER DEFAULT PRIVILEGES ... GRANT to those roles;
//   owner     an ALTER ... OWNER TO, or CREATE SCHEMA ... AUTHORIZATION, naming anon or authenticated;
//   function  a CREATE FUNCTION / PROCEDURE in public with no REVOKE ... FROM PUBLIC on the same signature (name and
//             argument types) in the same file, since every new function gets the built-in PUBLIC execute.
// db/schema.sql is one ordered script that ends with the closure, which revokes object grants and function execute.
// There only the object grants and functions that follow the closure count. Schema grants, default privileges and
// ownership count anywhere, because the closure does not undo them. Migration files have no order. Findings in
// files that predate the closure are listed in postgrest-grants-baseline.txt, keyed by signature. A re-run of
// db/migration-postgrest-closed.sql neutralises them. A baseline line that no longer matches fails too.
//
// Not seen (/health/deep's postgrest_surface check is the guard): grants built in dynamic EXECUTE with a variable
// role, CREATE AGGREGATE, ALTER FUNCTION ... SET SCHEMA public, SQL outside top-level db/, `--` inside a string
// literal, and REVOKE GRANT OPTION FOR read as a full revoke.
//
//   node scripts/db/postgrest-grants-lint.mjs [db-dir]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOSURE_MARK = /revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+public\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/gi;
const CLIENT = /\b(anon|authenticated)\b|\bpublic\b(?!\s*\.)/i;
const CLIENT_ROLE = /^"?(anon|authenticated)"?$/i;

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
const squash = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// The text inside the parentheses that open at `from` (an index just past the '(').
function parenBody(text, from) {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(from, i);
  }
  return null;
}

function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const TYPE_ALIASES = {
  int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint', bool: 'boolean', decimal: 'numeric',
  float8: 'double precision', float4: 'real', varchar: 'character varying', timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone', 'timestamp without time zone': 'timestamp without time zone',
  timetz: 'time with time zone', char: 'character', bpchar: 'character',
};
const MULTIWORD_TYPE = /^(double precision|character varying|bit varying|timestamp(\s+with(out)?\s+time\s+zone)?|time(\s+with(out)?\s+time\s+zone)?)\b/;

function normType(t) {
  let s = squash(t).replace(/\s*\(\s*\d+(\s*,\s*\d+)?\s*\)/g, '').replace(/^public\s*\.\s*/, '').replace(/"/g, '');
  const arr = (s.match(/(\s*\[\s*\])+$/) || [''])[0];
  s = s.slice(0, s.length - arr.length).trim();
  return (TYPE_ALIASES[s] || s) + (arr ? '[]' : '');
}

// Identity argument types of a parameter list: names, defaults and OUT parameters dropped.
export function signature(params) {
  const types = [];
  for (let p of splitTop(params)) {
    p = squash(p).replace(/\s+(default\b|=).*$/, '').replace(/\s+\[/g, '[');
    if (!p) continue;
    const mode = p.match(/^(in|out|inout|variadic)\s+/);
    if (mode) p = p.slice(mode[0].length);
    if (mode?.[1] === 'out') continue;
    if (!MULTIWORD_TYPE.test(p.replace(/"/g, ''))) {
      const tokens = p.split(' ');
      if (tokens.length > 1) p = tokens.slice(1).join(' ');
    }
    types.push(normType(p));
  }
  return types.join(',');
}

export function findings(file, sql) {
  const full = stripComments(sql);
  let objects = full;
  const out = [];
  if (file === 'schema.sql') {
    const marks = [...full.matchAll(CLOSURE_MARK)];
    if (!marks.length) return [{ file, rule: 'closure', key: 'schema.sql has no closure section' }];
    objects = full.slice(marks.at(-1).index);
  }

  for (const m of full.matchAll(/\bgrant\b([^;]*?)\bto\b([^;]*);/gi)) {
    if (!CLIENT.test(m[2])) continue;
    const head = squash(m[1]);
    const defacl = /\balter\s+default\s+privileges\b/i.test(full.slice(full.lastIndexOf(';', m.index) + 1, m.index));
    const onSchema = /\bon\s+schema\b/.test(head);
    if (defacl) out.push({ file, rule: 'defacl', key: squash(m[0]) });
    else if (onSchema) {
      if (!/^usage\s+on\s+schema\b/.test(head)) out.push({ file, rule: 'grant', key: squash(m[0]) });
    } else if (m.index >= full.length - objects.length) out.push({ file, rule: 'grant', key: squash(m[0]) });
  }

  for (const m of full.matchAll(/\balter\b[^;]*?\bowner\s+to\s+("?\w+"?)[^;]*;|\bcreate\s+schema\b[^;]*?\bauthorization\s+("?\w+"?)[^;]*;/gi)) {
    if (CLIENT_ROLE.test(m[1] || m[2])) out.push({ file, rule: 'owner', key: squash(m[0]) });
  }

  const revoked = new Set();
  for (const m of objects.matchAll(/\brevoke\b[^;]*?\bon\s+(?:function|routine|procedure)\s+(?:public\s*\.\s*)?"?(\w+)"?\s*(\()?/gi)) {
    const sig = m[2] ? parenBody(objects, m.index + m[0].length) : null;
    const rest = objects.slice(m.index + m[0].length + (sig === null ? 0 : sig.length + 1)).split(';')[0];
    const from = rest.match(/\bfrom\b(.*)$/is);
    if (!from || !/\bpublic\b(?!\s*\.)/i.test(from[1])) continue;
    revoked.add(sig === null ? `${m[1].toLowerCase()}(*)` : `${m[1].toLowerCase()}(${signature(sig)})`);
  }
  for (const m of objects.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s*\(/gi)) {
    if ((m[1] || 'public').toLowerCase() !== 'public') continue;
    const name = m[2].toLowerCase();
    const key = `${name}(${signature(parenBody(objects, m.index + m[0].length) ?? '')})`;
    if (!revoked.has(key) && !revoked.has(`${name}(*)`)) out.push({ file, rule: 'function', key });
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
    console.error('A grant, default privilege or ownership given to anon/authenticated/PUBLIC, or a function in public without'
      + ' REVOKE ... FROM PUBLIC on its signature, reopens the PostgREST surface (ADR 0007). Never grant the client roles.');
    process.exit(1);
  }
  console.log('postgrest-grants-lint: no grant to anon, authenticated or PUBLIC outside the baseline');
}
