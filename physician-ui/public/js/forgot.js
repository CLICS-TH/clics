// Forgot-password request. Backend POST /auth/forgot-password ALWAYS returns 200 { ok:true }
// (it never reveals whether the account exists), so we always show the same neutral success.
// The reset link itself lands on /reset (handled by reset.js via the Supabase recovery session).

const formCard = document.getElementById('formCard');
const successCard = document.getElementById('successCard');
const sendBtn = document.getElementById('sendBtn');
const emailInput = document.getElementById('email');
const formErr = document.getElementById('formErr');

function showForm() {
  formCard.style.display = 'none';
  successCard.style.display = 'block';
}

async function submit() {
  formErr.style.display = 'none';
  const email = emailInput.value.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    formErr.textContent = 'กรุณากรอกอีเมลที่ถูกต้อง / Please enter a valid email.';
    formErr.style.display = 'block';
    return;
  }
  sendBtn.disabled = true; sendBtn.textContent = 'กำลังส่ง... / Sending...';
  await api.forgotPassword(email); // always 200; ignore the body deliberately
  sendBtn.disabled = false; sendBtn.textContent = 'ส่งลิงก์ตั้งรหัสผ่าน / Send reset link';
  showForm();
}

sendBtn.addEventListener('click', submit);
emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
