// Self-service access request page: email+password request → "pending approval" confirmation.
// (Social sign-in via Google/LINE is disabled for the pilot — email+password only.)
function showSuccess(html) {
  document.getElementById('emailCard').style.display = 'none';
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
