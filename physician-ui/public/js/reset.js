// Password reset. The recovery link from Supabase lands here with the recovery tokens in the URL
// hash. The page head lifts that hash into window.CLICS_RECOVERY_HASH and strips it from history
// (the #185 pattern), so Back never replays the token; we hand the tokens to supabase-js with
// setSession(), collect a new password and call sbClient.auth.updateUser({ password }).
// No backend call — Supabase owns the password here.

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
  let called = false;
  const run = () => { if (called) return; called = true; cb(); };
  window.addEventListener('clics:sbready', () => run(), { once: true });
  // Watchdog: if the pinned esm.sh module never loads (CDN unreachable/blocked), proceed
  // anyway — window.sbClient stays undefined and the page shows its "not configured" error
  // instead of waiting forever on loadingCard.
  setTimeout(run, 8000);
}

withClient(async () => {
  if (!window.sbClient) {
    showInvalid('ลิงก์ตั้งรหัสผ่านยังไม่ถูกตั้งค่าในระบบนี้ / Password reset is not configured for this deployment.');
    return;
  }

  const lifted = new URLSearchParams(window.CLICS_RECOVERY_HASH || '');
  window.CLICS_RECOVERY_HASH = null;
  // Trust only the session these tokens yield. getSession() would fall back to a stale sb-*
  // session left on this browser — possibly another person's — and let it set a new password.
  let session = null;
  if (lifted.get('access_token') && lifted.get('refresh_token')) {
    const { data, error } = await window.sbClient.auth.setSession({
      access_token: lifted.get('access_token'),
      refresh_token: lifted.get('refresh_token'),
    });
    if (!error) session = data?.session;
  }
  if (!session) {
    try { for (const k of Object.keys(localStorage)) if (k.indexOf('sb-') === 0) localStorage.removeItem(k); } catch {}
    showInvalid('ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ใหม่ / This reset link is invalid or expired. Please request a new one.');
    return;
  }
  show(formCard);
  document.getElementById('password').focus();
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
