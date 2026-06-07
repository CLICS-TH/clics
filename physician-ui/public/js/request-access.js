// Self-service access request page. Two paths, both ending in a "pending approval"
// confirmation: (1) email+password request, (2) OAuth simulate (stubbed handshake).
const params = new URLSearchParams(location.search);

function showSuccess(html) {
  document.getElementById('emailCard').style.display = 'none';
  document.getElementById('oauthCard').style.display = 'none';
  document.getElementById('successMsg').innerHTML = html;
  document.getElementById('successCard').style.display = 'block';
}

function errText(body) {
  if (!body) return 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong.';
  if (typeof body.error === 'string') return body.error;
  if (body.error?.fieldErrors) {
    const first = Object.values(body.error.fieldErrors).flat()[0];
    if (first) return first;
  }
  return 'กรุณาตรวจสอบข้อมูล / Please check your input.';
}

// ---- Email request ----
const submitBtn = document.getElementById('submitBtn');
submitBtn.addEventListener('click', async () => {
  const body = {
    full_name_th: document.getElementById('th').value.trim(),
    full_name_en: document.getElementById('en').value.trim(),
    email: document.getElementById('email').value.trim(),
    password: document.getElementById('password').value,
    specialty: document.getElementById('specialty').value.trim() || undefined,
  };
  const err = document.getElementById('emailErr');
  err.style.display = 'none';
  if (!body.full_name_th || !body.full_name_en || !body.email || body.password.length < 8) {
    err.textContent = 'กรอกชื่อ อีเมล และรหัสผ่าน (≥ 8 ตัว) / Name, email, and an 8+ char password are required.';
    err.style.display = 'block';
    return;
  }
  submitBtn.disabled = true; submitBtn.textContent = 'กำลังส่ง... / Submitting...';
  const res = await api.requestAccess(body);
  submitBtn.disabled = false; submitBtn.textContent = 'ส่งคำขอ / Submit request';
  if (res.ok || res.status === 202) {
    showSuccess('✅ <strong>ส่งคำขอแล้ว / Request submitted.</strong><br/>บัญชีของคุณอยู่ในสถานะรอการอนุมัติ เมื่อผู้ดูแลอนุมัติแล้วคุณจะเข้าสู่ระบบด้วยอีเมลและรหัสผ่านนี้ได้<br/><br/>Your account is pending approval. Once an administrator approves it, sign in with this email and password.');
  } else {
    err.textContent = errText(res.body);
    err.style.display = 'block';
  }
});

// ---- OAuth simulate (stubbed handshake) ----
let activeProvider = null;
function openOAuth(provider) {
  activeProvider = provider;
  const label = provider === 'line' ? 'LINE' : 'Google';
  document.getElementById('emailCard').style.display = 'none';
  document.getElementById('oauthCard').style.display = 'block';
  document.getElementById('oauthTitle').textContent = `${label} — จำลองการล็อกอิน / Simulated sign-in`;
  document.getElementById('oauthNote').textContent =
    `รุ่นนี้ยังไม่ได้เชื่อม ${label} จริง — กรอกโปรไฟล์จำลองเพื่อสร้างคำขอ (identity จะถูกเก็บแบบเข้ารหัส on-prem). / `
    + `${label} isn't wired in this build — enter a mock profile to create a request (the identity is stored encrypted on-prem).`;
}

document.querySelectorAll('[data-provider]').forEach(b =>
  b.addEventListener('click', () => openOAuth(b.dataset.provider)));

const oauthSubmit = document.getElementById('oauthSubmit');
oauthSubmit.addEventListener('click', async () => {
  const name = document.getElementById('oauthName').value.trim();
  const email = document.getElementById('oauthEmail').value.trim() || undefined;
  const err = document.getElementById('oauthErr');
  err.style.display = 'none';
  if (!name) { err.textContent = 'กรอกชื่อที่แสดง / Display name is required.'; err.style.display = 'block'; return; }

  // In a real integration the provider returns a stable subject id; we mint one for the stub.
  const provider_subject = `${activeProvider}-${Math.random().toString(36).slice(2, 10)}`;
  oauthSubmit.disabled = true; oauthSubmit.textContent = 'กำลังดำเนินการ... / Working...';
  const res = await api.oauthMock(activeProvider, { provider_subject, name, email });
  oauthSubmit.disabled = false; oauthSubmit.textContent = 'ดำเนินการต่อ / Continue';

  if (res.status === 202 || res.ok) {
    showSuccess('✅ <strong>ส่งคำขอแล้ว / Request submitted.</strong><br/>คำขอผ่าน ' + (activeProvider === 'line' ? 'LINE' : 'Google') + ' อยู่ในสถานะรอการอนุมัติ<br/><br/>Your social sign-in request is pending approval.');
  } else if (res.status === 200 && res.body?.status === 'existing') {
    showSuccess('ℹ️ บัญชีนี้เชื่อมกับระบบแล้ว กรุณาเข้าสู่ระบบ / This identity is already linked — please sign in.');
  } else {
    err.textContent = errText(res.body);
    err.style.display = 'block';
  }
});

// Deep-link from the login page (?provider=google|line) opens the OAuth panel directly.
const initial = params.get('provider');
if (initial === 'google' || initial === 'line') openOAuth(initial);
