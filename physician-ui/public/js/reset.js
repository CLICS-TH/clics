// Password reset. The recovery link from Supabase lands here with a recovery token in the URL
// hash; supabase-client.js was built with detectSessionInUrl:true, so the client picks it up
// and emits a PASSWORD_RECOVERY auth event. We then collect a new password and call
// sbClient.auth.updateUser({ password }). No backend call — Supabase owns the password here.

const loadingCard = document.getElementById('loadingCard');
const formCard = document.getElementById('formCard');
const invalidCard = document.getElementById('invalidCard');
const successCard = document.getElementById('successCard');
const loadingMsg = document.getElementById('loadingMsg');

function show(card) {
  for (const c of [loadingCard, formCard, invalidCard, successCard]) c.style.display = 'none';
  card.style.display = 'block';
}

function showInvalid(msg) {
  document.getElementById('invalidMsg').textContent = msg;
  show(invalidCard);
}

// sbClient is created by the module script; it may or may not have run yet when this
// synchronous script executes. withClient resolves once we know the answer either way.
function withClient(cb) {
  if (typeof window.CLICS_SUPABASE_CONFIGURED === 'boolean') { cb(); return; }
  window.addEventListener('clics:sbready', () => cb(), { once: true });
}

withClient(async () => {
  if (!window.sbClient) {
    showInvalid('ลิงก์ตั้งรหัสผ่านยังไม่ถูกตั้งค่าในระบบนี้ / Password reset is not configured for this deployment.');
    return;
  }

  // Either a recovery session already exists (detectSessionInUrl parsed the hash), or it's
  // about to via the PASSWORD_RECOVERY event. Give the client a beat, then check.
  let resolved = false;
  const ready = () => {
    if (resolved) return;
    resolved = true;
    show(formCard);
    document.getElementById('password').focus();
  };

  window.sbClient.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') ready();
  });

  const { data } = await window.sbClient.auth.getSession();
  if (data?.session) { ready(); return; }

  // Hash not parsed into a session and no recovery event — bad/expired link.
  setTimeout(() => {
    if (!resolved) {
      showInvalid('ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ใหม่ / This reset link is invalid or expired. Please request a new one.');
    }
  }, 1500);
});

// ---- Save the new password ----
const saveBtn = document.getElementById('saveBtn');
const formErr = document.getElementById('formErr');

saveBtn.addEventListener('click', async () => {
  formErr.style.display = 'none';
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    formErr.textContent = 'รหัสผ่านต้องยาว ≥ 10 ตัว และมีทั้งตัวอักษรและตัวเลข / Password must be 10+ chars with a letter and a digit.';
    formErr.style.display = 'block';
    return;
  }
  if (password !== confirm) {
    formErr.textContent = 'รหัสผ่านไม่ตรงกัน / Passwords do not match.';
    formErr.style.display = 'block';
    return;
  }
  saveBtn.disabled = true; saveBtn.textContent = 'กำลังบันทึก... / Saving...';
  const { error } = await window.sbClient.auth.updateUser({ password });
  saveBtn.disabled = false; saveBtn.textContent = 'บันทึกรหัสผ่านใหม่ / Save new password';
  if (error) {
    formErr.textContent = error.message || 'ไม่สามารถบันทึกได้ กรุณาลองใหม่ / Could not save. Please try again.';
    formErr.style.display = 'block';
    return;
  }
  // Don't leave a half-authenticated recovery session lying around.
  await window.sbClient.auth.signOut().catch(() => {});
  show(successCard);
});

document.getElementById('confirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
