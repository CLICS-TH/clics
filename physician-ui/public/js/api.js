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

  // Self-service access requests + OAuth (stubbed handshake) — return { ok, status, body }.
  requestAccess: (body) => publicFetch('/auth/request-access', { method: 'POST', body }),
  oauthStart: (provider) => publicFetch(`/auth/oauth/${provider}/start`, { method: 'POST' }),
  oauthMock: (provider, body) => publicFetch(`/auth/oauth/${provider}/mock-callback`, { method: 'POST', body }),

  // Guest mode (ephemeral; token is NOT stored in localStorage).
  guestStart: () => publicFetch('/guest/start', { method: 'POST' }),
  guestMessage: (token, body) => publicFetch('/guest/message', { method: 'POST', token, body }),
};
