const { Router } = require('express');
const { z } = require('zod');
const { supabase, authSupabase } = require('../lib/supabase');
const { verifyJwt } = require('../middleware/auth');

const router = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data, error } = await authSupabase.auth.signInWithPassword(parsed.data);
  if (error) return res.status(401).json({ error: error.message });

  const { data: prof } = await supabase
    .from('professionals')
    .select('role, full_name_th, full_name_en, specialty')
    .eq('id', data.user.id)
    .single();

  res.json({
    access_token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email, ...prof },
  });
});

router.post('/logout', verifyJwt, async (_req, res) => {
  await supabase.auth.signOut();
  res.json({ ok: true });
});

router.get('/me', verifyJwt, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
