// Google OAuth callback. Supabase redirected back here with the session in the URL hash. The
// page head lifts that hash into window.CLICS_OAUTH_HASH and strips it from history (#183), so
// we hand the tokens to supabase-js with setSession() and read the session back with getSession().
// Then one of three flows runs, distinguished by the marker this TAB's sign-in start left in
// sessionStorage('clics_oauth_flow') (google-signin.js). A page-made session carries `flow=<id>` in the hash
// and needs a marker with that id; the redirect carries none, so it falls back to the shared localStorage key
// when the tab's own copy is gone. No marker of its own → the page stops at an error, never at signup:
//   - invite  → POST /auth/invite/:token/accept { method:'google', access_token }
//   - signup  → POST /auth/oauth/google/complete { access_token } first; the council
//               picker shows ONLY if the backend answers 400 {code:'council_required'}
//               (i.e. a brand-new user) — existing users sign straight in.
//   - link    → POST /auth/link-google with the stored clics_token
// On success we store clics_token/clics_user and route by role.

const loadingCard = document.getElementById('loadingCard');
const councilCard = document.getElementById('councilCard');
const errorCard = document.getElementById('errorCard');
const doneCard = document.getElementById('doneCard');
const loadingMsg = document.getElementById('loadingMsg');

function show(card) {
  for (const c of [loadingCard, councilCard, errorCard, doneCard]) c.style.display = 'none';
  card.style.display = 'block';
}
function showError(msg) { document.getElementById('errorMsg').textContent = msg; show(errorCard); }

function errText(body) {
  if (!body) return 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่ / Sign-in failed. Please try again.';
  if (typeof body.error === 'string') return body.error;
  if (body.error?.fieldErrors) {
    const first = Object.values(body.error.fieldErrors).flat()[0];
    if (first) return first;
  }
  return 'เข้าสู่ระบบไม่สำเร็จ / Sign-in failed.';
}

function withClient(cb) {
  if (typeof window.CLICS_SUPABASE_CONFIGURED === 'boolean') { cb(); return; }
  let called = false;
  const run = () => { if (called) return; called = true; cb(); };
  window.addEventListener('clics:sbready', () => run(), { once: true });
  // Watchdog: if the pinned esm.sh module never loads (CDN unreachable/blocked), proceed
  // anyway — window.sbClient stays undefined and the page shows its "not configured" error
  // instead of spinning forever.
  setTimeout(run, 8000);
}

let accessToken = null;
let flow = { kind: 'signup' };
const FLOW_KEY = 'clics_oauth_flow';

// This tab's marker, consumed, or null when it has none. With a hash id the marker must carry that id and
// only sessionStorage is read: the shared key belongs to whichever tab pressed last. Without one (the
// Supabase redirect) the tab's own copy comes first and the shared key is the fallback; that key is removed
// only if it still holds the marker we used, never another tab's newer one.
function takeFlow(id) {
  let found = null;
  let raw = null;
  try { raw = sessionStorage.getItem(FLOW_KEY); } catch {}
  try { sessionStorage.removeItem(FLOW_KEY); } catch {}
  if (!raw && !id) { try { raw = localStorage.getItem(FLOW_KEY); } catch {} }
  if (raw) {
    try { found = JSON.parse(raw); } catch {}
    try { if (localStorage.getItem(FLOW_KEY) === raw) localStorage.removeItem(FLOW_KEY); } catch {}
  }
  if (!found || !['signup', 'invite', 'link'].includes(found.kind)) return null;
  if (id && found.id !== id) return null;
  return found;
}

withClient(async () => {
  if (!window.sbClient) {
    showError('Google ยังไม่ถูกตั้งค่าในระบบนี้ / Google sign-in is not configured for this deployment.');
    return;
  }
  // Lift the hash and read this tab's flow marker FIRST. The LINK flow must KEEP the existing clics_token
  // (the link endpoint authenticates with it); only a fresh sign-in/invite supersedes the stored session.
  const lifted = new URLSearchParams(window.CLICS_OAUTH_HASH || '');
  window.CLICS_OAUTH_HASH = null;
  const mine = takeFlow(lifted.get('flow'));
  if (!mine) {
    // Not this tab's sign-in (a reload, another tab's press, or cleared storage). Leave clics_token/clics_user:
    // they may belong to the tab that did start a flow. Drop the Supabase copy (sb-*, no signOut: see
    // routeActive): it is a live, self-refreshing session, and no Callback page re-reads it.
    try { for (const k of Object.keys(localStorage)) if (k.indexOf('sb-') === 0) localStorage.removeItem(k); } catch {}
    showError('ไม่พบการเริ่มเข้าสู่ระบบด้วย Google ของแท็บนี้ กรุณาเริ่มใหม่จากหน้าเข้าสู่ระบบหรือลิงก์คำเชิญ / No Google sign-in was started in this tab. Please start again from the login page or your invite link.');
    return;
  }
  flow = mine;
  if (flow.kind !== 'link') {
    // A fresh sign-in supersedes any stored CLICS session — and a stale token here is actively
    // harmful (the login page auto-forwards on it, ping-ponging against the role guard).
    try { localStorage.removeItem('clics_token'); localStorage.removeItem('clics_user'); } catch {}
  }

  // Trust only the session these tokens yield. getSession() would fall back to a stale sb-*
  // session left by an earlier, abandoned callback — possibly another person's — so a cancelled
  // or rejected sign-in clears it (no signOut: see routeActive) and stops at the error card.
  let session = null;
  if (lifted.get('access_token') && lifted.get('refresh_token')) {
    const { data, error } = await window.sbClient.auth.setSession({
      access_token: lifted.get('access_token'),
      refresh_token: lifted.get('refresh_token'),
    });
    if (!error) session = data?.session;
  }
  if (!session?.access_token) {
    try { for (const k of Object.keys(localStorage)) if (k.indexOf('sb-') === 0) localStorage.removeItem(k); } catch {}
    showError('ไม่พบเซสชันจาก Google ลิงก์อาจหมดอายุ กรุณาลองใหม่ / No Google session found. The link may have expired — please try again.');
    return;
  }
  accessToken = session.access_token;

  if (flow.kind === 'invite') { await completeInvite(); }
  else if (flow.kind === 'link') { await completeLink(); }
  else { await completeSignup(); }
});

// ---- Link-Google flow (a signed-in password/invited user adds Google) ----
async function completeLink() {
  const res = await api.linkGoogle(accessToken);
  // Drop the Supabase local copy (sb-*) WITHOUT signOut — same rule as routeActive (gotrue /logout
  // would revoke the session and 401 every later call).
  try { for (const k of Object.keys(localStorage)) if (k.indexOf('sb-') === 0) localStorage.removeItem(k); } catch {}
  if (res && res.ok) {
    try { sessionStorage.setItem('clics_link_msg', 'เชื่อมบัญชี Google สำเร็จ / Google account linked.'); } catch {}
    window.location.replace('/dashboard');
  } else {
    showError(errText(res));
  }
}

// ---- Invite-Google flow ----
async function completeInvite() {
  if (!flow.token) { showError('ไม่พบรหัสคำเชิญ / Invite token missing.'); return; }
  const res = await api.acceptInvite(flow.token, {
    method: 'google',
    access_token: accessToken,
  });
  // An accepted invite is always active immediately (physician or auditor) — 201.
  if ((res.status === 201 || res.ok) && res.body?.access_token) {
    routeActive(res.body);
  } else {
    // A rejected invite (for example another Google account than the invited email) must not leave
    // this Supabase session behind. No signOut: see routeActive.
    try { for (const k of Object.keys(localStorage)) if (k.indexOf('sb-') === 0) localStorage.removeItem(k); } catch {}
    showError(errText(res.body));
  }
}

// ---- Normal Google signup flow ----
async function completeSignup() {
  // If a council was already chosen (re-entry after the picker), use it directly.
  if (flow.council_id) {
    const res = await api.oauthGoogleComplete(accessToken, flow.council_id);
    handleSignupResult(res);
    return;
  }
  // Otherwise try WITHOUT a council first: existing professionals get their account
  // straight back (no picker, ever). Only a brand-new user gets 400 'council_required'.
  const res = await api.oauthGoogleComplete(accessToken, undefined);
  const code = res.body?.error?.code || res.body?.code;
  if (res.status === 400 && code === 'council_required') {
    await populateCouncils();
    show(councilCard);
    return;
  }
  handleSignupResult(res); // ok/201 → routeActive; anything else → error card
}

async function populateCouncils() {
  const sel = document.getElementById('council');
  if (sel.options.length > 1) return; // already populated
  const res = await api.councils();
  if (res.ok && Array.isArray(res.body)) {
    for (const c of res.body) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name_th} / ${c.name_en}`;
      sel.appendChild(opt);
    }
  }
}

// Full specialty list for the chosen council, kept so the search box can re-filter without refetching.
let allSpecialties = [];

// Render the specialty <select> from allSpecialties, filtered by a search query (matches name_th/en).
function renderSpecialtyOptions(query) {
  const sel = document.getElementById('specialty');
  const q = (query || '').trim().toLowerCase();
  const prev = sel.value;
  sel.innerHTML = '<option value="">— เลือกความเชี่ยวชาญ / Select a specialty —</option>';
  for (const s of allSpecialties) {
    if (q && !(`${s.name_th} ${s.name_en}`.toLowerCase().includes(q))) continue;
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name_th} / ${s.name_en}`;
    sel.appendChild(opt);
  }
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev; // keep selection if still visible
}

// Council → (training level + specialty) cascade: a medical council (one WITH specialties) reveals BOTH
// the training-level select and the searchable specialty picker; a non-medical council hides them.
async function populateSpecialties(councilId) {
  const group = document.getElementById('specialtyGroup');
  const tlGroup = document.getElementById('trainingLevelGroup');
  allSpecialties = [];
  renderSpecialtyOptions('');
  if (!councilId) { group.style.display = 'none'; if (tlGroup) tlGroup.style.display = 'none'; return; }
  const res = await api.specialties(councilId);
  allSpecialties = (res.ok && Array.isArray(res.body)) ? res.body : [];
  renderSpecialtyOptions('');
  const disp = allSpecialties.length ? 'block' : 'none';
  group.style.display = disp;
  if (tlGroup) tlGroup.style.display = disp;
}

const councilSelEl = document.getElementById('council');
if (councilSelEl) councilSelEl.addEventListener('change', e => {
  // A new council resets the dependent picks: the training level (so a level chosen for the previous
  // council can't silently carry over) and the specialty search box. The specialty <select> itself is
  // rebuilt by populateSpecialties. (Only on council CHANGE — NOT on a position/specialty_required
  // re-reveal, which calls populateSpecialties directly so a valid level survives the re-prompt.)
  const tl = document.getElementById('trainingLevel');
  if (tl) tl.value = '';
  const ss = document.getElementById('specialtySearch');
  if (ss) ss.value = '';
  populateSpecialties(e.target.value);
});
const specialtySearchEl = document.getElementById('specialtySearch');
if (specialtySearchEl) specialtySearchEl.addEventListener('input', e => renderSpecialtyOptions(e.target.value));

const councilBtn = document.getElementById('councilBtn');
if (councilBtn) {
  councilBtn.addEventListener('click', async () => {
    const councilErr = document.getElementById('councilErr');
    councilErr.style.display = 'none';
    const councilId = document.getElementById('council').value;
    if (!councilId) { councilErr.textContent = 'กรุณาเลือกสภาวิชาชีพ / Please select a council.'; councilErr.style.display = 'block'; return; }
    // A medical council requires training level THEN specialty (the backend enforces both too).
    const medical = document.getElementById('specialtyGroup').style.display !== 'none';
    const position = document.getElementById('trainingLevel').value || undefined;
    if (medical && !position) {
      councilErr.textContent = 'กรุณาเลือกระดับการฝึกอบรม / Please select your medical training level.'; councilErr.style.display = 'block'; return;
    }
    const specialtyId = document.getElementById('specialty').value || undefined;
    if (medical && !specialtyId) {
      councilErr.textContent = 'กรุณาเลือกความเชี่ยวชาญ / Please select a specialty.'; councilErr.style.display = 'block'; return;
    }
    councilBtn.disabled = true; councilBtn.textContent = 'กำลังสร้างบัญชี... / Creating account...';
    show(loadingCard);
    const res = await api.oauthGoogleComplete(accessToken, councilId, specialtyId, position);
    councilBtn.disabled = false; councilBtn.textContent = 'ดำเนินการต่อ / Continue';
    handleSignupResult(res, /* fromPicker */ true);
  });
}

function handleSignupResult(res, fromPicker) {
  if ((res.status === 201 || res.ok) && res.body?.access_token) {
    routeActive(res.body);
    return;
  }
  if (res.status === 404) {
    showError('Google ยังไม่เปิดใช้งานในระบบนี้ / Google sign-in is not available on this deployment.');
    return;
  }
  if (fromPicker) {
    const councilErr = document.getElementById('councilErr');
    // If the backend asks for a training level or specialty (council has some, none chosen), re-reveal
    // the medical-council steps (training level + specialty).
    const code = res.body?.error?.code || res.body?.code;
    if (res.status === 400 && (code === 'specialty_required' || code === 'position_required')) {
      populateSpecialties(document.getElementById('council').value);
    }
    councilErr.textContent = errText(res.body); councilErr.style.display = 'block';
    show(councilCard);
    return;
  }
  showError(errText(res.body));
}

// ---- Store session + route by role ----
function routeActive(body) {
  localStorage.setItem('clics_token', body.access_token);
  if (body.user) localStorage.setItem('clics_user', JSON.stringify(body.user));
  const role = body.user?.role || 'physician';
  // Drop the local Supabase storage copy WITHOUT calling signOut(): the token we just stored as
  // clics_token IS this Supabase session's access token (verifyJwt validates via auth.getUser),
  // and gotrue's /logout terminates the current session server-side under EVERY scope (including
  // 'local' — that only spares other sessions), 401-ing all API calls right after login.
  try { for (const k of Object.keys(localStorage)) if (k.indexOf('sb-') === 0) localStorage.removeItem(k); } catch {}
  if (role === 'physician') {
    window.location.replace('/dashboard');
  } else {
    window.location.replace((window.CLICS_DASHBOARD_URL || '/audit') + '/login');
  }
}
