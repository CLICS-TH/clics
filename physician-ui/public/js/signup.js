// Physician self-service signup: details + license → email OTP → verify → auto-provision.
// Backend: POST /auth/signup/email (202 otp_sent) → POST /auth/signup/verify-otp
// (201 { access_token, user, license_status }). License check is SOFT — the account is
// always provisioned; license_status tells the physician whether it was verified or queued.

const formCard = document.getElementById('formCard');
const otpCard = document.getElementById('otpCard');
const doneCard = document.getElementById('doneCard');

// Carried between step 1 and step 2.
let pendingEmail = '';

function errText(body) {
  if (!body) return 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong.';
  if (typeof body.error === 'string') return body.error;
  if (body.error?.fieldErrors) {
    const first = Object.values(body.error.fieldErrors).flat()[0];
    if (first) return first;
  }
  return 'กรุณาตรวจสอบข้อมูล / Please check your input.';
}

function showErr(el, msg) { el.textContent = msg; el.style.display = 'block'; }
function hideErr(el) { el.style.display = 'none'; }

// ---- Populate the council picker ----
(async () => {
  const sel = document.getElementById('council');
  const res = await api.councils();
  if (res.ok && Array.isArray(res.body)) {
    for (const c of res.body) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name_th} / ${c.name_en}`;
      sel.appendChild(opt);
    }
  }
})();

// ---- Step 1: submit details, request OTP ----
const submitBtn = document.getElementById('submitBtn');
const formErr = document.getElementById('formErr');

submitBtn.addEventListener('click', async () => {
  const body = {
    full_name_th: document.getElementById('th').value.trim(),
    full_name_en: document.getElementById('en').value.trim(),
    council_id: document.getElementById('council').value || undefined,
    license_number: document.getElementById('license').value.trim(),
    email: document.getElementById('email').value.trim(),
    password: document.getElementById('password').value,
    specialty: document.getElementById('specialty').value.trim() || undefined,
  };
  hideErr(formErr);
  if (!body.full_name_th || !body.full_name_en || !body.council_id || !body.license_number || !body.email) {
    showErr(formErr, 'กรอกชื่อ สภาวิชาชีพ เลขใบประกอบฯ และอีเมล / Name, council, license number, and email are required.');
    return;
  }
  // Mirror the backend policy: ≥10 chars incl. a letter and a digit.
  if (body.password.length < 10 || !/[A-Za-z]/.test(body.password) || !/[0-9]/.test(body.password)) {
    showErr(formErr, 'รหัสผ่านต้องยาว ≥ 10 ตัว และมีทั้งตัวอักษรและตัวเลข / Password must be 10+ chars with a letter and a digit.');
    return;
  }
  submitBtn.disabled = true; submitBtn.textContent = 'กำลังส่ง... / Sending...';
  const res = await api.signupEmail(body);
  submitBtn.disabled = false; submitBtn.textContent = 'สมัครและส่งรหัส / Sign up & send code';

  if (res.ok || res.status === 202) {
    pendingEmail = (res.body && res.body.email) || body.email;
    document.getElementById('otpEmail').textContent = pendingEmail;
    formCard.style.display = 'none';
    otpCard.style.display = 'block';
    startCooldown();
    document.getElementById('otp').focus();
  } else {
    showErr(formErr, errText(res.body));
  }
});

// ---- Step 2: verify OTP ----
const verifyBtn = document.getElementById('verifyBtn');
const otpErr = document.getElementById('otpErr');
const otpInput = document.getElementById('otp');

verifyBtn.addEventListener('click', async () => {
  hideErr(otpErr);
  const token = otpInput.value.trim();
  if (!/^\d{4,10}$/.test(token)) {
    showErr(otpErr, 'กรอกรหัสที่ได้รับทางอีเมล / Enter the code from your email.');
    return;
  }
  verifyBtn.disabled = true; verifyBtn.textContent = 'กำลังยืนยัน... / Verifying...';
  const res = await api.verifySignupOtp(pendingEmail, token);
  verifyBtn.disabled = false; verifyBtn.textContent = 'ยืนยันรหัส / Verify code';

  if ((res.ok || res.status === 201) && res.body?.access_token) {
    localStorage.setItem('clics_token', res.body.access_token);
    localStorage.setItem('clics_user', JSON.stringify(res.body.user));
    showDone(res.body.license_status);
  } else {
    showErr(otpErr, errText(res.body));
  }
});

otpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyBtn.click(); });

// ---- Resend with cooldown ----
const resendLink = document.getElementById('resendLink');
const resendCooldown = document.getElementById('resendCooldown');
let cooldownTimer = null;

function startCooldown(seconds = 30) {
  let left = seconds;
  resendLink.style.pointerEvents = 'none';
  resendLink.style.opacity = '0.5';
  const tick = () => {
    resendCooldown.textContent = ` (${left}s)`;
    if (left <= 0) {
      clearInterval(cooldownTimer);
      resendCooldown.textContent = '';
      resendLink.style.pointerEvents = '';
      resendLink.style.opacity = '';
      return;
    }
    left -= 1;
  };
  tick();
  cooldownTimer = setInterval(tick, 1000);
}

resendLink.addEventListener('click', async (e) => {
  e.preventDefault();
  if (resendLink.style.pointerEvents === 'none') return;
  hideErr(otpErr);
  await api.resendSignupOtp(pendingEmail); // always 202; ignore body
  startCooldown();
});

// ---- Back to edit ----
document.getElementById('backLink').addEventListener('click', (e) => {
  e.preventDefault();
  otpCard.style.display = 'none';
  formCard.style.display = 'block';
});

// ---- Done: show license outcome ----
function showDone(licenseStatus) {
  let html;
  if (licenseStatus === 'verified' || licenseStatus === 'manual_verified') {
    html = '✅ <strong>ยืนยันใบประกอบวิชาชีพแล้ว / License verified.</strong><br/>'
      + 'บัญชีของคุณพร้อมใช้งานแล้ว เริ่มทำ PLE ได้ทันที<br/>'
      + 'Your account is active — you can start a PLE right away.';
  } else {
    html = '✅ <strong>สร้างบัญชีแล้ว / Account created.</strong><br/>'
      + 'เลขใบประกอบวิชาชีพถูกส่งให้ตรวจสอบ คุณเข้าใช้งานได้ระหว่างรอการตรวจสอบ<br/>'
      + 'Your license number was submitted for review. You can use the platform while it is checked.';
  }
  document.getElementById('doneMsg').innerHTML = html;
  otpCard.style.display = 'none';
  formCard.style.display = 'none';
  doneCard.style.display = 'block';
}
