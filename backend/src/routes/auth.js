const { Router } = require('express');
const { z } = require('zod');
const { supabase, authSupabase, authAnon } = require('../lib/supabase');
const { verifyJwt } = require('../middleware/auth');
const { sendDbError } = require('../lib/db-helpers');
const { effectiveLimit } = require('../lib/usage');
const { provisionProfessional } = require('../lib/provisioning');
const { attachSpecialty, linkedProviders, specialtyInCouncil, councilHasSpecialties, specialtyName, TRAINING_LEVELS } = require('../lib/specialties');
const { encryptJson, decryptJson } = require('../lib/crypto');
const { hashToken } = require('../lib/invite-token');
const { logEvent } = require('../lib/audit');
const { pilotTestMode, peerCalibrationEnabled, identityVerificationRequired } = require('../lib/settings');
const identity = require('../services/identity');

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
// council_id is OPTIONAL: existing professionals never need one (the route returns their account
// before any council logic), and new users are told via 400 {code:'council_required'} — so the UI
// shows the council picker only when it is genuinely needed.
const GoogleCompleteSchema = z.object({
  access_token: z.string().min(10),
  council_id: z.string().uuid().optional(),
  specialty_id: z.string().uuid().optional(),   // picked alongside council on first sign-up
  // Highest medical training level — the self-signup step collects only the 5 TRAINING_LEVELS
  // (gp is admin-only), so onboarding can never set 'gp'.
  position: z.enum(TRAINING_LEVELS).optional(),
});

// A council a new member may join must exist AND be active.
async function activeCouncil(councilId) {
  const { data } = await supabase.from('councils').select('id, active').eq('id', councilId).maybeSingle();
  return data && data.active ? data : null;
}

// supabase-js has no getUserByEmail; scan the admin list (cheap at pilot scale). Used by the invite
// password flow to recover a half-provisioned account whose email already has an auth user.
async function findAuthUserByEmail(email) {
  const target = (email || '').toLowerCase();
  for (let page = 1; page <= 20; page++) { // cap 20*200 = 4000 users, ample for the pilot
    const { data, error } = await authSupabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find(u => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null; // last page
  }
  return null;
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
  if (sendDbError(res, error)) return; // generic in prod — this is a PUBLIC pre-auth endpoint
  res.json(data ?? []);
});

// Public specialty list for the sign-up picker (the layer under council). ?council_id= scopes it.
router.get('/specialties', async (req, res) => {
  let query = supabase.from('specialties')
    .select('id, council_id, code, name_th, name_en').eq('active', true).order('sort');
  if (typeof req.query.council_id === 'string' && req.query.council_id) query = query.eq('council_id', req.query.council_id);
  const { data, error } = await query;
  if (sendDbError(res, error)) return;
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
    user: await attachSpecialty({ id: data.user.id, email: data.user.email, ...prof }),
  });
});

router.post('/logout', verifyJwt, async (req, res) => {
  // Actually revoke the caller's session server-side. signOut() on the service-role data client is
  // a no-op (it holds no session), so the token stayed valid for the full ~12h TTL after "logout".
  // verifyJwt validates every request via authSupabase.auth.getUser, so an admin signOut of this
  // JWT makes the token 401 on its next use. (Explicit logout — does NOT conflict with the
  // "never signOut after STORING the token" login rule.)
  const token = req.headers.authorization.slice(7);
  try {
    await authSupabase.auth.admin.signOut(token, 'global');
  } catch (e) {
    console.error('[auth] logout revoke failed:', e.message); // best-effort; client clears storage regardless
  }
  res.json({ ok: true });
});

router.get('/me', verifyJwt, async (req, res) => {
  // Attach the effective AI-usage limit so the client can render the usage bar without
  // needing to know the org standard default (usage_cost_usd already flows via req.user).
  const usage_limit_effective_usd = await effectiveLimit(req.user);
  // The auditor budget is a SEPARATE pool — surface its effective limit too so the dashboard can show
  // an auditor usage bar (auditor_usage_cost_usd already flows via req.user from select('*')).
  const auditor_usage_limit_effective_usd = await effectiveLimit(req.user, 'auditor');
  // specialty_name_* powers the nav-bar label; linked_providers drives the "Link Google" affordance.
  const enriched = await attachSpecialty(req.user);
  const linked_providers = await linkedProviders(req.user.id);
  res.json({ user: { ...enriched, usage_limit_effective_usd, auditor_usage_limit_effective_usd, linked_providers } });
});

// ---- Payment details (compensation payout, CLICS §12) ----------------------------------------
// A physician provides their own bank / PromptPay details so the team can pay ฿500 per completed CLE.
// Highly sensitive PII → encrypted on-prem with IDENTITY_ENC_KEY (lib/crypto), exactly like the OAuth
// identity vault. Self-service only: a physician reads/writes their OWN row; the superadmin reads it
// (audit-logged) at payout time. Never sent to cloud AI.
const PaymentInfoSchema = z.object({
  account_name: z.string().trim().min(1).max(120),
  bank:         z.string().trim().max(80).optional().default(''),
  account_no:   z.string().trim().max(40).optional().default(''),
  promptpay:    z.string().trim().max(40).optional().default(''),
}).refine((d) => (d.account_no && d.account_no.length > 0) || (d.promptpay && d.promptpay.length > 0), {
  message: 'Provide a bank account number or a PromptPay ID.',
});

router.post('/payment-info', verifyJwt, async (req, res) => {
  // Physician-only: compensation is paid per completed CLE, which only physicians run (a "special"
  // dual-role physician keeps role='physician'). Auditors/admins/oversight have no payout.
  if (req.user.role !== 'physician') return res.status(403).json({ error: 'Payment details are for physicians only.' });
  const parsed = PaymentInfoSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const enc = encryptJson(parsed.data);
  const { error } = await supabase.from('payment_info')
    .upsert({ physician_id: req.user.id, enc, updated_at: new Date().toISOString() }, { onConflict: 'physician_id' });
  if (sendDbError(res, error)) return;
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'payment_info.update', targetType: 'professional', targetId: req.user.id });
  res.json({ ok: true });
});

// The caller's own payment details (decrypted) so they can review/edit. Returns null if none saved.
router.get('/payment-info', verifyJwt, async (req, res) => {
  if (req.user.role !== 'physician') return res.status(403).json({ error: 'Payment details are for physicians only.' });
  const { data } = await supabase.from('payment_info').select('enc, updated_at').eq('physician_id', req.user.id).maybeSingle();
  if (!data) return res.json({ payment_info: null });
  let info = null;
  try { info = decryptJson(data.enc); } catch { info = null; } // unreadable blob (e.g. key rotated) → treat as none
  res.json({ payment_info: info, updated_at: data.updated_at });
});

// A physician asks to ALSO become an auditor (the "special" dual role). Creates a pending
// role request that ONLY a superadmin approves via /admin/auditor-requests (admins see their
// council's queue read-only). Reuses the access_requests table (requested_role='auditor').
router.post('/request-auditor', verifyJwt, async (req, res) => {
  if (req.user.role !== 'physician') return res.status(403).json({ error: 'Only physicians can request auditor rights.' });
  if (req.user.can_audit) return res.status(409).json({ error: 'You already have auditor rights.', code: 'already_auditor' });
  const { data: dup } = await supabase.from('access_requests')
    .select('id').eq('auth_user_id', req.user.id).eq('requested_role', 'auditor').eq('status', 'pending').maybeSingle();
  if (dup) return res.status(409).json({ error: 'Your request is already pending.', code: 'pending' });
  const { error } = await supabase.from('access_requests').insert({
    email: req.user.email, full_name_th: req.user.full_name_th, full_name_en: req.user.full_name_en,
    specialty: req.user.specialty ?? null, council_id: req.user.council_id,
    provider: 'role_request', auth_user_id: req.user.id, requested_role: 'auditor', status: 'pending',
  });
  if (sendDbError(res, error)) return;
  res.status(202).json({ status: 'pending' });
});

// GET /auth/request-auditor — the caller's own pending/last auditor request (drives the button state).
router.get('/request-auditor', verifyJwt, async (req, res) => {
  const { data } = await supabase.from('access_requests')
    .select('status, reviewed_at').eq('auth_user_id', req.user.id).eq('requested_role', 'auditor')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  res.json({ request: data ?? null, can_audit: req.user.can_audit === true });
});

// Record the participant's informed consent (human-subjects pilot). consented_at is the gate signal
// for BOTH physician session creation (Appendix 03) and auditor scoring (Appendix 04 + COI 15); the
// structured per-checkbox + COI record is kept in `consents` for the ethics audit.
const ConsentSchema = z.object({
  context: z.enum(['physician', 'auditor']).optional(),
  version: z.string().max(40).optional(),
  checkboxes: z.record(z.boolean()).optional(),
  coi: z.record(z.any()).optional(),
});
// ---- Identity verification (CREC082 ICF §4) --------------------------------------------------
// The physician's side: submit a national ID + licence pair, and see where the submission stands.
// The administrator's side lives in routes/admin.js. Nothing here ever returns a national ID.

const IdentitySchema = z.object({
  // Accepted with spaces/hyphens because that is how the number is printed on the card; normalised
  // and checksum-validated in services/identity. Never logged, never echoed back.
  national_id: z.string().min(13).max(20),
  license_number: z.string().trim().min(1).max(40),
});

router.post('/identity/national-id', verifyJwt, async (req, res) => {
  const parsed = IdentitySchema.safeParse(req.body ?? {});
  // The generic 400 is deliberate: a validation error naming the field is fine, but the submitted
  // value must not appear in a response body or a log line.
  if (!parsed.success) return res.status(400).json({ error: 'National ID and licence number are required.', code: 'invalid_input' });

  const out = await identity.submitNationalIdLicense({
    physicianId: req.user.id,
    national_id: parsed.data.national_id,
    license_number: parsed.data.license_number,
    full_name_th: req.user.full_name_th, full_name_en: req.user.full_name_en,
  });
  if (!out.ok) {
    const status = out.code === 'submit_failed' ? 500 : 400;
    return res.status(status).json({ error: IDENTITY_ERRORS[out.code] ?? 'Could not submit.', code: out.code });
  }
  // The licence number is not sensitive in the way the national ID is (it is a public register), so
  // it may be logged; the national ID must not be, not even its last four digits.
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'identity.submit',
    targetType: 'professional', targetId: req.user.id, councilId: req.user.council_id ?? null,
    metadata: { method: 'national_id_license', license_check_status: out.license_check_status } });
  res.status(201).json({ ok: true, status: out.status, license_check_status: out.license_check_status });
});

const IDENTITY_ERRORS = {
  invalid_national_id: 'เลขประจำตัวประชาชนไม่ถูกต้อง / That national ID number is not valid.',
  license_required: 'กรุณากรอกเลขที่ใบอนุญาต / A licence number is required.',
  national_id_already_used: 'เลขนี้ถูกใช้กับบัญชีอื่นแล้ว กรุณาติดต่อผู้ดูแล / That number is already registered to another account. Please contact an administrator.',
};

router.get('/identity/status', verifyJwt, async (req, res) => {
  try {
    const [state, required] = await Promise.all([
      identity.statusFor(req.user.id),
      identityVerificationRequired(),
    ]);
    res.json({ ...state, required });
  } catch (e) {
    console.error('[auth] identity status failed:', e.message);
    res.status(500).json({ error: 'Could not load verification status.' });
  }
});

router.post('/consent', verifyJwt, async (req, res) => {
  const parsed = ConsentSchema.safeParse(req.body ?? {});
  const body = parsed.success ? parsed.data : {};
  const ctx = body.context ?? (req.user.role === 'auditor' ? 'auditor' : 'physician');
  const version = body.version ?? (ctx === 'auditor' ? 'auditor-v1' : 'physician-v1');
  const now = new Date().toISOString();

  // Write the AUDITABLE RECORD FIRST, then the gate flag. The old order did the reverse, so a failed
  // record left a physician marked as consented with no evidence behind it — invisible to us and
  // exactly the gap an ethics committee asks about. In this order a failure leaves no consent at all
  // and the physician simply retries; the upsert is idempotent on (professional_id, role_context,
  // consent_version), so a retry is safe.
  //
  // Note the old code also could not see most failures: supabase .upsert() RETURNS { error } rather
  // than throwing, so the try/catch around it caught almost nothing and a real DB error (RLS,
  // constraint) was silently discarded. Inspect the returned error.
  let consentRecordDegraded = null;
  try {
    const { error: cErr } = await supabase.from('consents').upsert({
      professional_id: req.user.id, role_context: ctx, consent_version: version,
      checkboxes: body.checkboxes ?? {}, coi: body.coi ?? null, agreed_at: now,
    }, { onConflict: 'professional_id,role_context,consent_version' });
    if (cErr) {
      // Missing table = a pre-migration environment. Known, uniform, and recoverable by running the
      // migration — degrade rather than lock everyone out. Anything else is a real failure to record
      // evidence, so refuse before the gate flag is set.
      if (cErr.code === '42P01' || /consents/.test(cErr.message ?? '')) {
        consentRecordDegraded = cErr.message;
        console.error('[consent] consents table unavailable — gate set without structured record:', cErr.message);
      } else {
        console.error('[consent] structured record failed:', cErr.message);
        return res.status(500).json({ error: 'Could not record consent. Please try again.', code: 'consent_record_failed' });
      }
    }
  } catch (e) {
    // A test mock without .upsert throws rather than returning — keep that path fail-soft.
    consentRecordDegraded = e.message;
    console.error('[consent] structured record unavailable:', e.message);
  }

  const { error } = await supabase.from('professionals').update({ consented_at: now }).eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  // Record the degradation in the audit log too: "consent gated but not evidenced" must be findable
  // later, not just a line in a container log nobody reads.
  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'consent', targetType: 'professional',
    targetId: req.user.pseudonym ?? req.user.exp_code ?? req.user.id, councilId: req.user.council_id,
    metadata: { context: ctx, version, ...(consentRecordDegraded ? { record_degraded: consentRecordDegraded } : {}) } });
  res.json({ ok: true, consented_at: now, context: ctx, ...(consentRecordDegraded ? { record_degraded: true } : {}) });
});

// Whether Pilot Test Mode is on — lets the new-CLE page reveal the Natural/Socratic picker.
// Feature flags any authed user may read (the superadmin /admin/usage-settings is superadmin-only).
// peer_calibration drives the admin's multi-auditor assign UI + the auditor's peer radar.
router.get('/pilot-mode', verifyJwt, async (_req, res) => {
  const [pilot_test_mode, peer_calibration] = await Promise.all([pilotTestMode(), peerCalibrationEnabled()]);
  res.json({ pilot_test_mode, peer_calibration });
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
// Loud 404 stubs (same style as /request-access below) so stale clients fail with a clear message.
// ---------------------------------------------------------------------------
router.post(['/signup/email', '/signup/verify-otp', '/signup/resend-otp'], (_req, res) =>
  res.status(404).json({ error: 'Self-service signup is retired — sign in with Google or use an invite link.' }));

// POST /auth/forgot-password — always 200 (never leak whether an account exists).
router.post('/forgot-password', async (req, res) => {
  const parsed = EmailOnlySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await authAnon.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${SITE_URL}/reset` }).catch(() => {});
  res.json({ ok: true });
});

// A Supabase session must actually be GOOGLE-issued before we trust its verified email to provision
// (or onboard into) an account. The anon key is public, so a token minted via any other provider
// (e.g. if email/password signup were ever enabled at Supabase) must not pass. Shared by BOTH the
// self-signup path AND the invite-accept Google path so the two can never drift apart.
function isGoogleSession(user) {
  const providers = user.app_metadata?.providers
    || (user.app_metadata?.provider ? [user.app_metadata.provider] : []);
  return providers.includes('google');
}

// POST /auth/oauth/google/complete — the browser finishes Supabase's Google handshake client-side,
// then posts the session access_token here. We VALIDATE it server-side (never trust client-sent
// name/email), encrypt the identity into the on-prem vault, and auto-provision a physician.
// Google verifies the EMAIL; the physician self-serves via Google and is active immediately.
router.post('/oauth/google/complete', oauthGate, async (req, res) => {
  const parsed = GoogleCompleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { access_token, council_id, specialty_id, position } = parsed.data;

  const { data: uData, error: uErr } = await authSupabase.auth.getUser(access_token);
  if (uErr || !uData?.user) return res.status(401).json({ error: 'Invalid Google session.' });
  const user = uData.user;

  const { data: prof } = await supabase.from('professionals').select('*').eq('id', user.id).maybeSingle();
  if (prof) {
    // Mirror the /login gate — a deactivated account must not be handed a session.
    if (prof.status === 'deactivated') {
      return res.status(403).json({ error: 'Account deactivated. Contact an administrator.', code: 'deactivated' });
    }
    return res.json({ access_token, user: await attachSpecialty({ id: user.id, email: user.email, ...prof }) });
  }

  // Defense-in-depth: this endpoint AUTO-PROVISIONS an active physician with no invite, so the
  // session must actually be Google-issued. (Checked only on the new-user path — existing accounts
  // already returned above, unaffected.)
  if (!isGoogleSession(user)) {
    return res.status(403).json({ error: 'Google sign-in is required to create an account.' });
  }

  // A NEW user needs a council — tell the client to prompt for one (the only time the picker shows).
  if (!council_id) return res.status(400).json({ error: 'เลือกสภาวิชาชีพ / Pick your professional council.', code: 'council_required' });
  if (!(await activeCouncil(council_id))) return res.status(400).json({ error: 'Unknown or inactive council.' });
  // …and a specialty (the layer under council) when that council has any. The client's picker
  // cascades council → specialty; this drives it via the same one-time prompt.
  // Onboarding order: council → training level → specialty. A medical council requires both; check
  // the training level first so the client prompts in that order.
  if (await councilHasSpecialties(council_id)) {
    if (!position) return res.status(400).json({ error: 'เลือกระดับการฝึกอบรม / Pick your medical training level.', code: 'position_required' });
    if (!specialty_id) return res.status(400).json({ error: 'เลือกความเชี่ยวชาญ / Pick your specialty.', code: 'specialty_required' });
    if (!(await specialtyInCouncil(specialty_id, council_id))) return res.status(400).json({ error: 'Specialty does not belong to the selected council.' });
  }

  // Identity is read from the VALIDATED token, never from the request body.
  const md = user.user_metadata || {};
  const name = md.full_name || md.name || user.email;
  const prov = await provisionProfessional({
    authUserId: user.id, role: 'physician', councilId: council_id, specialtyId: specialty_id ?? null,
    position: position ?? null,
    full_name_th: name, full_name_en: name, status: 'active',
    identity: { provider: 'google', provider_subject: user.id, payload: { name, email: user.email } },
  });
  if (!prov.ok) return res.status(prov.code === 'slot_full' ? 409 : 500).json({ error: prov.error });

  res.status(201).json({ access_token, user: await attachSpecialty({ id: user.id, email: user.email, ...prov.professional }) });
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
  const specialty = inv.specialty_id ? await specialtyName(inv.specialty_id) : null;
  res.json({ email: inv.email, role: inv.role, council: council ?? null, specialty, position: inv.position ?? null });
});

// POST /auth/invite/:token/accept — finalize in the invited role.
router.post('/invite/:token/accept', async (req, res) => {
  const parsed = InviteAcceptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const body = parsed.data;
  const inv = await loadPendingInvite(req.params.token, res);
  if (!inv) return;

  // Shared: provision in the invited role (ACTIVE on accept — the A/B invite is the vetting),
  // then consume the invite atomically. A "Special" invite (physician + can_audit) flows through.
  async function finalize({ authUserId, full_name_th, full_name_en, identity, session_token }) {
    const prov = await provisionProfessional({
      authUserId, role: inv.role, councilId: inv.council_id,
      specialtyId: inv.specialty_id ?? null, position: inv.position ?? null,
      full_name_th, full_name_en, status: 'active', identity,
      can_audit: inv.can_audit === true,
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
      json: { status: 'active', access_token: session_token, user: await attachSpecialty({ id: authUserId, ...prov.professional }) },
    };
  }

  // Google method — email must match the invite; identity encrypted to the vault.
  if (body.method === 'google') {
    if (!OAUTH_ENABLED) return res.status(404).json({ error: 'Google sign-in is not available.' });
    if (!body.access_token) return res.status(400).json({ error: 'access_token is required.' });
    const { data: uData, error } = await authSupabase.auth.getUser(body.access_token);
    if (error || !uData?.user) return res.status(401).json({ error: 'Invalid Google session.' });
    const user = uData.user;
    // The invite path provisions admin/auditor (HIGHER privilege than self-signup), so it must apply
    // the SAME provider guard as the signup path — otherwise a non-Google session for an invited email
    // could claim the invited role. (Was missing here; the sibling /oauth/google/complete had it.)
    if (!isGoogleSession(user)) {
      return res.status(403).json({ error: 'Google sign-in is required to accept this invite.' });
    }
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
    const userMeta = { invite_signup: { full_name_th: body.full_name_th, full_name_en: body.full_name_en } };
    const { data: created, error: cErr } = await supabase.auth.admin.createUser({
      email: inv.email, password: body.password, email_confirm: false, user_metadata: userMeta,
    });
    if (cErr) {
      // The email already has an auth user. Distinguish a HALF-PROVISIONED invite (an earlier
      // attempt created the user + sent an OTP, then was abandoned → no professionals row yet) from a
      // fully-registered account. Without recovery the invitee was bricked: retry 409'd "sign in",
      // but sign-in 403s (no professionals row). Recover the half-provisioned case in place.
      const existing = await findAuthUserByEmail(inv.email);
      if (existing) {
        const { data: prof } = await supabase.from('professionals').select('id').eq('id', existing.id).maybeSingle();
        if (prof) return res.status(409).json({ error: 'This email is already registered. Sign in instead.' });
        // Reuse the pending user: apply the newly-entered password + name, then (re)send the code.
        await supabase.auth.admin.updateUserById(existing.id, { password: body.password, user_metadata: userMeta });
      }
      const { error: otpErr } = await authAnon.auth.signInWithOtp({ email: inv.email, options: { shouldCreateUser: false } });
      if (otpErr) return res.status(502).json({ error: 'Could not send the verification code. Please try again.' });
      return res.status(202).json({ status: 'otp_sent', email: inv.email });
    }
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

// POST /auth/link-google — a password/invited user links their Google account. The browser runs the
// Supabase Google handshake, then posts that session token here WITH the user's existing CLICS bearer
// token. We record the identity in the on-prem vault ONLY when Supabase resolved the Google sign-in to
// the SAME auth user (same confirmed email → Supabase auto-links), proving a real link rather than a
// second account. Idempotent: re-linking an already-linked account is a no-op success.
router.post('/link-google', verifyJwt, async (req, res) => {
  if (!OAUTH_ENABLED) return res.status(404).json({ error: 'Google sign-in is not available.' });
  const token = (req.body?.access_token || '').toString();
  if (token.length < 10) return res.status(400).json({ error: 'access_token is required.' });

  const { data: uData, error } = await authSupabase.auth.getUser(token);
  if (error || !uData?.user) return res.status(401).json({ error: 'Invalid Google session.' });
  const guser = uData.user;
  if (!isGoogleSession(guser)) return res.status(403).json({ error: 'Google sign-in is required.' });

  // Must resolve to the SAME auth user. A different id means Google created a SEPARATE account
  // (no same-email auto-link) — refuse to link rather than silently fork the identity.
  if (guser.id !== req.user.id || (guser.email || '').toLowerCase() !== (req.user.email || '').toLowerCase()) {
    return res.status(409).json({ error: 'This Google account is registered separately and cannot be linked. Sign in with Google directly, or contact an administrator.' });
  }

  const existing = await linkedProviders(req.user.id);
  if (existing.includes('google')) return res.json({ ok: true, linked_providers: existing });

  const md = guser.user_metadata || {};
  const { error: insErr } = await supabase.from('oauth_identities').insert({
    auth_user_id: req.user.id, professional_id: req.user.id,
    provider: 'google', provider_subject: guser.id,
    identity_encrypted: encryptJson({ name: md.full_name || md.name || guser.email, email: guser.email }),
  });
  if (insErr) return res.status(500).json({ error: insErr.message });

  logEvent({ actorId: req.user.id, actorRole: req.user.role, action: 'identity.link', targetType: 'professional',
    targetId: req.user.pseudonym ?? req.user.exp_code ?? req.user.id, councilId: req.user.council_id,
    metadata: { provider: 'google' } });
  res.json({ ok: true, linked_providers: [...new Set([...existing, 'google'])] });
});

module.exports = router;
