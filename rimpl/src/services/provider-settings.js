// DB-backed provider overrides — the layer that turns "which model serves this purpose" from a
// redeploy into a superadmin toggle.
//
// It sits ON TOP of the env resolution in services/ai.js:
//   app_settings.ai_provider_<purpose>  →  AI_PROVIDER_<PURPOSE>  →  AI_PROVIDER  →  'anthropic'
//
// THREE PROPERTIES THIS MODULE EXISTS TO GUARANTEE:
//
//   1. The accessor is SYNCHRONOUS. services/ai.js's providerNameFor() is sync and is called from
//      shadow.js's "don't shadow the model that already served" guard and from /health/deep. Making
//      it async would ripple into both; making the DB read async but the accessor sync means the
//      override has to be CACHED, which is what this module is.
//
//   2. It fails SOFT to env, never to a hardcoded default. A database blip must leave the deployment
//      running exactly where its env says — the alternative is PIS-7 scoring silently relocating to
//      a different model mid-cohort, which is the one failure this whole design exists to prevent.
//      So a failed refresh keeps the LAST KNOWN GOOD values rather than clearing them.
//
//   3. It never reads the DB per call. Every physician turn goes through providerNameFor(); a
//      per-call round trip would put a database on the hot path of every message.
const TTL_DEFAULT_MS = 15000;

// Keys are ai_provider_<purpose>; the purpose list itself lives in services/ai.js (PURPOSES), which
// passes it in — this module must not own a second, drifting copy of it.
const keyFor = (purpose) => `ai_provider_${String(purpose).toLowerCase()}`;

let cache = { values: {}, lockedAt: null, fetchedAt: 0, loaded: false };
let inflight = null;
let warnedAt = 0;

function ttlMs() {
  const n = parseInt(process.env.PROVIDER_SETTINGS_TTL_MS, 10);
  return Number.isFinite(n) && n >= 1000 ? n : TTL_DEFAULT_MS;
}

// Required lazily and guarded on env: lib/supabase.js constructs its client at module load, which
// THROWS when SUPABASE_URL is unset. services/ai.js is required by every route and by the hermetic
// test suites, so an eager require here would make an unconfigured process fail to boot instead of
// simply having no override layer. No credentials → no override → env decides. That is the
// documented fail-soft path, not a degraded one.
function client() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    return require('../lib/supabase').supabase;
  } catch {
    return null;
  }
}

// Never throws, never rejects. Returns true if the cache now holds DB-sourced values.
async function refresh(purposes) {
  const sb = client();
  if (!sb) return false;
  try {
    const keys = [...purposes.map(keyFor), 'evaluator_locked_at'];
    const { data, error } = await sb.from('app_settings').select('key, value_text').in('key', keys);
    if (error) throw new Error(error.message);

    const values = {};
    let lockedAt = null;
    for (const row of data || []) {
      const text = typeof row.value_text === 'string' ? row.value_text.trim().toLowerCase() : '';
      if (row.key === 'evaluator_locked_at') {
        // Kept as stored (not lowercased) — it is an ISO timestamp, reported not compared.
        lockedAt = typeof row.value_text === 'string' && row.value_text.trim() ? row.value_text.trim() : null;
        continue;
      }
      // An empty/NULL value_text means "no override" — fall through to env. This is what lets a
      // superadmin hand a purpose BACK to env control without deleting the row.
      if (text) values[row.key] = text;
    }
    cache = { values, lockedAt, fetchedAt: Date.now(), loaded: true };
    return true;
  } catch (e) {
    // Rate-limit the log: this runs on a TTL, and a sustained outage would otherwise write a line
    // every 15s forever. The condition still surfaces — /health/deep reports the cache's staleness.
    const now = Date.now();
    if (now - warnedAt > 60000) {
      warnedAt = now;
      console.warn(`[provider-settings] could not read app_settings — keeping ${cache.loaded ? 'last known good' : 'env-only'} resolution: ${e?.message || e}`);
    }
    return false;
  }
}

/**
 * Make sure the cache is usable, without putting a DB read on every call.
 *
 * Cold cache  → AWAIT one read. The first request after a restart must not ignore a DB override;
 *               for `evaluate` that would mean scoring one CLE on the wrong model.
 * Warm+stale  → refresh in the BACKGROUND and answer from cache. Bounded staleness (TTL) is the
 *               price of keeping the hot path off the database.
 * Warm+fresh  → nothing.
 */
async function ensureFresh(purposes) {
  if (!client()) return;
  const age = Date.now() - cache.fetchedAt;
  if (cache.loaded && age < ttlMs()) return;

  if (!inflight) {
    inflight = refresh(purposes).finally(() => { inflight = null; });
  }
  if (!cache.loaded) await inflight;   // cold start: correctness beats latency, once
  else inflight.catch(() => {});       // warm: never block, never leave an unhandled rejection
}

// SYNC. Returns the DB override for a purpose, or undefined to mean "env decides".
function overrideFor(purpose) {
  return purpose ? cache.values[keyFor(purpose)] : undefined;
}

// The pilot's evaluator lock, as stored (ISO string) or null. Enforced backend-side, where the write
// happens; exposed here so /health/deep can report whether the instrument is frozen.
function evaluatorLockedAt() {
  return cache.lockedAt;
}

// For /health/deep: whether the override layer is live, and how stale it is. A deployment that
// THINKS it is DB-controlled but is silently running on env should be visible, not inferred.
function status() {
  if (!client()) return { source: 'env', reason: 'no database credentials' };
  return {
    source: cache.loaded ? 'database' : 'env',
    ...(cache.loaded ? { age_ms: Date.now() - cache.fetchedAt, overrides: { ...cache.values } } : { reason: 'not yet read' }),
  };
}

function __resetForTests() {
  cache = { values: {}, lockedAt: null, fetchedAt: 0, loaded: false };
  inflight = null;
  warnedAt = 0;
}

module.exports = { ensureFresh, overrideFor, evaluatorLockedAt, refresh, status, keyFor, __resetForTests };
