// Physician conversation folders. Mounted at /ples/folders (before the /ples router).
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { verifyJwt, requireRole } = require('../middleware/auth');
const { CreateFolderSchema, UpdateFolderSchema } = require('../lib/schemas');
const { sendDbError } = require('../lib/db-helpers');

const router = Router();
router.use(verifyJwt, requireRole('physician'));

// List the physician's folders
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('ple_folders').select('id, name, sort_order, created_at')
    .eq('physician_id', req.user.id)
    .order('sort_order', { ascending: true }).order('created_at', { ascending: true });
  if (sendDbError(res, error)) return;
  res.json(data);
});

// Create a folder
router.post('/', async (req, res) => {
  const parsed = CreateFolderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { data, error } = await supabase
    .from('ple_folders').insert({ physician_id: req.user.id, name: parsed.data.name })
    .select('id, name, sort_order, created_at').single();
  if (sendDbError(res, error)) return;
  res.status(201).json(data);
});

// Rename a folder
router.patch('/:id', async (req, res) => {
  const parsed = UpdateFolderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { data, error } = await supabase
    .from('ple_folders').update({ name: parsed.data.name, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('physician_id', req.user.id)
    .select('id, name, sort_order, created_at').single();
  if (error || !data) return res.status(404).json({ error: 'Folder not found' });
  res.json(data);
});

// Delete a folder (its conversations fall back to Uncategorized via FK on delete set null)
router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('ple_folders').delete()
    .eq('id', req.params.id).eq('physician_id', req.user.id).select('id');
  if (sendDbError(res, error)) return;
  if (!data || !data.length) return res.status(404).json({ error: 'Folder not found' });
  res.json({ ok: true });
});

module.exports = router;
