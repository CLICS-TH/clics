function getUser() {
  try {
    const raw = localStorage.getItem('clics_user');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// On guard failure we must HEAL the stored state, not just bounce: a stale clics_token with a
// missing/corrupt clics_user otherwise ping-pongs forever between '/' (whose token auto-forward
// sends it back here) and the guarded page — nothing in that cycle ever clears the bad token.
// Throws to halt the calling page's script (the page is navigating away).
function redirectToLogin(msg) {
  try { sessionStorage.setItem('clics_auth_msg', msg); } catch {}
  try { localStorage.removeItem('clics_token'); localStorage.removeItem('clics_user'); } catch {}
  window.location.replace('/');
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
