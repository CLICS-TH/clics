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

window.api = {
  login: (email, password) => apiFetch('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => apiFetch('/auth/logout', { method: 'POST' }),
  me: () => apiFetch('/auth/me'),
  createPle: (body) => apiFetch('/ples', { method: 'POST', body }),
  getPlEs: () => apiFetch('/ples'),
  getPle: (id) => apiFetch(`/ples/${id}`),
  updatePle: (id, body) => apiFetch(`/ples/${id}`, { method: 'PATCH', body }),
  sendMessage: (id, body) => apiFetch(`/ples/${id}/message`, { method: 'POST', body }),
  endPle: (id) => apiFetch(`/ples/${id}/end`, { method: 'POST' }),
  getEvaluation: (id) => apiFetch(`/ples/${id}/evaluation`),
  // Conversation folders
  getFolders: () => apiFetch('/ples/folders'),
  createFolder: (name) => apiFetch('/ples/folders', { method: 'POST', body: { name } }),
  renameFolder: (id, name) => apiFetch(`/ples/folders/${id}`, { method: 'PATCH', body: { name } }),
  deleteFolder: (id) => apiFetch(`/ples/folders/${id}`, { method: 'DELETE' }),
};
