// Small shared data-access helpers used across the physician/admin routes.
const { supabase } = require('./supabase');

// Fetch a PLE the physician owns. Returns the supabase { data, error } result.
function fetchOwnedPle(pleId, physicianId, cols = '*') {
  return supabase.from('ples').select(cols).eq('id', pleId).eq('physician_id', physicianId).single();
}

// True if folderId is null (Uncategorized — always allowed) or belongs to the physician.
async function ownsFolder(physicianId, folderId) {
  if (folderId == null) return true;
  const { data } = await supabase
    .from('ple_folders').select('id').eq('id', folderId).eq('physician_id', physicianId).single();
  return !!data;
}

// In production a raw Postgres/PostgREST error.message discloses table/column/constraint/trigger
// names to the client (and one call site is the PUBLIC GET /auth/councils). Log it server-side, but
// return a generic body in prod. Dev keeps the detail for debugging.
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';

// Standardize "supabase returned an error" -> 500. Returns true if it sent a response.
function sendDbError(res, error) {
  if (error) {
    console.error('[db]', error.message);
    res.status(500).json({ error: IS_PROD ? 'Internal server error' : error.message });
    return true;
  }
  return false;
}

// Parse ?limit&offset (clamped) for paginated list endpoints — bounds the rows pulled from an
// 80K/400K-row table and dodges PostgREST's silent 1000-row truncation. Default 50, max 200.
function pageParams(req, { def = 50, max = 200 } = {}) {
  const limit = Math.min(max, Math.max(1, parseInt(req.query.limit, 10) || def));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return { limit, offset };
}

module.exports = { fetchOwnedPle, ownsFolder, sendDbError, pageParams };
