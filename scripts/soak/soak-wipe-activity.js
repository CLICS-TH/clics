// Wipe ONLY soak activity (CLEs/messages/evals/scores/lpdp), keep the 16 accounts + slots.
//   cd backend && NODE_PATH="$PWD/node_modules" node /tmp/soak-wipe-activity.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const NIL = '00000000-0000-0000-0000-000000000000';
const c = async t => (await supabase.from(t).select('id', { count: 'exact', head: true })).count ?? 0;
(async () => {
  console.log('before: cles', await c('cles'), 'messages', await c('messages'), 'ai_evaluations', await c('ai_evaluations'), 'lpdp', await c('lpdp_snapshots'), 'audit_scores', await c('audit_scores'));
  for (const t of ['lpdp_snapshots']) { const { error } = await supabase.from(t).delete().neq('id', NIL); if (error) throw error; }
  const { error } = await supabase.from('cles').delete().neq('id', NIL); // cascades messages/ai_evaluations/audit_scores
  if (error) throw error;
  console.log('after:  cles', await c('cles'), 'messages', await c('messages'), 'ai_evaluations', await c('ai_evaluations'), 'lpdp', await c('lpdp_snapshots'), 'audit_scores', await c('audit_scores'));
  console.log('Activity wiped; 16 accounts + role_slots intact.');
  process.exit(0);
})().catch(e => { console.error('WIPE FAILED:', e.message); process.exit(1); });
