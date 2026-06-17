const BASE = window.CLICS_API_URL || 'http://localhost:3001';
// A hard client timeout so a hung request (RIMPL/Claude stall, dropped connection) surfaces as a
// recoverable error instead of freezing the chat forever. Slightly above the backend chat ceiling
// (~100s) so the server's own timeout normally fires first.
const REQUEST_TIMEOUT_MS = 130000;

function getToken() { return localStorage.getItem('clics_token'); }

function timeoutSignal() {
  try { return AbortSignal.timeout(REQUEST_TIMEOUT_MS); } catch { return undefined; } // older browsers: no timeout
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal ?? timeoutSignal(),
    });
  } catch {
    // Network rejection OR timeout abort — return the same { error } shape callers already branch on,
    // so awaited buttons re-enable instead of staying disabled forever.
    return { error: 'เครือข่ายขัดข้อง กรุณาลองใหม่ / Network error — please try again.' };
  }
  // Session-expiry handling — ONLY when a token was attached. An unauthenticated 401
  // (e.g. a wrong password on /auth/login) must fall through so the page shows the
  // error inline instead of bouncing through the "session expired" redirect.
  if (res.status === 401 && token) {
    try { sessionStorage.setItem('clics_auth_msg', 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบอีกครั้ง / Session expired — please sign in again.'); } catch {}
    // Preserve display prefs across the session-expiry wipe (mirror the portal's ?logout=1 handler) —
    // a dark-mode user shouldn't get reset to light just because their token expired.
    const t = localStorage.getItem('clics_theme'), v = localStorage.getItem('clics_view');
    localStorage.clear();
    if (t) localStorage.setItem('clics_theme', t);
    if (v) localStorage.setItem('clics_view', v);
    window.location.href = '/'; return;
  }
  if (res.status === 204) return null;
  // Guard the body parse: Railway edge 502/503 (and proxy error pages) return non-JSON HTML, which
  // would throw here and leave the caller's awaited button dead/disabled. Return the { error } shape
  // callers already branch on.
  try {
    return await res.json();
  } catch {
    return { error: 'เซิร์ฟเวอร์ขัดข้องชั่วคราว กรุณาลองใหม่ / Server error — please try again.' };
  }
}

// Public / unauthenticated calls (sign-up requests, OAuth, guest). These must NOT
// trigger the 401-redirect side effect, and they surface status so callers can show
// "pending" / "already requested" messages.
async function publicFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: timeoutSignal(),
    });
  } catch {
    // Network rejection — synthetic envelope (status 0) so callers' { ok, status, body }
    // branches fall through to their error display and re-enable their buttons.
    return { ok: false, status: 0, body: { error: 'เครือข่ายขัดข้อง กรุณาลองใหม่ / Network error — please try again.' } };
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, body };
}

window.api = {
  login: (email, password) => apiFetch('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => apiFetch('/auth/logout', { method: 'POST' }),
  me: () => apiFetch('/auth/me'),
  consent: () => apiFetch('/auth/consent', { method: 'POST' }),
  createPle: (body) => apiFetch('/cles', { method: 'POST', body }),
  getPlEs: () => apiFetch('/cles'),
  getPle: (id) => apiFetch(`/cles/${id}`),
  updatePle: (id, body) => apiFetch(`/cles/${id}`, { method: 'PATCH', body }),
  deletePle: (id) => apiFetch(`/cles/${id}`, { method: 'DELETE' }),
  sendMessage: (id, body) => apiFetch(`/cles/${id}/message`, { method: 'POST', body }),
  endPle: (id, body) => apiFetch(`/cles/${id}/end`, { method: 'POST', body }),
  getEvaluation: (id) => apiFetch(`/cles/${id}/evaluation`),
  // Conversation folders
  getFolders: () => apiFetch('/cles/folders'),
  createFolder: (name) => apiFetch('/cles/folders', { method: 'POST', body: { name } }),
  renameFolder: (id, name) => apiFetch(`/cles/folders/${id}`, { method: 'PATCH', body: { name } }),
  deleteFolder: (id) => apiFetch(`/cles/folders/${id}`, { method: 'DELETE' }),

  // Active professional councils for the sign-up picker (public).
  councils: () => publicFetch('/auth/councils'),

  // ---- Public auth flows (all return { ok, status, body }) ----
  // Public email-OTP self-signup was retired — physicians self-serve via Google
  // (oauthGoogleComplete below); A/B send invites for physicians + auditors.
  // Forgot password — ALWAYS 200 { ok:true } (never leaks whether the account exists).
  forgotPassword: (email) => publicFetch('/auth/forgot-password', { method: 'POST', body: { email } }),
  // Invite lookup → { email, role, council } (404 missing, 410 expired).
  getInvite: (token) => publicFetch(`/auth/invite/${encodeURIComponent(token)}`),
  // Accept an invite (password two-step OTP, or google). See backend contract.
  acceptInvite: (token, body) => publicFetch(`/auth/invite/${encodeURIComponent(token)}/accept`, { method: 'POST', body }),
  // Finish Google sign-in: post the Supabase session token (+ a chosen council for NEW users).
  // council_id is OMITTED when undefined — the backend zod schema rejects an explicit null,
  // and existing users must be able to complete without any council (404 if OAUTH disabled).
  oauthGoogleComplete: (access_token, council_id) => publicFetch('/auth/oauth/google/complete', {
    method: 'POST',
    body: council_id === undefined ? { access_token } : { access_token, council_id },
  }),

  // ---- Dual-role: physician requests auditor rights (both return { ok, status, body }) ----
  // POST → 202 {status:'pending'} | 409 {code:'already_auditor'} | 409 {code:'pending'}.
  requestAuditor: () => publicFetch('/auth/request-auditor', { method: 'POST', token: getToken() }),
  // GET → { request: {status, reviewed_at} | null, can_audit: boolean } — drives the button state.
  getAuditorRequest: () => publicFetch('/auth/request-auditor', { token: getToken() }),

  // Guest mode (ephemeral; token is NOT stored in localStorage).
  guestStart: () => publicFetch('/guest/start', { method: 'POST' }),
  guestMessage: (token, body) => publicFetch('/guest/message', { method: 'POST', token, body }),
};
