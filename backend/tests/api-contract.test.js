// Every API path the audit-dashboard calls must exist on the app the backend actually starts.
//
// WHY THIS EXISTS. Three admin screens shipped calling `/superadmin/...` while `routes/superadmin.js`
// is mounted at `/admin` (src/index.js). Every request 404'd, and because lib/api.ts's apiFetch
// resolves an {error} envelope instead of throwing, the screens rendered as "could not reach" rather
// than as a broken build. It survived review, tsc, lint and the whole suite.
//
// The reason no test caught it is the point: every route test builds its OWN express app and picks
// its own mount prefix, so `app.use('/superadmin', superadminRouter)` and `app.use('/admin', ...)`
// are both green. Only src/index.js decides what production serves, and nothing compared the two.
//
// So this reads the REAL app's route table — no HTTP, no mocks, no handlers executed — and the
// dashboard's call sites, and asserts every call has somewhere to land.
const path = require('path');
const fs = require('fs');

// The app is required for its route table only. NODE_ENV=test already suppresses the reconcile
// timer, and index.js only listens under `require.main === module`.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost/stub';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';
const app = require('../src/index');

const DASHBOARD = path.join(__dirname, '..', '..', 'audit-dashboard');
const SCAN_DIRS = ['app', 'components', 'lib'];

// --- the app's route table -----------------------------------------------------------------------

// `^\/admin\/?(?=\/|$)` -> `/admin`. Express builds these itself, so the shape is stable; anything
// that does not match is a mount we do not understand and is reported rather than silently skipped.
function mountPrefix(re) {
  const m = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(re.source);
  return m ? `/${m[1].replace(/\\\//g, '/')}` : null;
}

// Segment-by-segment, because BOTH sides can carry a hole. `:id` in the route matches any one
// segment; so does `${action}` in the call, whose value ('approve' | 'reject') is not knowable from
// the source. Comparing rendered strings instead would report `/admin/auditor-requests/x/x` as an
// orphan when both real paths exist. What stays checkable — segment COUNT and every literal segment,
// the mount prefix above all — is exactly what the bug this file guards got wrong.
const WILDCARD = '\u0000';                          // stands in for an interpolated call segment

function segmentsMatch(routePath, callPath) {
  const a = routePath.split('/');
  const b = callPath.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || b[i] === WILDCARD || seg === b[i]);
}

function routeTable() {
  const router = app._router || app.router;
  if (!router) throw new Error('could not read the express route table — check the express version');
  const out = [];
  for (const layer of router.stack) {
    if (layer.route) {
      out.push(layer.route.path);
      continue;
    }
    const nested = layer.handle && layer.handle.stack;
    if (!nested) continue;                       // rate limiters, body parser, CORS, error handlers
    const prefix = mountPrefix(layer.regexp);
    if (prefix == null) continue;                // app-level middleware, mounted at '/'
    for (const sub of nested) {
      if (!sub.route) continue;
      const full = `${prefix}${sub.route.path === '/' ? '' : sub.route.path}`;
      out.push(full);
    }
  }
  return out;
}

// --- the dashboard's call sites ------------------------------------------------------------------

function sourceFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// apiFetch / apiFetchPaged / apiDownload, first argument, single-quoted or a template literal.
const CALL = /api(?:Fetch|FetchPaged|Download)(?:<[^(]*>)?\(\s*(`[^`]*`|'[^']*')/g;

// `/admin/users/${u.id}/status?x=1` -> `/admin/users/<wildcard>/status`. An interpolation is one path
// segment (nobody builds `${a}/${b}` here), and a query string is not part of the route.
function normalize(literal) {
  return literal
    .slice(1, -1)
    .replace(/\$\{[^}]*\}/g, WILDCARD)
    .split('?')[0]
    .replace(/\/+$/, '') || '/';
}

function dashboardPaths() {
  const seen = new Map();                        // path -> the file it was first seen in
  for (const dir of SCAN_DIRS) {
    const abs = path.join(DASHBOARD, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(CALL)) {
        const p = normalize(m[1]);
        if (!seen.has(p)) seen.set(p, path.relative(DASHBOARD, file));
      }
    }
  }
  return seen;
}

// --- the assertions ------------------------------------------------------------------------------

describe('audit-dashboard → backend API contract', () => {
  const routes = routeTable();
  const calls = dashboardPaths();

  test('the route table was actually read', () => {
    // A silent zero here would make every assertion below vacuously pass, which is the failure mode
    // this whole file exists to prevent.
    expect(routes.length).toBeGreaterThan(50);
    expect(routes).toContain('/admin/ai-readiness');
  });

  test('the dashboard sources were actually read', () => {
    expect(fs.existsSync(DASHBOARD)).toBe(true);
    expect(calls.size).toBeGreaterThan(40);
  });

  test('every path the dashboard calls exists on the app src/index.js starts', () => {
    const orphans = [];
    for (const [p, file] of calls) {
      if (!routes.some((r) => segmentsMatch(r, p))) orphans.push(`${p.replace(/\u0000/g, '*')}  (called from ${file})`);
    }
    expect(orphans).toEqual([]);
  });

  test('a wrong mount prefix is caught', () => {
    // Mutation check: the exact bug this file was written for must fail the matcher above.
    expect(routes.some((r) => segmentsMatch(r, '/superadmin/ai-readiness'))).toBe(false);
    expect(routes.some((r) => segmentsMatch(r, '/admin/ai-readiness'))).toBe(true);
    // and a wrong segment count is not quietly absorbed by a :param
    expect(routes.some((r) => segmentsMatch(r, '/admin/ai-readiness/extra'))).toBe(false);
  });
});
