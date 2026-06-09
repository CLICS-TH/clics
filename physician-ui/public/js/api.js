const BASE = window.CLICS_API_URL || 'http://localhost:3001';

function getToken() { return localStorage.getItem('clics_token'); }

async function apiFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { localStorage.clear(); window.location.href = '/'; return; }
  if (res.status === 204) return null;
  return res.json();
}

// Public / unauthenticated calls (sign-up requests, OAuth, guest). These must NOT
// trigger the 401-redirect side effect, and they surface status so callers can show
// "pending" / "already requested" messages.
async function publicFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, body };
}

window.api = {
  login: (email, password) => apiFetch('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => apiFetch('/auth/logout', { method: 'POST' }),
  me: () => apiFetch('/auth/me'),
  consent: () => apiFetch('/auth/consent', { method: 'POST' }),
  createPle: (body) => apiFetch('/ples', { method: 'POST', body }),
  getPlEs: () => apiFetch('/ples'),
  getPle: (id) => apiFetch(`/ples/${id}`),
  updatePle: (id, body) => apiFetch(`/ples/${id}`, { method: 'PATCH', body }),
  deletePle: (id) => apiFetch(`/ples/${id}`, { method: 'DELETE' }),
  sendMessage: (id, body) => apiFetch(`/ples/${id}/message`, { method: 'POST', body }),
  endPle: (id, body) => apiFetch(`/ples/${id}/end`, { method: 'POST', body }),
  getEvaluation: (id) => apiFetch(`/ples/${id}/evaluation`),
  // Conversation folders
  getFolders: () => apiFetch('/ples/folders'),
  createFolder: (name) => apiFetch('/ples/folders', { method: 'POST', body: { name } }),
  renameFolder: (id, name) => apiFetch(`/ples/folders/${id}`, { method: 'PATCH', body: { name } }),
  deleteFolder: (id) => apiFetch(`/ples/folders/${id}`, { method: 'DELETE' }),

  // Active professional councils for the sign-up picker (public).
  councils: () => publicFetch('/auth/councils'),

  // Self-service access request (email+password) — returns { ok, status, body }.
  // Social sign-in (Google/LINE) is disabled for the pilot; the stub endpoints 404.
  requestAccess: (body) => publicFetch('/auth/request-access', { method: 'POST', body }),

  // ---- Public signup / auth flows (all return { ok, status, body }) ----
  // Email signup → emails a 6-digit OTP (202 { status:'otp_sent', email }).
  signupEmail: (body) => publicFetch('/auth/signup/email', { method: 'POST', body }),
  // Verify the signup OTP → 201 { access_token, user, license_status }.
  verifySignupOtp: (email, token) => publicFetch('/auth/signup/verify-otp', { method: 'POST', body: { email, token } }),
  // Resend the signup OTP (202 { status:'otp_sent' }; never reveals if the email exists).
  resendSignupOtp: (email) => publicFetch('/auth/signup/resend-otp', { method: 'POST', body: { email } }),
  // Forgot password — ALWAYS 200 { ok:true } (never leaks whether the account exists).
  forgotPassword: (email) => publicFetch('/auth/forgot-password', { method: 'POST', body: { email } }),
  // Invite lookup → { email, role, council } (404 missing, 410 expired).
  getInvite: (token) => publicFetch(`/auth/invite/${encodeURIComponent(token)}`),
  // Accept an invite (password two-step OTP, or google). See backend contract.
  acceptInvite: (token, body) => publicFetch(`/auth/invite/${encodeURIComponent(token)}/accept`, { method: 'POST', body }),
  // Finish Google sign-in: post the Supabase session token + a chosen council (404 if OAUTH disabled).
  oauthGoogleComplete: (access_token, council_id) => publicFetch('/auth/oauth/google/complete', { method: 'POST', body: { access_token, council_id } }),

  // Guest mode (ephemeral; token is NOT stored in localStorage).
  guestStart: () => publicFetch('/guest/start', { method: 'POST' }),
  guestMessage: (token, body) => publicFetch('/guest/message', { method: 'POST', token, body }),
};
