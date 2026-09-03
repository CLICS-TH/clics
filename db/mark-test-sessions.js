// db/mark-test-sessions.js — flag the sessions of a demo/soak cohort as TEST (cles.is_test = true)
// so a later db/reset-demo.js preserves them and they keep feeding the audit system.
//
// Sessions are created through the API as real (is_test=false); this is the operator step that
// retroactively marks a known test cohort. Pass email substrings to match physicians by; sessions
// owned by any matching physician are flagged.
//
//   cd backend && NODE_PATH="$PWD/node_modules" node ../db/mark-test-sessions.js soakdoc @example.com doctor1@clics.th
//
// With no args it defaults to the soak (@example.com) + demo (doctor1@clics.th) cohorts.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const patterns = process.argv.slice(2);
const MATCH = patterns.length ? patterns : ['@example.com', 'doctor1@clics.th'];

async function listAllUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}

(async () => {
  console.log(`Marking sessions test for physicians matching: ${MATCH.join(', ')}`);
  const all = await listAllUsers();
  const cohortIds = all
    .filter(u => MATCH.some(m => (u.email || '').toLowerCase().includes(m.toLowerCase())))
    .map(u => u.id);
  if (!cohortIds.length) { console.log('No matching accounts found. Nothing to do.'); process.exit(0); }

  const { data, error } = await supabase
    .from('ples').update({ is_test: true })
    .in('physician_id', cohortIds).eq('is_test', false).select('id');
  if (error) { console.error('FAILED:', error.message); process.exit(1); }
  console.log(`Marked ${data?.length ?? 0} session(s) as test across ${cohortIds.length} account(s).`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
