// Minimal in-memory stand-in: supports .from(t).select(cols).order().range() and .select(cols).in(k, ids)
const DB = JSON.parse(require('fs').readFileSync(process.env.MOCK_DB, 'utf8'));
function project(rows, cols) {
  const keys = String(cols).split(',').map(s => s.trim()).filter(Boolean);
  return rows.map(r => Object.fromEntries(keys.map(k => [k, r[k]])));
}
function builder(table, cols) {
  const missing = !DB[table];
  let rows = missing ? [] : DB[table].slice();
  const api = {
    order(k, o) { rows.sort((a,b) => String(a[k]).localeCompare(String(b[k]))); return api; },
    range(from, to) { rows = rows.slice(from, to + 1); return api; },
    in(key, ids) { const s = new Set(ids); rows = rows.filter(r => s.has(r[key])); return api; },
    then(res, rej) {
      if (missing) return res({ data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}'` } });
      return res({ data: project(rows, cols), error: null });
    },
  };
  return api;
}
exports.createClient = () => ({ from: (t) => ({ select: (cols) => builder(t, cols) }) });
