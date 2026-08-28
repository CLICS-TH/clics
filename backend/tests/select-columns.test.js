// Every column this codebase SELECTs must exist in the schema the repo declares.
//
// WHY THIS EXISTS. The hermetic suite mocks Supabase, so a query returns whatever the test hands it
// and a column name is never checked against anything. services/rater-spread.js shipped selecting
// `audit_scores.created_at` — a column that does not exist, it is `scored_at` — with all fifteen of
// its tests green. The endpoint 500'd on the first real request. Nothing in tsc, lint or jest could
// have caught it, because nothing in any of them knows what a table looks like.
//
// So the schema is reconstructed from `db/*.sql` (CREATE TABLE plus every ADD COLUMN) and every
// `.from('t').select('...')` in backend/src is checked against it.
//
// WHAT IT CANNOT SEE. It validates against the repo's own DECLARATION of the schema. A column added
// by hand in the Supabase console with no migration is invisible here — which is a good reason not to
// add columns that way, and the reason `db/` is the source of truth rather than the live database.
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const DB = path.join(REPO, 'db');
const SRC = path.join(__dirname, '..', 'src');

// Split a CREATE TABLE body on TOP-LEVEL commas — `numeric(5,2)` and `check (x between 0 and 5)`
// carry commas of their own. Splitting on newlines instead misses
// `c1_pass boolean, c2_pass boolean, c3_pass boolean,` — three columns on one line.
function splitTopLevel(body) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const NOT_COLUMNS = new Set(['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like']);

function schemaFromSql() {
  const cols = {};
  const add = (t, c) => { (cols[t] = cols[t] || new Set()).add(c); };
  for (const f of fs.readdirSync(DB).filter((f) => f.endsWith('.sql'))) {
    // Strip `-- ...` comments FIRST: splitting the body on commas glues a preceding comment line
    // onto the column that follows it, and the column is then unparseable.
    const sql = fs.readFileSync(path.join(DB, f), 'utf8').toLowerCase().replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
      for (const seg of splitTopLevel(m[2])) {
        const c = seg.trim().match(/^([a-z_][a-z0-9_]*)\s+/);
        if (c && !NOT_COLUMNS.has(c[1])) add(m[1], c[1]);
      }
    }
    for (const m of sql.matchAll(/alter table (?:public\.)?([a-z_]+)([\s\S]*?);/g)) {
      for (const a of m[2].matchAll(/add column (?:if not exists )?([a-z_][a-z0-9_]*)/g)) add(m[1], a[1]);
    }
  }
  return cols;
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(full) : (e.name.endsWith('.js') ? [full] : []);
  });
}

// `.from('t').select('a, b, rel(x)')`, single-quoted OR a template literal.
//
// The two quote styles need SEPARATE alternatives. A single `([`'])([^`']*)\2` looks right and is
// not: a template literal routinely contains single quotes — `${COLS.join(',')}` — so the character
// class ends the match at the `,'` and everything after it goes unchecked. The first version of this
// file did exactly that, which meant it silently skipped rater-spread.js, the file it was written
// for, while reporting a pass.
const SELECT = /\.from\('([a-z_]+)'\)\s*\n?\s*\.select\(\s*(?:'([^']*)'|`([^`]*)`)/g;

function selectedColumns() {
  const found = [];
  for (const file of jsFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(SELECT)) {
      const table = m[1];
      const list = m[2] ?? m[3];
      const flat = list
        // Interpolations FIRST, and before the embed strip: `${COLS.join(',')}` carries a comma, so
        // splitting around it invents a column called `')}`. What it expands to is unknowable here;
        // the literal columns beside it are still worth checking.
        .replace(/\$\{[^}]*\}/g, '')
        // Then PostgREST embeds — `professionals!cles_physician_id_fkey(id, name)` selects columns of
        // the EMBEDDED table, not this one, so its inner names must not be checked against this one.
        .replace(/[a-z_]+(?:![a-z_]+)?\([^)]*\)/g, '');
      for (const raw of flat.split(',')) {
        const col = raw.trim().split(':')[0].trim();     // `alias:column` — the column is on the right
        if (!col || col === '*') continue;
        found.push({ file: path.relative(SRC, file), table, col });
      }
    }
  }
  return found;
}

describe('every selected column exists in the declared schema', () => {
  const schema = schemaFromSql();
  const selected = selectedColumns();

  test('the schema was actually reconstructed', () => {
    // A silent parse failure would make the assertion below vacuously pass — which is the exact
    // failure mode this file exists to prevent, one level up.
    expect(Object.keys(schema).length).toBeGreaterThan(20);
    expect([...(schema.audit_scores ?? [])]).toContain('scored_at');
    expect([...(schema.cles ?? [])]).toContain('c3_pass');       // three columns on one source line
    expect([...(schema.cles ?? [])]).toContain('privacy_concern_open');   // added by ALTER, not CREATE
  });

  test('the source was actually scanned', () => {
    expect(selected.length).toBeGreaterThan(400);
    // Named explicitly because a regex that quietly stops at the first quote inside a template
    // literal skips this file entirely — and then this whole suite passes while checking nothing
    // about the one query that motivated it.
    const rater = selected.filter((s) => s.file.includes('rater-spread'));
    expect(rater.map((s) => s.col)).toContain('scored_at');
  });

  test('no query selects a column that does not exist', () => {
    const unknown = selected
      .filter(({ table, col }) => !schema[table] || !schema[table].has(col))
      .map(({ file, table, col }) => `${file}: ${table}.${col}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  test('it would catch the bug it was written for', () => {
    // Mutation check on the checker itself: `created_at` is real on other tables and absent here, so
    // a validator that merely looked for "a column of that name somewhere" would miss it.
    expect(schema.audit_scores.has('created_at')).toBe(false);
    expect(schema.cles.has('created_at')).toBe(true);
  });
});
