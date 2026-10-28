const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', '..', '..', 'db');

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

/** @returns {Record<string, Set<string>>} table name -> its column names */
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
  applyRenames(cols);
  return cols;
}

/*
 * RENAMEs, applied after the CREATE/ADD COLUMN pass.
 *
 * WHY THIS IS NEEDED. The reader above accumulates every declaration in db/*.sql, which is right for
 * CREATE TABLE and ADD COLUMN but blind to ALTER ... RENAME. After the CLE->PLE rename that blindness
 * reconstructed the schema as it stood BEFORE the rename, so twelve columns the code selects
 * perfectly correctly (ples.privacy_review_status, ple_integrity_flags.evidence, …) were reported as
 * not existing.
 *
 * WHY ONLY THE ONE FILE. There are two rename migrations in db/ and they are opposites:
 * migration-cle-rename.sql (2026-06, PLE->CLE) and migration-ple-rename.sql (CLE->PLE, current).
 * Applying "every rename found in db/" would apply both and land wherever file order happened to
 * leave it. The second undoes the first, so the current state is the second one alone — and naming
 * the file explicitly means the next rename has to be added here deliberately rather than picked up
 * by an ordering accident.
 *
 * The historical migrations are deliberately NOT rewritten to the new names: they are a record of
 * what was applied on a given day, and editing them to say something else falsifies it.
 */
const CURRENT_RENAME_MIGRATION = 'migration-ple-rename.sql';

function applyRenames(cols) {
  const file = path.join(DB, CURRENT_RENAME_MIGRATION);
  if (!fs.existsSync(file)) return;
  const sql = fs.readFileSync(file, 'utf8').toLowerCase().replace(/--[^\n]*/g, '');

  // Columns first: the statements name the table by its NEW name where it was already renamed
  // above them, so doing tables first would leave these looking for a table that no longer exists.
  for (const m of sql.matchAll(/alter table (?:public\.)?([a-z_]+)\s+rename column ([a-z_]+)\s+to ([a-z_]+)/g)) {
    const [, t, from, to] = m;
    for (const key of [t, t.replace(/^ple/, 'cle'), t.replace(/^ples$/, 'cles')]) {
      if (cols[key] && cols[key].has(from)) { cols[key].delete(from); cols[key].add(to); }
    }
  }
  for (const m of sql.matchAll(/alter table (?:public\.)?([a-z_]+)\s+rename to ([a-z_]+)/g)) {
    const [, from, to] = m;
    if (!cols[from]) continue;
    cols[to] = new Set([...(cols[to] ?? []), ...cols[from]]);
    delete cols[from];
  }
}

module.exports = { schemaFromSql };
