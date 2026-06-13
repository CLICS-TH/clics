// Invite acceptance. Reads ?token=, looks up the invite (email + role + council bound to it),
// then lets the invitee finish via Google (OAuth) OR a password (two-step OTP).
// Backend: GET /auth/invite/:token  →  POST /auth/invite/:token/accept.
//  - password step1 (no otp) → 202 otp_sent;  step2 (with otp) → 201 active
//  - google → 201 active
// An accepted invite is always 'active' immediately — physicians AND auditors. There is
// no license gate and no 'pending_license_review' state.

const loadingCard = document.getElementById('loadingCard');
const invalidCard = document.getElementById('invalidCard');
const acceptCard = document.getElementById('acceptCard');
const otpCard = document.getElementById('otpCard');
const doneCard = document.getElementById('doneCard');

const params = new URLSearchParams(location.search);
const token = params.get('token') || '';

let invite = null; // { email, role, council }

function show(card) {
  for (const c of [loadingCard, invalidCard, acceptCard, otpCard, doneCard]) c.style.display = 'none';
  card.style.display = 'block';
}
function showInvalid(msg) { document.getElementById('invalidMsg').textContent = msg; show(invalidCard); }
function showErr(el, msg) { el.textContent = msg; el.style.display = 'block'; }
function hideErr(el) { el.style.display = 'none'; }

function errText(body) {
  if (!body) return 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong.';
  if (typeof body.error === 'string') return body.error;
  if (body.error?.fieldErrors) {
    const first = Object.values(body.error.fieldErrors).flat()[0];
    if (first) return first;
  }
  return 'กรุณาตรวจสอบข้อมูล / Please check your input.';
}

function roleLabel(role) {
  return role === 'auditor' ? 'ผู้ตรวจประเมิน / Auditor'
    : role === 'physician' ? 'แพทย์ / Physician'
    : role === 'admin' ? 'ผู้ดูแลสภา / Council admin'
    : role;
}

// ---- Load the invite ----
(async () => {
  if (!token) { showInvalid('ไม่พบรหัสคำเชิญในลิงก์ / No invite token in this link.'); return; }
  const res = await api.getInvite(token);
  if (res.status === 410) { showInvalid('คำเชิญนี้หมดอายุแล้ว กรุณาติดต่อผู้ดูแลเพื่อขอคำเชิญใหม่ / This invite has expired. Ask an administrator for a new one.'); return; }
  if (!res.ok || !res.body) { showInvalid('ไม่พบคำเชิญนี้ / Invite not found.'); return; }

  invite = res.body;
  // Escape server-provided values before innerHTML (defense-in-depth: email passes zod and council
  // names are superadmin-set, but this is the one spot interpolating API data into markup).
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const councilName = invite.council ? `${esc(invite.council.name_th)} / ${esc(invite.council.name_en)}` : '—';
  document.getElementById('inviteMeta').innerHTML =
    `คุณได้รับเชิญในบทบาท / You're invited as:<br/><strong>${esc(roleLabel(invite.role))}</strong><br/>` +
    `อีเมล / Email: <strong>${esc(invite.email)}</strong><br/>` +
    `สภาวิชาชีพ / Council: <strong>${councilName}</strong>`;

  show(acceptCard);
})();

// ---- Google method (only when Supabase is configured) ----
function withClient(cb) {
  if (typeof window.CLICS_SUPABASE_CONFIGURED === 'boolean') { cb(); return; }
  window.addEventListener('clics:sbready', () => cb(), { once: true });
}

withClient(() => {
  if (!window.sbClient) return; // OAuth not configured → password-only (Google block stays hidden)
  document.getElementById('googleWrap').style.display = '';
  document.getElementById('googleBtn').addEventListener('click', async () => {
    const acceptErr = document.getElementById('acceptErr');
    hideErr(acceptErr);
    // Stash the invite context so /auth/callback knows to acceptInvite (not the normal signup).
    // localStorage (not sessionStorage): the OAuth round-trip can come back in a fresh
    // browsing context where sessionStorage is empty.
    localStorage.setItem('clics_oauth_flow', JSON.stringify({
      kind: 'invite', token,
    }));
    const redirectTo = location.origin + '/auth/callback';
    const { error } = await window.sbClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error) showErr(acceptErr, error.message || 'ไม่สามารถเริ่ม Google ได้ / Could not start Google sign-in.');
  });
});

// ---- Password method, step 1: create + send OTP ----
const passwordBtn = document.getElementById('passwordBtn');
const acceptErr = document.getElementById('acceptErr');

passwordBtn.addEventListener('click', async () => {
  hideErr(acceptErr);
  const full_name_th = document.getElementById('th').value.trim();
  const full_name_en = document.getElementById('en').value.trim();
  const password = document.getElementById('password').value;

  if (!full_name_th || !full_name_en) { showErr(acceptErr, 'กรุณากรอกชื่อ–สกุล / Please enter your full name.'); return; }
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    showErr(acceptErr, 'รหัสผ่านต้องยาว ≥ 10 ตัว และมีทั้งตัวอักษรและตัวเลข / Password must be 10+ chars with a letter and a digit.');
    return;
  }

  passwordBtn.disabled = true; passwordBtn.textContent = 'กำลังส่ง... / Sending...';
  const res = await api.acceptInvite(token, {
    method: 'password', password, full_name_th, full_name_en,
  });
  passwordBtn.disabled = false; passwordBtn.textContent = 'ตั้งรหัสผ่านและส่งรหัส / Set password & send code';

  if (res.status === 202 && res.body?.status === 'otp_sent') {
    document.getElementById('otpEmail').textContent = res.body.email || invite.email;
    show(otpCard);
    document.getElementById('otp').focus();
  } else {
    showErr(acceptErr, errText(res.body));
  }
});

// ---- Password method, step 2: verify OTP + provision ----
const verifyBtn = document.getElementById('verifyBtn');
const otpErr = document.getElementById('otpErr');
const otpInput = document.getElementById('otp');

verifyBtn.addEventListener('click', async () => {
  hideErr(otpErr);
  const otp = otpInput.value.trim();
  if (!/^\d{4,10}$/.test(otp)) { showErr(otpErr, 'กรอกรหัสที่ได้รับทางอีเมล / Enter the code from your email.'); return; }

  verifyBtn.disabled = true; verifyBtn.textContent = 'กำลังยืนยัน... / Verifying...';
  const res = await api.acceptInvite(token, {
    method: 'password', otp,
    full_name_th: document.getElementById('th').value.trim(),
    full_name_en: document.getElementById('en').value.trim(),
  });
  verifyBtn.disabled = false; verifyBtn.textContent = 'ยืนยันและเข้าร่วม / Verify & join';

  if (res.status === 201 || res.status === 202) {
    finishAccept(res.body);
  } else {
    showErr(otpErr, errText(res.body));
  }
});

otpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyBtn.click(); });

// ---- Done: an accepted invite is always active (physician or auditor) ----
function finishAccept(body) {
  const cta = document.getElementById('doneCta');

  // Active → store session + route by role.
  localStorage.setItem('clics_token', body.access_token);
  if (body.user) localStorage.setItem('clics_user', JSON.stringify(body.user));
  const role = body.user?.role || invite.role;
  document.getElementById('doneMsg').innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg> <strong>เข้าร่วมเรียบร้อย / You\'re in.</strong><br/>บัญชีของคุณพร้อมใช้งานแล้ว<br/>Your account is active.';
  if (role === 'physician') {
    cta.textContent = 'ไปที่แดชบอร์ด / Go to dashboard →';
    cta.href = '/dashboard';
  } else {
    cta.textContent = 'ไปที่คอนโซล / Go to console →';
    cta.href = (window.CLICS_DASHBOARD_URL || 'http://localhost:3002') + '/login?token=' + encodeURIComponent(body.access_token);
  }
  show(doneCard);
}

// Expose for the OAuth callback to reuse the same "done" rendering if it ever lands back here.
window.clicsFinishAccept = finishAccept;
