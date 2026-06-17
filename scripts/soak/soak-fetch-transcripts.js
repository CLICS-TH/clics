// Fetch all 'evaluated' CLEs with their full transcripts (BLIND — AI scores kept separate) for
// independent auditor scoring. Writes /tmp/soak-transcripts.json.
//   cd backend && NODE_PATH="$PWD/node_modules" node /tmp/soak-fetch-transcripts.js
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

(async () => {
  const { data: pros } = await supabase.from('professionals').select('id, pseudonym');
  const pseudo = Object.fromEntries(pros.map(p => [p.id, p.pseudonym]));

  const { data: cles } = await supabase.from('cles')
    .select('id, physician_id, chief_complaint, turn_count, token_count, duration_seconds')
    .eq('status', 'evaluated').order('started_at');

  const out = [];
  for (const cle of cles) {
    const { data: msgs } = await supabase.from('messages')
      .select('role, content, socratic_question').eq('cle_id', cle.id).order('created_at');
    const { data: ai } = await supabase.from('ai_evaluations')
      .select('d1,d2,d3,d4,d5,d6,d7,composite_score').eq('cle_id', cle.id).single();
    out.push({
      cle_id: cle.id,
      pseudonym: pseudo[cle.physician_id],
      chief_complaint: cle.chief_complaint,
      turn_count: cle.turn_count, token_count: cle.token_count, duration_seconds: cle.duration_seconds,
      messages: (msgs ?? []).map(m => ({ role: m.role, content: m.content })),  // BLIND: no AI scores here
      _ai: ai ?? null,  // kept ONLY for ICC/report; never shown to auditors
    });
  }
  fs.writeFileSync('/tmp/soak-transcripts.json', JSON.stringify(out, null, 2));
  console.log(`Wrote /tmp/soak-transcripts.json — ${out.length} evaluated CLEs`);
  for (const p of out) console.log(`  ${p.pseudonym}  ${p.cle_id.slice(0,8)}  turns=${p.turn_count} tok=${p.token_count}  AIcomposite=${p._ai?.composite_score ?? '?'}  ${p.chief_complaint.slice(0,40)}`);
  process.exit(0);
})().catch(e => { console.error('FETCH FAILED:', e.message); process.exit(1); });
