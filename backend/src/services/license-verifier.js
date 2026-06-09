// License verification — pluggable adapter behind a stable contract.
//
//   getVerifier().verify({ license_number, full_name_th, full_name_en })
//     -> { status, source, checked_at, evidence }
//        status ∈ 'verified' | 'not_found' | 'name_mismatch' | 'unavailable'
//
// Adapter is chosen by LICENSE_VERIFIER_ADAPTER ('stub' | 'tmc_scrape', default 'stub').
// This service is L2-only: it is NEVER called from RIMPL/cloud. The 'tmc_scrape' adapter
// talks ONLY to the dedicated scraper microservice (LICENSE_VERIFIER_URL), which in turn
// queries The Medical Council of Thailand's own public site — a sanctioned, scoped egress.
//
// The fragile real source is fully isolated: cache + single-flight + circuit-breaker mean a
// down/slow scraper degrades to 'unavailable' fast, and nothing else depends on it being up.
const { supabase } = require('../lib/supabase');
const { encryptJson } = require('../lib/crypto');

const ADAPTER = process.env.LICENSE_VERIFIER_ADAPTER || 'stub';
const STATUSES = ['verified', 'not_found', 'name_mismatch', 'unavailable'];
const now = () => new Date().toISOString();

// ---- stub adapter (pure, deterministic — for tests + pre-scraper phases) -----------------
// Rules keyed off the license string so tests are stable with no network/clock:
//   'UNAVAIL'            -> unavailable
//   last digit 0/2/4/6/8 -> verified
//   last digit 1/3       -> name_mismatch
//   last digit 5/7/9     -> not_found
//   anything else        -> unavailable
function stubVerify({ license_number, full_name_th, full_name_en }) {
  const lic = String(license_number || '').trim();
  let status = 'unavailable';
  if (lic === 'UNAVAIL') status = 'unavailable';
  else {
    const d = lic.slice(-1);
    if ('02468'.includes(d)) status = 'verified';
    else if ('13'.includes(d)) status = 'name_mismatch';
    else if ('579'.includes(d)) status = 'not_found';
  }
  return {
    status, source: 'stub', checked_at: now(),
    evidence: { adapter: 'stub', license: lic, name: full_name_th || full_name_en || null },
  };
}

// ---- tmc_scrape adapter (HTTP client to the scraper microservice) -------------------------
// Resilience lives HERE so the rest of the system only sees the contract:
//   - in-process TTL cache keyed by license_number
//   - single-flight (concurrent identical lookups share one request)
//   - circuit breaker (N consecutive failures -> 'unavailable' fast for a cooldown window)
const SCRAPE_URL      = process.env.LICENSE_VERIFIER_URL || 'http://localhost:3004';
const SCRAPE_TIMEOUT  = parseInt(process.env.LICENSE_SCRAPE_TIMEOUT_MS || '20000', 10);
const CACHE_TTL       = parseInt(process.env.LICENSE_CACHE_TTL_MS || '21600000', 10); // 6h
const CB_THRESHOLD    = parseInt(process.env.LICENSE_CB_THRESHOLD || '5', 10);
const CB_COOLDOWN     = parseInt(process.env.LICENSE_CB_COOLDOWN_MS || '300000', 10); // 5m

const _cache = new Map();      // license_number -> { result, expires }
const _inflight = new Map();   // license_number -> Promise<result>
const _cb = { failures: 0, openUntil: 0 };

function _epoch() { return Date.parse(now()); }

async function _scrapeOnce({ license_number, full_name_th, full_name_en }) {
  const res = await fetch(`${SCRAPE_URL}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ license_number, full_name_th, full_name_en }),
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT),
  });
  if (!res.ok) throw new Error(`scraper /verify ${res.status}`);
  const body = await res.json();
  if (!STATUSES.includes(body.status)) throw new Error(`scraper bad status: ${body.status}`);
  return body; // { status, evidence? }
}

async function tmcScrapeVerify(input) {
  const lic = String(input.license_number || '').trim();
  const t = _epoch();

  const cached = _cache.get(lic);
  if (cached && cached.expires > t) return { ...cached.result, checked_at: now(), evidence: { ...cached.result.evidence, cached: true } };

  // Breaker open -> fail fast, do NOT touch the scraper.
  if (_cb.openUntil > t) {
    return { status: 'unavailable', source: 'tmc_scrape', checked_at: now(), evidence: { reason: 'circuit_open' } };
  }

  if (_inflight.has(lic)) return _inflight.get(lic);

  const p = (async () => {
    try {
      const body = await _scrapeOnce(input);
      _cb.failures = 0;
      const result = { status: body.status, source: 'tmc_scrape', checked_at: now(), evidence: body.evidence ?? { adapter: 'tmc_scrape' } };
      // Cache only definitive answers (not 'unavailable').
      if (body.status !== 'unavailable') _cache.set(lic, { result, expires: _epoch() + CACHE_TTL });
      return result;
    } catch (e) {
      _cb.failures += 1;
      if (_cb.failures >= CB_THRESHOLD) _cb.openUntil = _epoch() + CB_COOLDOWN;
      return { status: 'unavailable', source: 'tmc_scrape', checked_at: now(), evidence: { reason: 'scrape_error', message: e.message } };
    } finally {
      _inflight.delete(lic);
    }
  })();
  _inflight.set(lic, p);
  return p;
}

function getVerifier() {
  if (ADAPTER === 'tmc_scrape') return { verify: tmcScrapeVerify };
  return { verify: (input) => Promise.resolve(stubVerify(input)) };
}

// Map a verify status -> the professionals.license_status enum value.
function toLicenseStatus(verifyStatus) {
  return verifyStatus === 'verified' ? 'verified'
    : verifyStatus === 'name_mismatch' ? 'name_mismatch'
    : verifyStatus === 'not_found' ? 'not_found'
    : 'unverified'; // 'unavailable' (or anything unexpected) -> stays unverified, for review
}

// Persist an attempt to license_verifications (PII evidence encrypted at rest). Best-effort:
// a logging failure must never block provisioning.
async function recordVerification({ professional_id = null, license_number, name_checked, result }) {
  try {
    await supabase.from('license_verifications').insert({
      professional_id,
      license_number,
      name_checked: name_checked ?? null,
      status: result.status,
      source: result.source,
      evidence_encrypted: result.evidence ? encryptJson(result.evidence) : null,
      checked_at: result.checked_at,
    });
  } catch (e) {
    console.error('[license-verifier] recordVerification failed:', e.message);
  }
}

// Test-only: reset the in-process cache/breaker between cases.
function _resetState() { _cache.clear(); _inflight.clear(); _cb.failures = 0; _cb.openUntil = 0; }

module.exports = { getVerifier, toLicenseStatus, recordVerification, ADAPTER, _resetState, stubVerify };
