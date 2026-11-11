'use strict';

// The model manifest at runtime (CCME R2; the manifest itself is lib/manifest.js). At startup it loads
// rimpl/src/model-manifest.json, verifies its sha256 and compares its expected.code with what THIS build's
// code computes (code_match). On demand it builds the LIVE view — what env and app_settings actually
// resolve to now, and what the on-prem servers last said they were — and the drift between the two.
//
// WARN-ONLY, BY DESIGN. Production runs every purpose on anthropic today while the declared target is
// on-prem, so drift is the expected state until CCME R1 / R3 close. The /health/deep check is therefore
// `warn` (served, reported, never 503: backend reads 503 as "rimpl is down"), never `down`. Nothing here
// changes routing, refuses a call or fails a boot; the lock that acts on it is backend-side (PR 6b).
//
// NO FREE TEXT ON THE PUBLIC ENDPOINT. /health/deep is unauthenticated, so its block carries no string an
// operator or a server supplied: a configured or reported model id and a system_fingerprint appear only
// as live_present + live_sha256_12 (lib/manifest.js publicDrift); only fixed-vocabulary values, numbers
// and the code's / declared file's expectations are printed. The raw values are GET /manifest's, behind
// the internal token. Defence in depth on both: a base URL is never read into the live view at all
// (present/absent only, providers/local-factory.js configured()), and every string is passed through
// lib/manifest.js redactDeep. tests/manifest-health.test.js greps the whole body for addresses, keys and
// sentinel model ids / fingerprints.
//
// Reads, never calls: no provider is probed here, no model is called, nothing is written.
const M = require('../lib/manifest');
const ai = require('./ai');
const settings = require('./provider-settings');
const { LOCAL_INSTANCES } = require('../lib/provider-policy');
const D = require('../lib/decoding');
const C = require('../lib/consistency-config');
const T = require('../lib/turn-limits');

// Loaded once: the file ships in the image (Dockerfile COPY src) and does not change under a process.
// The code half is computed once too — it is a pure function of the loaded modules. Neither may take the
// process down: a broken manifest is a finding to report, not a reason to refuse to serve.
const loaded = M.readManifest();
let codeNow = null;
let codeError = null;
try { codeNow = M.expectedCode(); } catch (e) { codeError = e?.message || String(e); }

function codeMatch() {
  if (loaded.file === 'missing' || !loaded.manifest) return null;
  if (loaded.file !== 'present' || !codeNow) return false;
  return M.canonicalJson(loaded.manifest.expected?.code ?? null) === M.canonicalJson(codeNow);
}

const safe = (fn, fallback = null) => { try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; } };

// What this process would do right now. Every field is read the way the code that acts on it reads it.
function liveSnapshot() {
  const purposes = [...(ai.PURPOSES ?? [])];
  const providers = Object.fromEntries(purposes.map((p) => [p, safe(() => ai.providerNameFor(p))]));
  providers.embed = safe(() => ai.embedProviderName());
  // services/shadow.js shadowTarget: null when off, or when the named provider is refused.
  providers.shadow = safe(() => require('./shadow').shadowTarget(providers.evaluate));

  const local = {};
  for (const name of Object.keys(LOCAL_INSTANCES)) {
    const impl = ai.PROVIDERS?.[name];
    local[name] = {
      configured: safe(() => impl?.configured?.()),
      lastSeen: safe(() => impl?.lastSeen?.()),
    };
  }
  const per = (pick) => Object.fromEntries(Object.keys(LOCAL_INSTANCES).map((n) => [n, pick(local[n])]));

  return M.redactDeep({
    routing_source: safe(() => settings.status().source),
    evaluator_locked_at: safe(() => settings.evaluatorLockedAt()),
    providers,
    // The id the Anthropic PROVIDER would send (providers/anthropic.js model()), not the policy constant
    // the manifest was built from — comparing that constant with itself could never drift.
    models: { anthropic: safe(() => ai.PROVIDERS?.anthropic?.model?.()), ...per((l) => l.configured?.model ?? null) },
    base_url: per((l) => l.configured?.base_url ?? null),
    last_seen: per((l) => l.lastSeen ?? null),
    decoding: {
      evaluate: { temperature: D.EVAL_DECODING.temperature, max_tokens: D.EVAL_DECODING.maxTokens },
      shadow: { temperature: D.SHADOW_DECODING.temperature, max_tokens: D.shadowMaxTokens() },
      criteria: { temperature: D.CRITERIA_DECODING.temperature, max_tokens: D.CRITERIA_DECODING.maxTokens },
      discuss: { temperature: D.DISCUSS_DECODING.temperature, max_tokens: D.discussMaxTokens() },
      chat: {
        temperature: D.CHAT_DECODING.temperature,
        fast_max_tokens: T.CHAT_MAX_TOKENS,
        deep_max_tokens: T.CHAT_DEEP_MAX_TOKENS,
        evidence_line_max_tokens: T.EVIDENCE_LINE_MAX_TOKENS,
      },
      num_ctx: per((l) => l.configured?.num_ctx ?? null),
      // Per endpoint, the floors that raise max_tokens above the values above. Present only when set.
      ...(Object.values(local).some((l) => l.configured?.max_tokens_floor)
        ? { max_tokens_floor: per((l) => l.configured?.max_tokens_floor ?? null) } : {}),
    },
    consistency: {
      evaluate_mode: C.consistencyModeFor('local'),
      max_sum_delta: C.maxSumDelta(),
      json_retries: C.jsonRetries(),
      shadow_mode: C.shadowConsistencyMode(),
    },
    thinking_style: per((l) => l.configured?.thinking_style ?? null),
  });
}

function report() {
  const live = liveSnapshot();
  return {
    file: loaded.file,
    sha256: loaded.sha256,
    claimed_sha256: loaded.claimed_sha256,
    code_match: codeMatch(),
    live,
    drift: M.driftOf(loaded.file === 'present' ? loaded.manifest : null, live),
  };
}

// The /health/deep block, and its check. `up` only when the file is present and verified, its code half
// is this build's, and nothing differs; `warn` otherwise, with a one-line reason. Never `down`.
//   sha256          the VERIFIED content address; null unless file is 'present' (lib/manifest.js readManifest)
//   claimed_sha256  what the file says its hash is — equal to sha256 when present, the bare claim otherwise
//   drift           the PUBLIC form (lib/manifest.js publicDrift): a free-text live value (a model id, a
//                   fingerprint) appears only as live_present + live_sha256_12. GET /manifest has it raw.
function health() {
  const r = report();
  const block = { sha256: r.sha256, claimed_sha256: r.claimed_sha256, file: r.file, code_match: r.code_match, drift: M.publicDrift(r.drift) };
  const reasons = [];
  if (r.file === 'missing') reasons.push('rimpl/src/model-manifest.json is missing from this build');
  if (r.file === 'invalid') reasons.push(`rimpl/src/model-manifest.json is invalid (${loaded.error})`);
  if (codeError) reasons.push(`this build could not compute its own manifest (${codeError})`);
  else if (r.code_match === false && r.file === 'present') reasons.push('the committed manifest is not what this build\'s code generates — regenerate it (node scripts/manifest/build.mjs)');
  if (r.drift.length) reasons.push(`${r.drift.length} live value(s) differ from the manifest (declared target or code defaults) — see manifest.drift`);
  const check = reasons.length ? { status: 'warn', warning: `model manifest: ${reasons.join('; ')}` } : { status: 'up' };
  return { block, check };
}

module.exports = { liveSnapshot, report, health, codeMatch, loaded };
