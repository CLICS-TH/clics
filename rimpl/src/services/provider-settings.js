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

// ---------------------------------------------------------------------------------------------
// PROVIDER_SETTINGS_SOURCE — where this process READS its routing from.
//
//   database (default / unset)  app_settings.ai_provider_* layered over env — everything below.
//   env                         the database is never constructed, never consulted: routing falls
//                               through to AI_PROVIDER_<PURPOSE> / AI_PROVIDER exactly as if no rows
//                               existed, ensureFresh() is a no-op, and status() says so (`override`).
//
// `env` exists for ONE situation: a laptop `npm run dev` stack pointed at the SHARED (production)
// database — the sandbox smoke — whose app_settings say `anthropic` and must be neither obeyed nor
// written. It is a dev-only override, so it is REFUSED IN PRODUCTION at module load: a deployment
// that quietly ignored the superadmin toggle would be exactly the silently-relocated routing this
// module exists to prevent. Same production predicate as src/index.js, duplicated verbatim rather
// than imported — requiring index.js here would boot the whole app — so there is ONE definition of
// "production" to keep in step. Any value other than the two above throws too: a typo must not
// quietly mean "database".
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
const SOURCE = String(process.env.PROVIDER_SETTINGS_SOURCE ?? '').trim().toLowerCase() || 'database';
if (SOURCE !== 'database' && SOURCE !== 'env') {
  throw new Error(`PROVIDER_SETTINGS_SOURCE="${process.env.PROVIDER_SETTINGS_SOURCE}" is not valid — use "database" (default) or "env"`);
}
if (SOURCE === 'env' && IS_PROD) {
  throw new Error('PROVIDER_SETTINGS_SOURCE=env is refused in production: routing must follow app_settings (the superadmin toggle) there — unset it');
}
const ENV_ONLY = SOURCE === 'env';
if (ENV_ONLY) {
  console.warn('[provider-settings] PROVIDER_SETTINGS_SOURCE=env — app_settings.ai_provider_* is IGNORED on this box; routing follows AI_PROVIDER_<PURPOSE> / AI_PROVIDER only (dev-only override, refused in production)');
}

// Keys are ai_provider_<purpose>; the purpose list itself lives in services/ai.js (PURPOSES), which
// passes it in — this module must not own a second, drifting copy of it.
const keyFor = (purpose) => `ai_provider_${String(purpose).toLowerCase()}`;

// Operational settings that are NOT per-purpose provider names but must still be changeable without
// a redeploy. Read in the same round trip as the overrides — a second query on the same TTL would be
// pure waste, and a second cache would be a second thing that can go stale differently.
const NUMBER_KEYS = ['local_ai_min_context', 'rag_enabled'];

let cache = { values: {}, numbers: {}, lockedAt: null, fetchedAt: 0, loaded: false };
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
  // The override: no client is ever constructed, so no read can happen — not one that is ignored.
  if (ENV_ONLY) return null;
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
    const keys = [...purposes.map(keyFor), 'evaluator_locked_at', ...NUMBER_KEYS];
    const { data, error } = await sb.from('app_settings').select('key, value_text').in('key', keys);
    if (error) throw new Error(error.message);

    const values = {};
    const numbers = {};
    let lockedAt = null;
    for (const row of data || []) {
      const text = typeof row.value_text === 'string' ? row.value_text.trim().toLowerCase() : '';
      if (row.key === 'evaluator_locked_at') {
        // Kept as stored (not lowercased) — it is an ISO timestamp, reported not compared.
        lockedAt = typeof row.value_text === 'string' && row.value_text.trim() ? row.value_text.trim() : null;
        continue;
      }
      if (NUMBER_KEYS.includes(row.key)) {
        // A non-numeric or blank value_text is NOT an override — it falls through to env, the same
        // fail-soft rule the provider names follow. Coercing it to 0 would silently disable a floor
        // whose whole job is to refuse an undersized server.
        const n = parseInt(text, 10);
        if (Number.isFinite(n) && n > 0) numbers[row.key] = n;
        continue;
      }
      // An empty/NULL value_text means "no override" — fall through to env. This is what lets a
      // superadmin hand a purpose BACK to env control without deleting the row.
      if (text) values[row.key] = text;
    }
    cache = { values, numbers, lockedAt, fetchedAt: Date.now(), loaded: true };
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
 *               for `evaluate` that would mean scoring one PLE on the wrong model.
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

// SYNC. A numeric operational override, or undefined to mean "env decides". Same contract as
// overrideFor: the caller supplies the fallback, this layer never invents a default of its own.
function numberFor(key) {
  return cache.numbers[key];
}

// The pilot's evaluator lock, as stored (ISO string) or null. Enforced backend-side, where the write
// happens; exposed here so /health/deep can report whether the instrument is frozen.
function evaluatorLockedAt() {
  return cache.lockedAt;
}

// For /health/deep: whether the override layer is live, and how stale it is. A deployment that
// THINKS it is DB-controlled but is silently running on env should be visible, not inferred.
function status() {
  // `override` is the field the sandbox smoke gates on: it refuses to run unless this box PROVES it
  // is ignoring the shared database's settings. `source: 'env'` alone cannot say that — it is also
  // what a box with no credentials, or one whose first read has not landed yet, reports.
  if (ENV_ONLY) return { source: 'env', override: true, reason: 'PROVIDER_SETTINGS_SOURCE=env' };
  if (!client()) return { source: 'env', override: false, reason: 'no database credentials' };
  return {
    source: cache.loaded ? 'database' : 'env',
    override: false,
    ...(cache.loaded
      ? { age_ms: Date.now() - cache.fetchedAt, overrides: { ...cache.values, ...cache.numbers } }
      : { reason: 'not yet read' }),
  };
}

function __resetForTests() {
  cache = { values: {}, numbers: {}, lockedAt: null, fetchedAt: 0, loaded: false };
  inflight = null;
  warnedAt = 0;
}

module.exports = { ensureFresh, overrideFor, numberFor, evaluatorLockedAt, refresh, status, keyFor, NUMBER_KEYS, __resetForTests };
