const { Router } = require('express');
const { z } = require('zod');
const { supabase, authSupabase } = require('../lib/supabase');
const { verifyJwt } = require('../middleware/auth');
const { encryptJson } = require('../lib/crypto');

const router = Router();

// Account-creation password policy (pilot): ≥10 chars incl. a letter and a digit.
const strongPassword = z.string().min(10, 'Password must be at least 10 characters')
  .regex(/[A-Za-z]/, 'Must include a letter').regex(/[0-9]/, 'Must include a digit');

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const RequestAccessSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  full_name_th: z.string().min(1),
  full_name_en: z.string().min(1),
  specialty: z.string().optional(),
});

// In a real OAuth integration these fields come from the provider's userinfo endpoint.
const MockOAuthSchema = z.object({
  provider_subject: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
});

const OAUTH_PROVIDERS = ['google', 'line'];

// Social sign-in (Google/LINE) is a STUBBED handshake — no real provider wiring yet — and the
// mock-callback is public (it can mint pending users), so it is DISABLED by default. The pilot
// uses email+password only. Set OAUTH_ENABLED=true to re-enable for dev or once the real
// provider handshake is implemented. Disabled routes 404 so the path effectively does not exist.
const OAUTH_ENABLED = process.env.OAUTH_ENABLED === 'true';
function oauthGate(_req, res, next) {
  if (!OAUTH_ENABLED) return res.status(404).json({ error: 'Social sign-in is not available.' });
  next();
}

router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { data, error } = await authSupabase.auth.signInWithPassword(parsed.data);
  if (error) return res.status(401).json({ error: error.message });

  const { data: prof } = await supabase
    .from('professionals')
    .select('*') // includes consented_at once the migration is applied; resilient if not yet
    .eq('id', data.user.id)
    .maybeSingle();

  // Mirror the verifyJwt gate at the login boundary so the UI can show a clean message
  // instead of a token that 403s on every call.
  if (!prof) {
    return res.status(403).json({ error: 'Account pending approval', code: 'pending' });
  }
  if (prof.status === 'deactivated') {
    return res.status(403).json({ error: 'Account deactivated. Contact an administrator.', code: 'deactivated' });
  }

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

// Record the participant's informed consent (human-subjects pilot). Session creation is gated on this.
router.post('/consent', verifyJwt, async (req, res) => {
  const now = new Date().toISOString();
  const { error } = await supabase.from('professionals').update({ consented_at: now }).eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, consented_at: now });
});

// ---------------------------------------------------------------------------
// Self-service access requests (invite/approve-only — no self-activation).
// A requester gets a Supabase auth.users row but NO professionals row, so they
// stay pending (verifyJwt 403s) until a superadmin/admin approves them into a
// role slot. Requesters can never self-assign a role — approval assigns it.
// ---------------------------------------------------------------------------

// POST /auth/request-access — email/password request (public).
router.post('/request-access', async (req, res) => {
  const parsed = RequestAccessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password, full_name_th, full_name_en, specialty } = parsed.data;

  const { data: existing } = await supabase
    .from('access_requests').select('id').eq('email', email).eq('status', 'pending').maybeSingle();
  if (existing) return res.status(409).json({ error: 'A request for this email is already pending.' });

  // Create the auth user now (sets the password) but no professionals row yet ⇒ pending.
  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const { error: reqErr } = await supabase.from('access_requests').insert({
    email, full_name_th, full_name_en, specialty: specialty ?? null,
    provider: 'email', auth_user_id: authUser.user.id, requested_role: 'physician', status: 'pending',
  });
  if (reqErr) {
    await supabase.auth.admin.deleteUser(authUser.user.id); // roll back the orphan auth user
    return res.status(500).json({ error: reqErr.message });
  }
  res.status(202).json({ status: 'pending', message: 'Your request has been submitted and is pending approval.' });
});

// GET/POST /auth/oauth/:provider/start — in production this 302s to the provider's
// authorize URL. STUBBED here: returns the mock-callback endpoint to simulate sign-in.
router.all('/oauth/:provider/start', oauthGate, (req, res) => {
  const { provider } = req.params;
  if (!OAUTH_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unsupported provider' });
  res.json({
    provider,
    stub: true,
    message: `${provider} OAuth handshake is stubbed in this build. POST a mock profile to the mock_callback to simulate sign-in.`,
    mock_callback: `/auth/oauth/${provider}/mock-callback`,
  });
});

// POST /auth/oauth/:provider/mock-callback — simulates the provider redirect with a profile.
// REAL WIRING (see docs/architecture.md): replace this with the provider token exchange +
// userinfo fetch, then run the exact same downstream logic below.
router.post('/oauth/:provider/mock-callback', oauthGate, async (req, res) => {
  const { provider } = req.params;
  if (!OAUTH_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unsupported provider' });
  const parsed = MockOAuthSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { provider_subject, name, email } = parsed.data;

  const { data: linked } = await supabase.from('oauth_identities')
    .select('professional_id').eq('provider', provider).eq('provider_subject', provider_subject).maybeSingle();
  if (linked?.professional_id) {
    return res.status(200).json({ status: 'existing', message: 'This identity is already linked to an account. Please sign in.' });
  }

  const { data: pendingReq } = await supabase.from('access_requests')
    .select('id').eq('provider', provider).eq('provider_subject', provider_subject).eq('status', 'pending').maybeSingle();
  if (pendingReq) return res.status(409).json({ error: 'A request for this identity is already pending.' });

  // Mint a pending auth user (no password — OAuth identity). The real handshake would
  // create/find the Supabase auth user via the provider.
  const syntheticEmail = email || `${provider}_${provider_subject}@oauth.clics.local`;
  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email: syntheticEmail, email_confirm: true, user_metadata: { provider, provider_subject },
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  // The REAL identity is encrypted into the on-prem vault — never leaves on-prem, never to RIMPL.
  const { error: vaultErr } = await supabase.from('oauth_identities').insert({
    auth_user_id: authUser.user.id, provider, provider_subject,
    identity_encrypted: encryptJson({ name, email: email ?? null, provider_subject }),
  });
  if (vaultErr) {
    await supabase.auth.admin.deleteUser(authUser.user.id);
    return res.status(500).json({ error: vaultErr.message });
  }

  const { error: reqErr } = await supabase.from('access_requests').insert({
    email: email ?? null, full_name_th: name, full_name_en: name,
    provider, provider_subject, auth_user_id: authUser.user.id, requested_role: 'physician', status: 'pending',
  });
  if (reqErr) return res.status(500).json({ error: reqErr.message });

  res.status(202).json({ status: 'pending', message: 'Your request has been submitted and is pending approval.' });
});

module.exports = router;
