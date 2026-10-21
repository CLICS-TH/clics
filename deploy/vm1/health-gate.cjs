// deploy.sh's health gates, run INSIDE the backend image on the compose network, so they see exactly
// the env and the network the backend sees:
//
//   docker compose run --rm --no-deps -T -v "$PWD/health-gate.cjs:/gate.cjs:ro" backend node /gate.cjs rimpl
//   docker compose run --rm --no-deps -T -v "$PWD/health-gate.cjs:/gate.cjs:ro" backend node /gate.cjs backend
//
// `rimpl` runs BEFORE the backend starts. It matters because the evaluation drain claims real queued
// PLEs the moment the backend boots (backend/src/services/eval-drain.js:180), and a 401 from rimpl is
// classed as deterministic (backend/src/services/rimpl-client.js:70), which sends each claimed PLE
// straight to manual QA. A mismatched INTERNAL_TOKEN would therefore do damage before any health check
// noticed. GET /manifest is behind the token and makes no AI call, so it proves the token for free.
//
// `backend` runs after it starts: /health/deep must report service "backend" (a rimpl image answering
// on the backend's port is how prod went down on 2026-10-14), rimpl up and Supabase up.
//
// Prints check names and statuses only, never env values. Exit codes: 0 pass, 2 rimpl not healthy,
// 3 INTERNAL_TOKEN mismatch, 4 manifest refused for another reason, 5 backend gate failed,
// 6 request failed, 64 usage.
'use strict';

const TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS || 15000);

function summary(checks) {
  if (!checks || typeof checks !== 'object') return '(no checks reported)';
  return Object.entries(checks)
    .map(([name, c]) => `${name}=${c && c.status ? c.status : '?'}${c && c.error ? ` (${String(c.error).slice(0, 160)})` : ''}`)
    .join(', ');
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function gateRimpl() {
  const base = process.env.RIMPL_URL;
  const token = process.env.INTERNAL_TOKEN;
  if (!base) { console.error('[gate] RIMPL_URL is not set in the backend container'); return 64; }
  if (!token) { console.error('[gate] INTERNAL_TOKEN is not set in backend.env'); return 64; }

  const deep = await getJson(`${base}/health/deep`);
  if (deep.status !== 200 || !deep.body || deep.body.service !== 'rimpl') {
    console.error(`[gate] rimpl /health/deep: HTTP ${deep.status}, service=${deep.body && deep.body.service}; ${summary(deep.body && deep.body.checks)}`);
    return 2;
  }
  console.log(`[gate] rimpl /health/deep ok; ${summary(deep.body.checks)}`);

  const manifest = await getJson(`${base}/manifest`, { 'x-internal-token': token });
  if (manifest.status === 401) {
    // What happens next (backend not started, or stopped) is the caller's to say: this only reports.
    console.error('[gate] INTERNAL_TOKEN in backend.env does not match the one rimpl runs with (rimpl answered 401).');
    return 3;
  }
  if (manifest.status !== 200) {
    console.error(`[gate] rimpl GET /manifest: HTTP ${manifest.status}`);
    return 4;
  }
  const sha = deep.body.manifest && deep.body.manifest.sha256;
  console.log(`[gate] INTERNAL_TOKEN matches; rimpl manifest sha256 ${sha || '(unverified)'}`);
  return 0;
}

async function gateBackend() {
  const base = process.env.BACKEND_URL || 'http://backend:3001';
  const deep = await getJson(`${base}/health/deep`);
  const b = deep.body || {};
  const checks = b.checks || {};
  const line = `HTTP ${deep.status}, service=${b.service}, status=${b.status}; ${summary(checks)}`;
  if (b.service !== 'backend' || !checks.rimpl || checks.rimpl.status !== 'up' || !checks.supabase || checks.supabase.status !== 'up') {
    console.error(`[gate] backend /health/deep FAILED: ${line}`);
    return 5;
  }
  // Overall `degraded` can be about the queue, the audit chain or the model lock, none of which a
  // deploy changes. Report it loudly; do not undo a deploy over it.
  if (deep.status !== 200) console.warn(`[gate] WARNING: backend /health/deep is ${b.status} for a reason other than service/rimpl/supabase: ${line}`);
  else console.log(`[gate] backend /health/deep ok: ${line}`);
  const sha = checks.rimpl.deep && checks.rimpl.deep.manifest && checks.rimpl.deep.manifest.sha256;
  if (sha) console.log(`[gate] evaluator manifest sha256 ${sha} (compare with Railway's /health/deep while both run)`);
  return 0;
}

async function main(mode) {
  if (mode === 'rimpl') return gateRimpl();
  if (mode === 'backend') return gateBackend();
  console.error('usage: node health-gate.cjs rimpl|backend');
  return 64;
}

if (require.main === module) {
  main(process.argv[2])
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`[gate] request failed: ${e && e.message ? e.message : e}`); process.exit(6); });
}

module.exports = { main, summary };
