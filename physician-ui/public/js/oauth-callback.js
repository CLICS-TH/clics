// Google OAuth callback. Supabase redirected back here with the session in the URL;
// supabase-client.js (detectSessionInUrl) turns it into a session we read with getSession().
// Then one of two flows runs, distinguished by localStorage('clics_oauth_flow')
// (sessionStorage is read as a legacy fallback):
//   - invite  → POST /auth/invite/:token/accept { method:'google', access_token }
//   - signup  → POST /auth/oauth/google/complete { access_token } first; the council
//               picker shows ONLY if the backend answers 400 {code:'council_required'}
//               (i.e. a brand-new user) — existing users sign straight in.
// On success we store clics_token/clics_user and route by role.

const loadingCard = document.getElementById('loadingCard');
const councilCard = document.getElementById('councilCard');
const errorCard = document.getElementById('errorCard');
const doneCard = document.getElementById('doneCard');
const loadingMsg = document.getElementById('loadingMsg');

function show(card) {
  for (const c of [loadingCard, councilCard, errorCard, doneCard]) c.style.display = 'none';
  card.style.display = 'block';
}
function showError(msg) { document.getElementById('errorMsg').textContent = msg; show(errorCard); }

function errText(body) {
  if (!body) return 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่ / Sign-in failed. Please try again.';
  if (typeof body.error === 'string') return body.error;
  if (body.error?.fieldErrors) {
    const first = Object.values(body.error.fieldErrors).flat()[0];
    if (first) return first;
  }
  return 'เข้าสู่ระบบไม่สำเร็จ / Sign-in failed.';
}

function withClient(cb) {
  if (typeof window.CLICS_SUPABASE_CONFIGURED === 'boolean') { cb(); return; }
  window.addEventListener('clics:sbready', () => cb(), { once: true });
}

let accessToken = null;
let flow = { kind: 'signup' };

withClient(async () => {
  if (!window.sbClient) {
    showError('Google ยังไม่ถูกตั้งค่าในระบบนี้ / Google sign-in is not configured for this deployment.');
    return;
  }
  // A fresh sign-in supersedes any stored CLICS session — and a stale token here is actively
  // harmful (the login page auto-forwards on it, ping-ponging against the role guard).
  try { localStorage.removeItem('clics_token'); localStorage.removeItem('clics_user'); } catch {}
  // Prefer localStorage (survives the OAuth round-trip even in a fresh browsing context);
  // sessionStorage is the legacy fallback for markers written by older pages.
  try {
    const raw = localStorage.getItem('clics_oauth_flow') || sessionStorage.getItem('clics_oauth_flow');
    flow = JSON.parse(raw || '{}');
  } catch { flow = {}; }
  try { localStorage.removeItem('clics_oauth_flow'); } catch {}
  try { sessionStorage.removeItem('clics_oauth_flow'); } catch {}
  if (!flow.kind) flow.kind = 'signup';

  const { data } = await window.sbClient.auth.getSession();
  if (!data?.session?.access_token) {
    showError('ไม่พบเซสชันจาก Google ลิงก์อาจหมดอายุ กรุณาลองใหม่ / No Google session found. The link may have expired — please try again.');
    return;
  }
  accessToken = data.session.access_token;

  if (flow.kind === 'invite') { await completeInvite(); }
  else { await completeSignup(); }
});

// ---- Invite-Google flow ----
async function completeInvite() {
  if (!flow.token) { showError('ไม่พบรหัสคำเชิญ / Invite token missing.'); return; }
  const res = await api.acceptInvite(flow.token, {
    method: 'google',
    access_token: accessToken,
  });
  // An accepted invite is always active immediately (physician or auditor) — 201.
  if ((res.status === 201 || res.ok) && res.body?.access_token) {
    routeActive(res.body);
  } else {
    showError(errText(res.body));
  }
}

// ---- Normal Google signup flow ----
async function completeSignup() {
  // If a council was already chosen (re-entry after the picker), use it directly.
  if (flow.council_id) {
    const res = await api.oauthGoogleComplete(accessToken, flow.council_id);
    handleSignupResult(res);
    return;
  }
  // Otherwise try WITHOUT a council first: existing professionals get their account
  // straight back (no picker, ever). Only a brand-new user gets 400 'council_required'.
  const res = await api.oauthGoogleComplete(accessToken, undefined);
  const code = res.body?.error?.code || res.body?.code;
  if (res.status === 400 && code === 'council_required') {
    await populateCouncils();
    show(councilCard);
    return;
  }
  handleSignupResult(res); // ok/201 → routeActive; anything else → error card
}

async function populateCouncils() {
  const sel = document.getElementById('council');
  if (sel.options.length > 1) return; // already populated
  const res = await api.councils();
  if (res.ok && Array.isArray(res.body)) {
    for (const c of res.body) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name_th} / ${c.name_en}`;
      sel.appendChild(opt);
    }
  }
}

const councilBtn = document.getElementById('councilBtn');
if (councilBtn) {
  councilBtn.addEventListener('click', async () => {
    const councilErr = document.getElementById('councilErr');
    councilErr.style.display = 'none';
    const councilId = document.getElementById('council').value;
    if (!councilId) { councilErr.textContent = 'กรุณาเลือกสภาวิชาชีพ / Please select a council.'; councilErr.style.display = 'block'; return; }
    councilBtn.disabled = true; councilBtn.textContent = 'กำลังสร้างบัญชี... / Creating account...';
    show(loadingCard);
    const res = await api.oauthGoogleComplete(accessToken, councilId);
    councilBtn.disabled = false; councilBtn.textContent = 'ดำเนินการต่อ / Continue';
    handleSignupResult(res, /* fromPicker */ true);
  });
}

function handleSignupResult(res, fromPicker) {
  if ((res.status === 201 || res.ok) && res.body?.access_token) {
    routeActive(res.body);
    return;
  }
  if (res.status === 404) {
    showError('Google ยังไม่เปิดใช้งานในระบบนี้ / Google sign-in is not available on this deployment.');
    return;
  }
  if (fromPicker) {
    const councilErr = document.getElementById('councilErr');
    councilErr.textContent = errText(res.body); councilErr.style.display = 'block';
    show(councilCard);
    return;
  }
  showError(errText(res.body));
}

// ---- Store session + route by role ----
function routeActive(body) {
  localStorage.setItem('clics_token', body.access_token);
  if (body.user) localStorage.setItem('clics_user', JSON.stringify(body.user));
  const role = body.user?.role || 'physician';
  // Drop the local Supabase storage copy WITHOUT calling signOut(): the token we just stored as
  // clics_token IS this Supabase session's access token (verifyJwt validates via auth.getUser),
  // and gotrue's /logout terminates the current session server-side under EVERY scope (including
  // 'local' — that only spares other sessions), 401-ing all API calls right after login.
  try { for (const k of Object.keys(localStorage)) if (k.indexOf('sb-') === 0) localStorage.removeItem(k); } catch {}
  if (role === 'physician') {
    window.location.href = '/dashboard';
  } else {
    window.location.href = (window.CLICS_DASHBOARD_URL || 'http://localhost:3002') + '/login?token=' + encodeURIComponent(body.access_token);
  }
}
