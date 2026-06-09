// Google OAuth callback. Supabase redirected back here with the session in the URL;
// supabase-client.js (detectSessionInUrl) turns it into a session we read with getSession().
// Then one of two flows runs, distinguished by sessionStorage('clics_oauth_flow'):
//   - invite  → POST /auth/invite/:token/accept { method:'google', access_token, license_number? }
//   - signup  → POST /auth/oauth/google/complete { access_token, council_id }  (prompt council 1st time)
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
  try { flow = JSON.parse(sessionStorage.getItem('clics_oauth_flow') || '{}'); } catch { flow = {}; }
  sessionStorage.removeItem('clics_oauth_flow');
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
    license_number: flow.license_number || undefined,
  });
  if (res.status === 201 && res.body?.status === 'active') {
    routeActive(res.body);
  } else if (res.status === 202 && res.body?.status === 'pending_license_review') {
    document.getElementById('doneMsg').innerHTML =
      '⏳ <strong>ส่งเรื่องเพื่อตรวจสอบใบประกอบวิชาชีพ / Submitted for license review.</strong><br/>' +
      'บัญชีผู้ตรวจประเมินของคุณจะใช้งานได้เมื่อผู้ดูแลยืนยันใบประกอบวิชาชีพแล้ว<br/>' +
      'Your auditor account will activate once an administrator verifies your license.';
    show(doneCard);
  } else {
    showError(errText(res.body));
  }
}

// ---- Normal Google signup flow ----
async function completeSignup() {
  // If a council was already chosen (re-entry after the picker), use it; else try with none,
  // and on the very first sign-in the backend needs a council — so we prompt.
  const councilId = flow.council_id || null;
  if (!councilId) {
    // Existing users (already provisioned) don't need a council; the backend ignores it for them.
    // But new users do. We can't tell ahead of time, so attempt with a placeholder-free prompt:
    await populateCouncils();
    show(councilCard);
    return;
  }
  const res = await api.oauthGoogleComplete(accessToken, councilId);
  handleSignupResult(res);
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
  // Clean any Supabase session so only the backend token governs the app.
  if (window.sbClient) window.sbClient.auth.signOut().catch(() => {});
  if (role === 'physician') {
    window.location.href = '/dashboard';
  } else {
    window.location.href = (window.CLICS_DASHBOARD_URL || 'http://localhost:3002') + '/login?token=' + encodeURIComponent(body.access_token);
  }
}
