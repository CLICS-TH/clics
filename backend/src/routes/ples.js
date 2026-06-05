const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const {
  MessageSchema, CreatePleSchema,
  CreateFolderSchema, UpdateFolderSchema, UpdatePleSchema,
} = require('../lib/schemas');
const { computeTier1, compositeScore } = require('../services/cle-gate');
const { rimplChat, rimplEvaluate, rimplEvaluateCriteria } = require('../services/rimpl-client');

const router = Router();
router.use(verifyJwt, requireRole('physician'));

// Confirm a folder belongs to the authenticated physician (null = Uncategorized, always allowed).
async function ownsFolder(physicianId, folderId) {
  if (folderId == null) return true;
  const { data } = await supabase
    .from('ple_folders').select('id').eq('id', folderId).eq('physician_id', physicianId).single();
  return !!data;
}

// Create new PLE session
router.post('/', async (req, res) => {
  const parsed = CreatePleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { chief_complaint, folder_id } = parsed.data;
  if (!(await ownsFolder(req.user.id, folder_id))) {
    return res.status(403).json({ error: 'Folder not found' });
  }

  // Auto-title from the chief complaint (previously discarded); physician can rename later.
  const title = chief_complaint.trim().slice(0, 120);

  const { data, error } = await supabase.from('ples').insert({
    physician_id: req.user.id,
    status: 'active',
    started_at: new Date().toISOString(),
    chief_complaint,
    title,
    folder_id: folder_id ?? null,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// List physician's own PLEs
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('ples')
    .select('id, title, chief_complaint, folder_id, status, started_at, ended_at, turn_count, token_count, c1_pass, c2_pass, c3_pass, c4_pass, c5_pass, c6_pass')
    .eq('physician_id', req.user.id)
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== Conversation folders (declared before /:id so "folders" isn't read as an id) =====

// List physician's own folders
router.get('/folders', async (req, res) => {
  const { data, error } = await supabase
    .from('ple_folders')
    .select('id, name, sort_order, created_at')
    .eq('physician_id', req.user.id)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Create a folder
router.post('/folders', async (req, res) => {
  const parsed = CreateFolderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { data, error } = await supabase
    .from('ple_folders')
    .insert({ physician_id: req.user.id, name: parsed.data.name })
    .select('id, name, sort_order, created_at').single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// Rename a folder
router.patch('/folders/:id', async (req, res) => {
  const parsed = UpdateFolderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { data, error } = await supabase
    .from('ple_folders')
    .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('physician_id', req.user.id)
    .select('id, name, sort_order, created_at').single();
  if (error || !data) return res.status(404).json({ error: 'Folder not found' });
  res.json(data);
});

// Delete a folder (its conversations fall back to Uncategorized via FK on delete set null)
router.delete('/folders/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('ple_folders').delete()
    .eq('id', req.params.id).eq('physician_id', req.user.id)
    .select('id');
  if (error) return res.status(500).json({ error: error.message });
  if (!data || !data.length) return res.status(404).json({ error: 'Folder not found' });
  res.json({ ok: true }); // JSON body (not 204) — the client always calls res.json()
});

// Rename a conversation and/or move it between folders
router.patch('/:id', async (req, res) => {
  const parsed = UpdatePleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { title, folder_id } = parsed.data;

  if (folder_id !== undefined && !(await ownsFolder(req.user.id, folder_id))) {
    return res.status(403).json({ error: 'Folder not found' });
  }

  const patch = {};
  if (title !== undefined) patch.title = title;
  if (folder_id !== undefined) patch.folder_id = folder_id;

  const { data, error } = await supabase
    .from('ples').update(patch)
    .eq('id', req.params.id).eq('physician_id', req.user.id)
    .select('id, title, chief_complaint, folder_id, status, started_at, turn_count, token_count').single();
  if (error || !data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// Delete a conversation (and its data). Physician can remove their own sessions.
router.delete('/:id', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('id').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });

  // messages / ai_evaluations / audit_scores cascade on delete; lpdp_snapshots FK has no
  // ON DELETE CASCADE, so remove those rows first to avoid a foreign-key violation.
  await supabase.from('lpdp_snapshots').delete().eq('ple_id', req.params.id);

  const { error } = await supabase
    .from('ples').delete().eq('id', req.params.id).eq('physician_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Physician's own longitudinal profile (LPDP). Mirrors the superadmin-only
// /admin/lpdp/:id, scoped to the authenticated physician. Declared before /:id.
router.get('/lpdp/me', async (req, res) => {
  const { data, error } = await supabase
    .from('lpdp_snapshots').select('*')
    .eq('physician_id', req.user.id)
    .order('snapshot_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get single PLE with messages
router.get('/:id', async (req, res) => {
  const { data: ple, error } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (error || !ple) return res.status(404).json({ error: 'Not found' });

  const { data: messages } = await supabase
    .from('messages').select('*').eq('ple_id', req.params.id).order('created_at');

  res.json({ ...ple, messages: messages ?? [] });
});

// Send a message turn
router.post('/:id/message', async (req, res) => {
  const parsed = MessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data: ple } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple || ple.status !== 'active') return res.status(400).json({ error: 'PLE not active' });

  const { data: history } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');

  const { message, language } = parsed.data;

  let rimplResponse;
  try {
    rimplResponse = await rimplChat({ ple_id: req.params.id, history: history ?? [], message, language });
  } catch (err) {
    return res.status(502).json({ error: `RIMPL unavailable: ${err.message}` });
  }

  const physicianTokens = Math.ceil(message.length / 4);

  const { error: msgErr1 } = await supabase.from('messages').insert({
    ple_id: req.params.id, role: 'physician',
    content: message, token_count: physicianTokens,
  });
  if (msgErr1) console.error('[ples] failed to persist physician message:', msgErr1.message);

  const { error: msgErr2 } = await supabase.from('messages').insert({
    ple_id: req.params.id, role: 'assistant',
    content: rimplResponse.content,
    refs: rimplResponse.refs,
    socratic_question: rimplResponse.socratic_question,
    token_count: rimplResponse.token_count,
  });
  if (msgErr2) console.error('[ples] failed to persist assistant message:', msgErr2.message);

  const { error: counterErr } = await supabase.from('ples').update({
    turn_count: (ple.turn_count ?? 0) + 1,
    token_count: (ple.token_count ?? 0) + (rimplResponse.token_count ?? 0) + physicianTokens,
  }).eq('id', req.params.id);
  if (counterErr) console.error('[ples] failed to update counters:', counterErr.message);

  res.json(rimplResponse);
});

// End session and run CLE quality gate
router.post('/:id/end', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('*').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple || ple.status !== 'active') return res.status(400).json({ error: 'PLE not active' });

  const endedAt = new Date();
  const wallClockSeconds = Math.floor((endedAt - new Date(ple.started_at)) / 1000);
  // Prefer the client-reported active-engagement time (idle/backgrounded time excluded);
  // fall back to wall-clock if the client didn't report it.
  const reported = Number(req.body?.active_seconds);
  const durationSeconds = Number.isFinite(reported) && reported >= 0 ? Math.round(reported) : wallClockSeconds;
  const updatedPle = { ...ple, duration_seconds: durationSeconds };

  const tier1 = computeTier1(updatedPle);
  // CLE-gate booleans live in the c1_pass..c6_pass columns; map {c1..} -> {c1_pass..}.
  const toPassCols = (crit) => Object.fromEntries(Object.entries(crit).map(([k, v]) => [`${k}_pass`, v]));

  if (!tier1.c1 || !tier1.c2 || !tier1.c3) {
    const { error: e } = await supabase.from('ples').update({
      status: 'cle_fail_t1', ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds, ...toPassCols(tier1),
    }).eq('id', req.params.id);
    if (e) { console.error('[ples] end (t1) update failed:', e.message); return res.status(500).json({ error: e.message }); }
    return res.json({ status: 'cle_fail_t1', criteria: tier1 });
  }

  const { data: messages } = await supabase
    .from('messages').select('role, content').eq('ple_id', req.params.id).order('created_at');
  const transcript = (messages ?? []).map(m => ({ role: m.role, content: m.content }));

  let tier2 = { c4: false, c5: false, c6: false };
  try {
    tier2 = await rimplEvaluateCriteria({ transcript });
  } catch {
    // RIMPL down — flag for manual QA
  }

  const allCriteria = { ...tier1, ...tier2 };
  const tier2Pass = tier2.c4 && tier2.c5 && tier2.c6;

  if (!tier2Pass) {
    const { error: e } = await supabase.from('ples').update({
      status: 'cle_flag_t2', ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds, ...toPassCols(allCriteria),
    }).eq('id', req.params.id);
    if (e) { console.error('[ples] end (t2) update failed:', e.message); return res.status(500).json({ error: e.message }); }
    return res.json({ status: 'cle_flag_t2', criteria: allCriteria });
  }

  const { error: passErr } = await supabase.from('ples').update({
    status: 'cle_pass', ended_at: endedAt.toISOString(),
    duration_seconds: durationSeconds, ...toPassCols(allCriteria),
  }).eq('id', req.params.id);
  if (passErr) { console.error('[ples] end (pass) update failed:', passErr.message); return res.status(500).json({ error: passErr.message }); }

  // Fire-and-forget evaluation
  triggerEvaluation(req.params.id, transcript, ple.physician_id).catch(err => {
    console.error(`[EVAL] triggerEvaluation failed for PLE ${req.params.id}:`, err.message);
  });

  res.json({ status: 'cle_pass', criteria: allCriteria });
});

async function triggerEvaluation(pleId, transcript, physicianId) {
  try {
    const result = await rimplEvaluate({ ple_id: pleId, transcript });
    const composite = compositeScore(result);

    await supabase.from('ai_evaluations').insert({
      ple_id: pleId,
      d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4,
      d5: result.d5, d6: result.d6, d7: result.d7,
      composite_score: composite,
      domain_rationale: result.domain_rationale,
      model_version: result.model_version ?? 'CCME_LLM_v8.0',
    });

    await supabase.from('lpdp_snapshots').insert({
      physician_id: physicianId, ple_id: pleId,
      composite_score: composite,
      domain_scores: { d1: result.d1, d2: result.d2, d3: result.d3, d4: result.d4, d5: result.d5, d6: result.d6, d7: result.d7 },
    });

    await supabase.from('ples').update({ status: 'evaluated' }).eq('id', pleId);
  } catch (err) {
    throw new Error(`Evaluation pipeline failed for ${pleId}: ${err.message}`);
  }
}

// Get AI evaluation result
router.get('/:id/evaluation', async (req, res) => {
  const { data: ple } = await supabase
    .from('ples').select('status').eq('id', req.params.id).eq('physician_id', req.user.id).single();
  if (!ple) return res.status(404).json({ error: 'Not found' });
  if (ple.status !== 'evaluated') return res.status(202).json({ status: ple.status });

  const { data: eval_ } = await supabase
    .from('ai_evaluations').select('*').eq('ple_id', req.params.id).single();
  res.json(eval_);
});

module.exports = router;
