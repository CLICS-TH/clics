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
// It is asked EVERY time, healthy or not, so exit 2 always means the token was accepted: rimpl's
// /health/deep is 503 whenever any one dependency is down (Supabase, an exhausted Anthropic balance, an
// unreachable local box), and the caller must be able to tell that from a token that is refused. A
// degraded rimpl answers 500/503 on /evaluate, which the drain retries; only the 401 is the damage.
//
// `backend` runs after it starts: /health/deep must report service "backend" (a rimpl image answering
// on the backend's port is how prod went down on 2026-10-14), rimpl up and Supabase up.
//
// Prints check names and statuses only, never env values. Exit codes:
//   0  pass (rimpl: healthy AND the token accepted)
//   2  rimpl accepted INTERNAL_TOKEN but its /health/deep is degraded; the last line names the checks
//      that are down, after "; down: " (deploy/vm1/remote/activate.sh quotes them). activate refuses a
//      deploy on 2, and its restore() starts the live release's backend on 2 (token proven).
//   3  INTERNAL_TOKEN mismatch (rimpl answered 401 or 403 on GET /manifest)
//   4  GET /manifest refused for another reason
//   5  backend gate failed
//   6  request failed (rimpl or the backend could not be reached)
//   7  the token was accepted, but /health/deep at RIMPL_URL does not report service "rimpl" (not rimpl,
//      or not answering as rimpl): never read as "rimpl degraded"
//   64 usage
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

// `name=status` for each check that is neither up nor warn: names and statuses only, never the error
// text (it can quote a host or a provider's reply).
function downChecks(checks) {
  if (!checks || typeof checks !== 'object') return '(no checks reported)';
  const down = Object.entries(checks)
    .filter(([, c]) => !c || (c.status !== 'up' && c.status !== 'warn'))
    .map(([name, c]) => `${name}=${c && c.status ? c.status : '?'}`);
  return down.length ? down.join(', ') : '(none reported down)';
}

async function gateRimpl() {
  const base = process.env.RIMPL_URL;
  const token = process.env.INTERNAL_TOKEN;
  if (!base) { console.error('[gate] RIMPL_URL is not set in the backend container'); return 64; }
  if (!token) { console.error('[gate] INTERNAL_TOKEN is not set in backend.env'); return 64; }

  const deep = await getJson(`${base}/health/deep`);
  const b = deep.body || {};
  const healthy = deep.status === 200 && b.service === 'rimpl';
  const deepLine = `/health/deep HTTP ${deep.status}, service=${b.service}, status=${b.status}`;

  // Asked whether or not /health/deep is healthy (see the top of this file).
  const manifest = await getJson(`${base}/manifest`, { 'x-internal-token': token });
  if (manifest.status === 401 || manifest.status === 403) {
    // What happens next (backend not started, or stopped) is the caller's to say: this only reports.
    console.error(`[gate] INTERNAL_TOKEN in backend.env does not match the one rimpl runs with (rimpl answered ${manifest.status}). rimpl ${deepLine}`);
    return 3;
  }
  if (manifest.status !== 200) {
    console.error(`[gate] rimpl GET /manifest: HTTP ${manifest.status}. rimpl ${deepLine}`);
    return 4;
  }
  console.log('[gate] INTERNAL_TOKEN matches: rimpl accepted it on GET /manifest');
  if (b.service !== 'rimpl') {
    console.error(`[gate] /health/deep at RIMPL_URL does not report service "rimpl": ${deepLine}`);
    return 7;
  }
  if (!healthy) {
    // Keep this line's shape: activate.sh reads the checks after "; down: ".
    console.error(`[gate] rimpl is DEGRADED: ${deepLine}; down: ${downChecks(b.checks)}`);
    return 2;
  }
  const sha = b.manifest && b.manifest.sha256;
  console.log(`[gate] rimpl /health/deep ok; ${summary(b.checks)}; rimpl manifest sha256 ${sha || '(unverified)'}`);
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

module.exports = { main, summary, downChecks };
