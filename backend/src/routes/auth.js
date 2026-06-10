const { Router } = require('express');
const { z } = require('zod');
const { supabase, authSupabase, authAnon } = require('../lib/supabase');
const { verifyJwt } = require('../middleware/auth');
const { effectiveLimit } = require('../lib/usage');
const { provisionProfessional } = require('../lib/provisioning');
const { hashToken } = require('../lib/invite-token');

const router = Router();

const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

// Account-creation password policy (pilot): ≥10 chars incl. a letter and a digit.
const strongPassword = z.string().min(10, 'Password must be at least 10 characters')
  .regex(/[A-Za-z]/, 'Must include a letter').regex(/[0-9]/, 'Must include a digit');

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const EmailOnlySchema = z.object({ email: z.string().email() });
// Invite acceptance: the invitee authenticates with Google OR sets a password (+OTP).
// License No. + TMC verification were retired (2026-06-09) — the A/B invite IS the vetting.
const InviteAcceptSchema = z.object({
  method: z.enum(['password', 'google']),
  password: strongPassword.optional(),
  full_name_th: z.string().min(1).optional(),
  full_name_en: z.string().min(1).optional(),
  otp: z.string().min(4).max(10).optional(),
  access_token: z.string().min(10).optional(),
});

// Google sign-in completes client-side via Supabase; the browser posts the session token here.
const GoogleCompleteSchema = z.object({
  access_token: z.string().min(10),
  council_id: z.string().uuid(),
});

// A council a new member may join must exist AND be active.
async function activeCouncil(councilId) {
  const { data } = await supabase.from('councils').select('id, active').eq('id', councilId).maybeSingle();
  return data && data.active ? data : null;
}

// Verify an emailed OTP. An admin-created (unconfirmed) account produces a 'signup'-type token
// (Confirm-signup email); a magic-link produces an 'email' token. Try both so either path verifies.
async function verifyEmailOtp(email, token) {
  let r = await authAnon.auth.verifyOtp({ email, token, type: 'email' });
  if (r.error) r = await authAnon.auth.verifyOtp({ email, token, type: 'signup' });
  return r;
}

// Public council list for the sign-up picker (id + names only; no auth required).
router.get('/councils', async (_req, res) => {
  const { data, error } = await supabase
    .from('councils').select('id, code, name_th, name_en')
    .eq('active', true).order('sort');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// Google sign-in is gated by OAUTH_ENABLED — keep it off until the Supabase Google provider is
// configured (docs/AUTH-SETUP.md). The /oauth/google/complete route 404s while disabled.
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

router.get('/me', verifyJwt, async (req, res) => {
  // Attach the effective AI-usage limit so the client can render the usage bar without
  // needing to know the org standard default (usage_cost_usd already flows via req.user).
  const usage_limit_effective_usd = await effectiveLimit(req.user);
  res.json({ user: { ...req.user, usage_limit_effective_usd } });
});

// Record the participant's informed consent (human-subjects pilot). Session creation is gated on this.
router.post('/consent', verifyJwt, async (req, res) => {
  const now = new Date().toISOString();
  const { error } = await supabase.from('professionals').update({ consented_at: now }).eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, consented_at: now });
});

// ---------------------------------------------------------------------------
// Self-service access requests were RETIRED (2026-06-10): physicians self-serve via Google
// (POST /auth/oauth/google/complete) and A/B invite links — no pending/approval queue, which
// removes the approval load on superadmin/admin. The access_requests table stays as history.
// ---------------------------------------------------------------------------
router.post('/request-access', (_req, res) =>
  res.status(404).json({ error: 'Self-service requests are retired — sign in with Google or use an invite link.' }));

// ---------------------------------------------------------------------------
// Public email-OTP self-signup was RETIRED (2026-06-09): physicians self-serve via Google
// (POST /auth/oauth/google/complete) and A/B invite links. Email+password LOGIN still serves
// superadmin/admin, admin-provisioned, and password-invite accounts.
// ---------------------------------------------------------------------------

// POST /auth/forgot-password — always 200 (never leak whether an account exists).
router.post('/forgot-password', async (req, res) => {
  const parsed = EmailOnlySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await authAnon.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${SITE_URL}/reset` }).catch(() => {});
  res.json({ ok: true });
});

// POST /auth/oauth/google/complete — the browser finishes Supabase's Google handshake client-side,
// then posts the session access_token here. We VALIDATE it server-side (never trust client-sent
// name/email), encrypt the identity into the on-prem vault, and auto-provision a physician.
// Google verifies the EMAIL; the physician self-serves via Google and is active immediately.
router.post('/oauth/google/complete', oauthGate, async (req, res) => {
  const parsed = GoogleCompleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { access_token, council_id } = parsed.data;

  const { data: uData, error: uErr } = await authSupabase.auth.getUser(access_token);
  if (uErr || !uData?.user) return res.status(401).json({ error: 'Invalid Google session.' });
  const user = uData.user;

  const { data: prof } = await supabase.from('professionals').select('*').eq('id', user.id).maybeSingle();
  if (prof) {
    // Mirror the /login gate — a deactivated account must not be handed a session.
    if (prof.status === 'deactivated') {
      return res.status(403).json({ error: 'Account deactivated. Contact an administrator.', code: 'deactivated' });
    }
    return res.json({ access_token, user: { id: user.id, email: user.email, ...prof } });
  }

  if (!(await activeCouncil(council_id))) return res.status(400).json({ error: 'Unknown or inactive council.' });

  // Identity is read from the VALIDATED token, never from the request body.
  const md = user.user_metadata || {};
  const name = md.full_name || md.name || user.email;
  const prov = await provisionProfessional({
    authUserId: user.id, role: 'physician', councilId: council_id,
    full_name_th: name, full_name_en: name, status: 'active',
    identity: { provider: 'google', provider_subject: user.id, payload: { name, email: user.email } },
  });
  if (!prov.ok) return res.status(prov.code === 'slot_full' ? 409 : 500).json({ error: prov.error });

  res.status(201).json({ access_token, user: { id: user.id, email: user.email, ...prov.professional } });
});

// ---------------------------------------------------------------------------
// Invite acceptance (A/B invited a physician or auditor). The invite is bound to an email;
// the invitee authenticates with Google OR sets a password (+OTP). The A/B invite IS the
// vetting — both physicians and auditors are active immediately on accept (no license gate).
// ---------------------------------------------------------------------------

async function loadPendingInvite(rawToken, res) {
  const { data: inv } = await supabase.from('invites').select('*').eq('token_hash', hashToken(rawToken)).maybeSingle();
  if (!inv || inv.status !== 'pending') { res.status(404).json({ error: 'Invite not found.' }); return null; }
  if (new Date(inv.expires_at) < new Date()) {
    await supabase.from('invites').update({ status: 'expired' }).eq('id', inv.id);
    res.status(410).json({ error: 'This invite has expired.' }); return null;
  }
  return inv;
}

// GET /auth/invite/:token — show the invited email + role + council (never the token hash).
router.get('/invite/:token', async (req, res) => {
  const inv = await loadPendingInvite(req.params.token, res);
  if (!inv) return;
  const { data: council } = await supabase.from('councils').select('name_th, name_en').eq('id', inv.council_id).maybeSingle();
  res.json({ email: inv.email, role: inv.role, council: council ?? null });
});

// POST /auth/invite/:token/accept — finalize in the invited role.
router.post('/invite/:token/accept', async (req, res) => {
  const parsed = InviteAcceptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const body = parsed.data;
  const inv = await loadPendingInvite(req.params.token, res);
  if (!inv) return;

  // Shared: provision in the invited role (ACTIVE on accept — the A/B invite is the vetting),
  // then consume the invite atomically.
  async function finalize({ authUserId, full_name_th, full_name_en, identity, session_token }) {
    const prov = await provisionProfessional({
      authUserId, role: inv.role, councilId: inv.council_id,
      full_name_th, full_name_en, status: 'active', identity,
    });
    if (!prov.ok) return { http: prov.code === 'slot_full' ? 409 : 500, json: { error: prov.error } };
    // Consume the invite ATOMICALLY: only succeeds if it's still pending (guards concurrent accepts).
    const { data: claimed } = await supabase.from('invites')
      .update({ status: 'accepted', accepted_at: new Date().toISOString(), professional_id: authUserId })
      .eq('id', inv.id).eq('status', 'pending').select('id');
    if (!claimed || claimed.length === 0) {
      return { http: 409, json: { error: 'This invite has already been used.' } };
    }
    return {
      http: 201,
      json: { status: 'active', access_token: session_token, user: { id: authUserId, ...prov.professional } },
    };
  }

  // Google method — email must match the invite; identity encrypted to the vault.
  if (body.method === 'google') {
    if (!OAUTH_ENABLED) return res.status(404).json({ error: 'Google sign-in is not available.' });
    if (!body.access_token) return res.status(400).json({ error: 'access_token is required.' });
    const { data: uData, error } = await authSupabase.auth.getUser(body.access_token);
    if (error || !uData?.user) return res.status(401).json({ error: 'Invalid Google session.' });
    const user = uData.user;
    if ((user.email || '').toLowerCase() !== inv.email.toLowerCase()) {
      return res.status(403).json({ error: 'Your Google email must match the invited email.' });
    }
    const { data: existing } = await supabase.from('professionals').select('id').eq('id', user.id).maybeSingle();
    if (existing) return res.status(409).json({ error: 'This account already exists.' });
    const md = user.user_metadata || {};
    const name = md.full_name || md.name || user.email;
    const out = await finalize({
      authUserId: user.id, full_name_th: name, full_name_en: name,
      identity: { provider: 'google', provider_subject: user.id, payload: { name, email: user.email } },
      session_token: body.access_token,
    });
    return res.status(out.http).json(out.json);
  }

  // Password method — bound to the invited email; two steps (send OTP, then verify+provision).
  if (!body.full_name_th || !body.full_name_en) return res.status(400).json({ error: 'Name is required.' });

  if (!body.otp) {
    if (!body.password) return res.status(400).json({ error: 'Password is required.' });
    const { data: created, error: cErr } = await supabase.auth.admin.createUser({
      email: inv.email, password: body.password, email_confirm: false,
      user_metadata: { invite_signup: { full_name_th: body.full_name_th, full_name_en: body.full_name_en } },
    });
    if (cErr) return res.status(409).json({ error: 'This email is already registered. Sign in instead.' });
    const { error: otpErr } = await authAnon.auth.signInWithOtp({ email: inv.email, options: { shouldCreateUser: false } });
    if (otpErr) { await supabase.auth.admin.deleteUser(created.user.id); return res.status(502).json({ error: 'Could not send the verification code.' }); }
    return res.status(202).json({ status: 'otp_sent', email: inv.email });
  }

  const { data: vData, error: vErr } = await verifyEmailOtp(inv.email, body.otp);
  if (vErr || !vData?.user) return res.status(400).json({ error: 'Invalid or expired code.' });
  const md = vData.user.user_metadata?.invite_signup || {};
  const out = await finalize({
    authUserId: vData.user.id,
    full_name_th: body.full_name_th || md.full_name_th,
    full_name_en: body.full_name_en || md.full_name_en,
    identity: null,
    session_token: vData.session?.access_token,
  });
  return res.status(out.http).json(out.json);
});

module.exports = router;
