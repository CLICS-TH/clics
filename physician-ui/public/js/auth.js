function getUser() {
  try {
    const raw = localStorage.getItem('clics_user');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// A guard failure must clear the token, not just bounce. /login forwards an unexpired clics_token
// to /dashboard when clics_user is a physician or is missing/corrupt; in the second case guardRole
// fails there, so a token left in place loops forever. (/login itself discards expired tokens, and
// staff tokens go to the dashboard handoff, which has its own 6 s guard.)
// Throws to halt the calling page's script (the page is navigating away).
function redirectToLogin(msg) {
  window.endSession(msg);
  throw new Error('clics: redirecting to login');
}

function guardPage() {
  if (!localStorage.getItem('clics_token')) redirectToLogin('กรุณาเข้าสู่ระบบ / Please sign in.');
}

// Returns the verified user so pages can `const user = auth.guardRole(...)`.
function guardRole(...roles) {
  const user = getUser();
  if (!localStorage.getItem('clics_token') || !user || !roles.includes(user.role)) {
    redirectToLogin('เซสชันไม่สมบูรณ์ — กรุณาเข้าสู่ระบบอีกครั้ง / Session was incomplete — please sign in again.');
  }
  return user;
}

window.auth = { getUser, guardPage, guardRole };
