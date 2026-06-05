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

// Standardize "supabase returned an error" -> 500. Returns true if it sent a response.
function sendDbError(res, error) {
  if (error) {
    console.error('[db]', error.message);
    res.status(500).json({ error: error.message });
    return true;
  }
  return false;
}

module.exports = { fetchOwnedPle, ownsFolder, sendDbError };
