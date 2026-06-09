const { Router } = require('express');
const { z } = require('zod');
const { supabase, authSupabase, authAnon } = require('../lib/supabase');
const { verifyJwt } = require('../middleware/auth');
const { effectiveLimit } = require('../lib/usage');
const { provisionProfessional } = require('../lib/provisioning');
const { getVerifier, toLicenseStatus, recordVerification } = require('../services/license-verifier');
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

// Self-service physician signup → email OTP → license check → auto-provision.
const SignupEmailSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  council_id: z.string().uuid(),
  full_name_th: z.string().min(1),
  full_name_en: z.string().min(1),
  license_number: z.string().min(1),
  specialty: z.string().optional(),
});
const VerifyOtpSchema = z.object({ email: z.string().email(), token: z.string().min(4).max(10) });
const EmailOnlySchema = z.object({ email: z.string().email() });
const InviteAcceptSchema = z.object({
  method: z.enum(['password', 'google']),
  password: strongPassword.optional(),
  full_name_th: z.string().min(1).optional(),
  full_name_en: z.string().min(1).optional(),
  license_number: z.string().min(1).optional(),
  otp: z.string().min(4).max(10).optional(),
  access_token: z.string().min(10).optional(),
});

const RequestAccessSchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  council_id: z.string().uuid(),   // the council the requester will join (required for approval)
  full_name_th: z.string().min(1),
  full_name_en: z.string().min(1),
  specialty: z.string().optional(),
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
// Self-service access requests (invite/approve-only — no self-activation).
// A requester gets a Supabase auth.users row but NO professionals row, so they
// stay pending (verifyJwt 403s) until a superadmin/admin approves them into a
// role slot. Requesters can never self-assign a role — approval assigns it.
// ---------------------------------------------------------------------------

// POST /auth/request-access — email/password request (public).
router.post('/request-access', async (req, res) => {
  const parsed = RequestAccessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password, council_id, full_name_th, full_name_en, specialty } = parsed.data;

  if (!(await activeCouncil(council_id))) return res.status(400).json({ error: 'Unknown or inactive council.' });

  const { data: existing } = await supabase
    .from('access_requests').select('id').eq('email', email).eq('status', 'pending').maybeSingle();
  if (existing) return res.status(409).json({ error: 'A request for this email is already pending.' });

  // Create the auth user now (sets the password) but no professionals row yet ⇒ pending.
  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const { error: reqErr } = await supabase.from('access_requests').insert({
    email, full_name_th, full_name_en, specialty: specialty ?? null, council_id,
    provider: 'email', auth_user_id: authUser.user.id, requested_role: 'physician', status: 'pending',
  });
  if (reqErr) {
    await supabase.auth.admin.deleteUser(authUser.user.id); // roll back the orphan auth user
    return res.status(500).json({ error: reqErr.message });
  }
  res.status(202).json({ status: 'pending', message: 'Your request has been submitted and is pending approval.' });
});

// ---------------------------------------------------------------------------
// Email signup with 6-digit OTP verification → license check → auto-provision physician.
// No admin approval: email-verify + license-check replace the manual gate (the load reducer).
// (Auditors are NOT created here — they come through A/B invite links only. See admin.js.)
// ---------------------------------------------------------------------------

// POST /auth/signup/email — create the user UNCONFIRMED and email a 6-digit code.
router.post('/signup/email', async (req, res) => {
  const parsed = SignupEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, password, council_id, full_name_th, full_name_en, license_number, specialty } = parsed.data;

  if (!(await activeCouncil(council_id))) return res.status(400).json({ error: 'Unknown or inactive council.' });

  // Create unconfirmed; stash the signup details in metadata for the verify step (no separate store).
  const { data: created, error: cErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: false,
    user_metadata: { signup: { council_id, full_name_th, full_name_en, license_number, specialty: specialty ?? null } },
  });
  if (cErr) {
    // Email already exists. Return the SAME shape as a fresh signup so this endpoint can't be used
    // to enumerate registered emails (no existence leak). We intentionally do NOT send a code here
    // (that would let an attacker passwordless-target an existing account) — the real user signs in
    // or uses forgot-password instead.
    return res.status(202).json({ status: 'otp_sent', email });
  }

  // Send the OTP (the Magic Link template must use {{ .Token }} to deliver a code — see docs/AUTH-SETUP.md).
  const { error: otpErr } = await authAnon.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (otpErr) {
    await supabase.auth.admin.deleteUser(created.user.id); // roll back so they can retry cleanly
    return res.status(502).json({ error: 'Could not send the verification code. Please try again shortly.' });
  }
  res.status(202).json({ status: 'otp_sent', email });
});

// POST /auth/signup/verify-otp — confirm the code, verify the license, auto-provision the physician.
router.post('/signup/verify-otp', async (req, res) => {
  const parsed = VerifyOtpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, token } = parsed.data;

  const { data: vData, error: vErr } = await verifyEmailOtp(email, token);
  if (vErr || !vData?.user) return res.status(400).json({ error: 'Invalid or expired code.' });
  const user = vData.user;

  // Idempotent: a re-verified, already-provisioned user just logs in.
  const { data: existing } = await supabase.from('professionals').select('*').eq('id', user.id).maybeSingle();
  if (existing) {
    return res.json({ access_token: vData.session?.access_token, user: { id: user.id, email: user.email, ...existing } });
  }

  const signup = user.user_metadata?.signup;
  if (!signup) return res.status(400).json({ error: 'No pending signup for this email.' });
  if (!(await activeCouncil(signup.council_id))) return res.status(400).json({ error: 'Unknown or inactive council.' });

  // License check is SOFT for physicians: provision regardless, license_status reflects the result.
  const result = await getVerifier().verify({
    license_number: signup.license_number, full_name_th: signup.full_name_th, full_name_en: signup.full_name_en,
  });
  const license_status = toLicenseStatus(result.status);

  const prov = await provisionProfessional({
    authUserId: user.id, role: 'physician', councilId: signup.council_id,
    full_name_th: signup.full_name_th, full_name_en: signup.full_name_en,
    specialty: signup.specialty, license_number: signup.license_number,
    license_status, status: 'active',
  });
  if (!prov.ok) return res.status(prov.code === 'slot_full' ? 409 : 500).json({ error: prov.error });

  await recordVerification({ professional_id: user.id, license_number: signup.license_number, name_checked: signup.full_name_th, result });

  res.status(201).json({
    access_token: vData.session?.access_token,
    user: { id: user.id, email: user.email, ...prov.professional },
    license_status,
  });
});

// POST /auth/signup/resend-otp — best-effort resend; never reveals whether the email exists.
router.post('/signup/resend-otp', async (req, res) => {
  const parsed = EmailOnlySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await authAnon.auth.signInWithOtp({ email: parsed.data.email, options: { shouldCreateUser: false } }).catch(() => {});
  res.status(202).json({ status: 'otp_sent' });
});

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
// Google verifies the EMAIL, not the license → license_status='unverified' for A/B review.
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
    full_name_th: name, full_name_en: name,
    license_status: 'unverified', status: 'active',
    identity: { provider: 'google', provider_subject: user.id, payload: { name, email: user.email } },
  });
  if (!prov.ok) return res.status(prov.code === 'slot_full' ? 409 : 500).json({ error: prov.error });

  res.status(201).json({ access_token, user: { id: user.id, email: user.email, ...prov.professional }, license_status: 'unverified' });
});

// ---------------------------------------------------------------------------
// Invite acceptance (A/B invited a physician or auditor). The invite is bound to an email;
// the invitee authenticates with Google OR sets a password (+OTP). License gate: physician
// SOFT (active even if unverified), auditor HARD (deactivated + pending_license_review unless verified).
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

  // Shared: license gate (physician soft / auditor hard) → provision → mark accepted.
  async function finalize({ authUserId, full_name_th, full_name_en, license_number, identity, session_token }) {
    let license_status = 'unverified', verifyResult = null;
    if (license_number) {
      verifyResult = await getVerifier().verify({ license_number, full_name_th, full_name_en });
      license_status = toLicenseStatus(verifyResult.status);
    }
    const status = (inv.role === 'auditor' && license_status !== 'verified' && license_status !== 'manual_verified')
      ? 'deactivated' : 'active';
    const prov = await provisionProfessional({
      authUserId, role: inv.role, councilId: inv.council_id,
      full_name_th, full_name_en, license_number: license_number ?? null,
      license_status, status, identity,
    });
    if (!prov.ok) return { http: prov.code === 'slot_full' ? 409 : 500, json: { error: prov.error } };
    if (verifyResult) await recordVerification({ professional_id: authUserId, license_number, name_checked: full_name_th, result: verifyResult });
    // Consume the invite ATOMICALLY: only succeeds if it's still pending (guards concurrent accepts).
    const { data: claimed } = await supabase.from('invites')
      .update({ status: 'accepted', accepted_at: new Date().toISOString(), professional_id: authUserId })
      .eq('id', inv.id).eq('status', 'pending').select('id');
    if (!claimed || claimed.length === 0) {
      return { http: 409, json: { error: 'This invite has already been used.' } };
    }
    return {
      http: status === 'active' ? 201 : 202,
      json: { status: status === 'active' ? 'active' : 'pending_license_review', access_token: session_token, user: { id: authUserId, ...prov.professional }, license_status },
    };
  }

  // Google method — email must match the invite; identity encrypted to the vault.
  if (body.method === 'google') {
    if (!OAUTH_ENABLED) return res.status(404).json({ error: 'Google sign-in is not available.' });
    if (!body.access_token) return res.status(400).json({ error: 'access_token is required.' });
    if (inv.role === 'auditor' && !body.license_number) return res.status(400).json({ error: 'License number is required for auditors.' });
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
      authUserId: user.id, full_name_th: name, full_name_en: name, license_number: body.license_number,
      identity: { provider: 'google', provider_subject: user.id, payload: { name, email: user.email } },
      session_token: body.access_token,
    });
    return res.status(out.http).json(out.json);
  }

  // Password method — bound to the invited email; two steps (send OTP, then verify+provision).
  if (!body.full_name_th || !body.full_name_en) return res.status(400).json({ error: 'Name is required.' });
  if (inv.role === 'auditor' && !body.license_number) return res.status(400).json({ error: 'License number is required for auditors.' });

  if (!body.otp) {
    if (!body.password) return res.status(400).json({ error: 'Password is required.' });
    const { data: created, error: cErr } = await supabase.auth.admin.createUser({
      email: inv.email, password: body.password, email_confirm: false,
      user_metadata: { invite_signup: { full_name_th: body.full_name_th, full_name_en: body.full_name_en, license_number: body.license_number ?? null } },
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
    license_number: body.license_number || md.license_number,
    identity: null,
    session_token: vData.session?.access_token,
  });
  return res.status(out.http).json(out.json);
});

module.exports = router;
