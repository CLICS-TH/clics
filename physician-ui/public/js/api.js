const BASE = window.CLICS_API_URL || 'http://localhost:3001';
// A hard client timeout so a hung request (RIMPL/Claude stall, dropped connection) surfaces as a
// recoverable error instead of freezing the chat forever. Slightly above the backend chat ceiling
// (~100s) so the server's own timeout normally fires first.
const REQUEST_TIMEOUT_MS = 130000;

function getToken() { return localStorage.getItem('clics_token'); }

// A chat page keeps the key of an unsettled turn in sessionStorage ('clics_turn_<pleId>', js/ple-chat.js)
// so a reload can resume it. Signing out (or a dead session) must not hand it to the next sign-in in this tab.
function clearChatTurnState() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('clics_turn_')) sessionStorage.removeItem(k);
    }
  } catch {}
}
window.clearChatTurnState = clearChatTurnState;

// Display prefs survive the wipe (mirror the portal's ?logout=1 handler): an expired token
// shouldn't reset a dark-mode user to light.
function expireSession(msg = 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบอีกครั้ง / Session expired — please sign in again.') {
  clearChatTurnState();
  try { sessionStorage.setItem('clics_auth_msg', msg); } catch {}
  try {
    const t = localStorage.getItem('clics_theme'), v = localStorage.getItem('clics_view');
    localStorage.clear();
    if (t) localStorage.setItem('clics_theme', t);
    if (v) localStorage.setItem('clics_view', v);
  } catch {}
  window.location.replace('/login');
}
window.expireSession = expireSession;

function timeoutSignal() {
  try { return AbortSignal.timeout(REQUEST_TIMEOUT_MS); } catch { return undefined; } // older browsers: no timeout
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const { onEvent, ...init } = options;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
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
    // `code` lets a caller tell "the request never got an answer" (the server may still have acted on it,
    // and a chat turn is the case that matters) from a definite server refusal. Additive: callers that
    // only read `.error` are unaffected.
    return { error: 'เครือข่ายขัดข้อง กรุณาลองใหม่ / Network error — please try again.', code: 'network_error' };
  }
  // Session-expiry handling — ONLY when a token was attached. An unauthenticated 401
  // (e.g. a wrong password on /auth/login) must fall through so the page shows the
  // error inline instead of bouncing through the "session expired" redirect.
  if (res.status === 401 && token) { expireSession(); return; }
  if (res.status === 204) return null;
  // A streamed reply (server-sent events): pieces go to onEvent, and the result is the final `done`
  // event's body — the same object a plain JSON answer would have been.
  if (onEvent && /text\/event-stream/i.test(res.headers.get('content-type') || '')) return readEventStream(res, onEvent);
  // Guard the body parse: Railway edge 502/503 (and proxy error pages) return non-JSON HTML, which
  // would throw here and leave the caller's awaited button dead/disabled. Return the { error } shape
  // callers already branch on.
  try {
    return await res.json();
  } catch {
    return { error: 'เซิร์ฟเวอร์ขัดข้องชั่วคราว กรุณาลองใหม่ / Server error — please try again.', code: 'bad_response' };
  }
}

// Read a server-sent event stream: every named event but `done` (`delta` / `replace` / `status`) goes to
// onEvent in order, and the final `done` event ({ status, body }) resolves with its body. A stream that
// breaks off before `done` is the same "no answer came back" as a dropped request (code network_error):
// the turn may or may not have been stored, and the caller settles it the same way.
async function readEventStream(res, onEvent) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return { error: 'เซิร์ฟเวอร์ขัดข้องชั่วคราว กรุณาลองใหม่ / Server error — please try again.', code: 'bad_response' };
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = (/^event: ?(.*)$/m.exec(block) || [])[1];
        const raw = (/^data: ?(.*)$/m.exec(block) || [])[1];
        if (!name || raw == null) continue;
        let data;
        try { data = JSON.parse(raw); } catch { continue; }
        if (name === 'done') {
          try { reader.cancel(); } catch {}
          return (data && data.body) || { error: 'เซิร์ฟเวอร์ขัดข้องชั่วคราว กรุณาลองใหม่ / Server error — please try again.', code: 'bad_response' };
        }
        try { onEvent(name, data); } catch {}   // a rendering slip must never lose the turn's outcome
      }
    }
  } catch { /* the connection dropped mid-reply */ }
  return { error: 'เครือข่ายขัดข้อง กรุณาลองใหม่ / Network error — please try again.', code: 'network_error' };
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
  logout: () => { clearChatTurnState(); return apiFetch('/auth/logout', { method: 'POST' }); },
  me: () => apiFetch('/auth/me'),
  // Link a Google account to the signed-in (password/invited) user — posts the Google session token
  // with the user's existing CLICS bearer token. Returns { ok, linked_providers } or { error }.
  linkGoogle: (access_token) => apiFetch('/auth/link-google', { method: 'POST', body: { access_token } }),
  consent: (body) => apiFetch('/auth/consent', { method: 'POST', body }),
  // CREC082 ICF §4 identity verification. The national ID is sent once and never returned by any
  // endpoint — identityStatus() reports where a submission stands, not what was submitted.
  submitIdentity: (body) => apiFetch('/auth/identity/national-id', { method: 'POST', body }),
  identityStatus: () => apiFetch('/auth/identity/status'),
  pilotMode: () => apiFetch('/auth/pilot-mode'),
  // Compensation payment details (self-service): the physician's own bank/PromptPay info, stored
  // encrypted on-prem. getPaymentInfo → { payment_info, updated_at } | { payment_info: null }.
  getPaymentInfo: () => apiFetch('/auth/payment-info'),
  savePaymentInfo: (body) => apiFetch('/auth/payment-info', { method: 'POST', body }),
  createPle: (body) => apiFetch('/ples', { method: 'POST', body }),
  getPlEs: () => apiFetch('/ples'),
  getPle: (id) => apiFetch(`/ples/${id}`),
  updatePle: (id, body) => apiFetch(`/ples/${id}`, { method: 'PATCH', body }),
  deletePle: (id) => apiFetch(`/ples/${id}`, { method: 'DELETE' }),
  // With onEvent the turn asks to be streamed; the backend streams only while the superadmin
  // `chat_streaming` setting is on (and never a rescue turn), and otherwise answers in plain JSON.
  sendMessage: (id, body, onEvent) => apiFetch(`/ples/${id}/message`, { method: 'POST', body: onEvent ? { ...body, stream: true } : body, onEvent }),
  // Report an AI reply as wrong or unsafe (the CREC082 safety event log). body = { reason, note? }.
  // Resolves { ok: true } — deliberately nothing else; a repeat report answers the same.
  reportReply: (id, messageId, body) => apiFetch(`/ples/${id}/messages/${messageId}/report`, { method: 'POST', body }),
  endPle: (id, body) => apiFetch(`/ples/${id}/end`, { method: 'POST', body }),
  // CREC082 ICF §3 step 3. Submitting (or skipping) the reflection is what releases a session from
  // 'ended' into screening — the reflection is part of what gets screened.
  getReflection: (id) => apiFetch(`/ples/${id}/reflection`),
  submitReflection: (id, body) => apiFetch(`/ples/${id}/reflection`, { method: 'POST', body }),
  // ICF §3 step 4 — one per physician at the end of participation. The item wording comes from the
  // server so the portal never holds a second copy that could drift from the approved instrument.
  getAcceptability: () => apiFetch('/ples/acceptability'),
  submitAcceptability: (body) => apiFetch('/ples/acceptability', { method: 'POST', body }),
  getEvaluation: (id) => apiFetch(`/ples/${id}/evaluation`),
  // Longitudinal profile snapshots (ascending; last = most recent composite_score). Used by the
  // LPDP page and the dashboard hero's "latest score" stat.
  // ?held=1 asks for the { snapshots, held } shape. Without it the endpoint returns the bare
  // array it always has, so a cached copy of this file cannot be broken by a backend deploy.
  getLpdp: () => apiFetch('/ples/lpdp/me?held=1'),
  // Conversation folders
  getFolders: () => apiFetch('/ples/folders'),
  createFolder: (name) => apiFetch('/ples/folders', { method: 'POST', body: { name } }),
  renameFolder: (id, name) => apiFetch(`/ples/folders/${id}`, { method: 'PATCH', body: { name } }),
  deleteFolder: (id) => apiFetch(`/ples/folders/${id}`, { method: 'DELETE' }),

  // Active professional councils for the sign-up picker (public).
  councils: () => publicFetch('/auth/councils'),
  // Specialties (the layer under council) for the sign-up picker (public); ?council_id= scopes it.
  specialties: (council_id) => publicFetch('/auth/specialties' + (council_id ? `?council_id=${encodeURIComponent(council_id)}` : '')),

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
  oauthGoogleComplete: (access_token, council_id, specialty_id, position) => publicFetch('/auth/oauth/google/complete', {
    method: 'POST',
    body: council_id === undefined
      ? { access_token }
      : { access_token, council_id, ...(specialty_id ? { specialty_id } : {}), ...(position ? { position } : {}) },
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
