// Which councils the evaluation drain may touch.
//
// Two scopes, for one reason: during the local-AI sandbox smoke a LAPTOP stack (rimpl on the tailnet,
// evaluator = the on-prem model) shares the production database with the Railway backend (evaluator
// = Claude). Without a partition the prod drain would score SANDBOX rows on Claude, and — worse — the
// laptop drain would score REAL participants' ple_pass rows on the local model, which is exactly the
// evaluator confound the Model Lock exists to prevent.
//
//   exclude ← app_settings.eval_drain_exclude_councils (comma-separated council CODES; superadmin)
//             "leave these councils alone" — set to SANDBOX in prod for the smoke window.
//   include ← env EVAL_DRAIN_ONLY_COUNCILS (comma-separated codes; DEVELOPMENT ONLY)
//             "touch nothing but these" — set to SANDBOX on the laptop. Refused in production.
//   When an include scope is set, the exclude setting is ignored on that box (it is the prod side's
//   half of the same partition and would otherwise cancel the include).
//
// ANY code that resolves to no council — include or exclude — or a councils read that fails, makes the
// drain match NOTHING (include = [NIL_UUID]) until it is fixed, never everything: a typo in the exclude
// setting must not let the prod drain quietly score the sandbox on the cloud model. `failedClosed`
// names the reason so /health/deep and the sweep can say why nothing is being claimed.
const { supabase } = require('./supabase');
const { getTextSetting } = require('./settings');

const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
const parseCodes = (s) => String(s || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const INCLUDE_CODES = parseCodes(process.env.EVAL_DRAIN_ONLY_COUNCILS);
if (IS_PROD && INCLUDE_CODES.length) {
  throw new Error('EVAL_DRAIN_ONLY_COUNCILS is a development-only include scope (laptop stack against the shared database) and is refused in production. Use the eval_drain_exclude_councils setting instead.');
}

// A uuid that matches no row, so an unresolvable include scope claims nothing.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const TTL_MS = 60_000;
let cache = { at: 0, value: null };

async function resolveScope({ now = Date.now() } = {}) {
  if (cache.value && now - cache.at < TTL_MS) return cache.value;
  // The exclude setting lives in the SHARED database, so a laptop stack reads it too — and during the
  // smoke it names the very council the laptop is there to score. An include scope is the stricter
  // partition and is only ever set on a dev box, so it makes the exclude setting irrelevant here: the
  // prod drain (no include) honours the exclusion, the laptop drain (include) claims exactly its own
  // council. Without this rule both drains would leave SANDBOX to nobody.
  const excludeCodes = INCLUDE_CODES.length ? [] : parseCodes(await getTextSetting('eval_drain_exclude_councils', ''));
  const codes = [...new Set([...excludeCodes, ...INCLUDE_CODES])];
  let byCode = {};
  let failedClosed = null;
  if (codes.length) {
    const { data, error } = await supabase.from('councils').select('id, code').in('code', codes);
    if (error || !Array.isArray(data)) {
      failedClosed = `councils read failed: ${error?.message ?? 'no data'}`;
    } else {
      byCode = Object.fromEntries(data.map((r) => [String(r.code).toUpperCase(), r.id]));
      const unknown = codes.filter((c) => !byCode[c]);
      if (unknown.length) failedClosed = `unknown council code(s): ${unknown.join(',')}`;
    }
  }
  if (failedClosed) console.error(`[eval-scope] ${failedClosed} — the drain claims NOTHING until this is fixed`);
  const ids = (list) => { const out = list.map((c) => byCode[c]).filter(Boolean); return out.length ? out : null; };
  const value = {
    exclude: ids(excludeCodes),
    include: failedClosed ? [NIL_UUID] : (INCLUDE_CODES.length ? ids(INCLUDE_CODES) : null),
    excludeCodes, includeCodes: INCLUDE_CODES, failedClosed,
  };
  cache = { at: now, value };
  return value;
}

// Tests and the settings PATCH handler call this after a change so the next tick sees it.
function invalidateScope() { cache = { at: 0, value: null }; }

module.exports = { resolveScope, invalidateScope, INCLUDE_CODES, NIL_UUID };
