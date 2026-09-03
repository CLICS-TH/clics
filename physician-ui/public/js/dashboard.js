const user = auth.guardRole('physician'); // throws (and heals storage) when the session is unusable
document.getElementById('greeting').textContent = `สวัสดี, ${user.full_name_th || user.full_name_en}`;

// ---- Identity line (specialty · position, under the name) + Google-account linking ----
(function identityAndLinking() {
  const POSITION_TH = { extern: 'เอกซ์เทิร์น', intern: 'อินเทิร์น', resident: 'แพทย์ประจำบ้าน',
    fellowship: 'แพทย์ประจำบ้านต่อยอด', staff: 'อาจารย์แพทย์', gp: 'แพทย์ทั่วไป' };
  function renderIdentity(u) {
    const el = document.getElementById('identityLine');
    if (!el) return;
    const parts = [u.specialty_name_th, u.position ? POSITION_TH[u.position] : null].filter(Boolean);
    if (parts.length) { el.textContent = parts.join(' · '); el.style.display = ''; } else { el.style.display = 'none'; }
  }
  renderIdentity(user); // from the cached login user (carries specialty_name_th + position)

  // Success message set by the OAuth callback before bouncing back here after a link.
  try { const m = sessionStorage.getItem('clics_link_msg'); if (m) { sessionStorage.removeItem('clics_link_msg'); toast(m, 'success'); } } catch {}

  const wrap = document.getElementById('linkGoogleWrap');
  const btn = document.getElementById('linkGoogleBtn');
  const msg = document.getElementById('linkGoogleMsg');
  if (!wrap || !btn) return;

  // Wait for the Supabase module (window.sbClient) before revealing the button — it needs it to start
  // the OAuth handshake. Mirrors the readiness guard used by the login/callback pages.
  function whenSbReady(cb) {
    if (typeof window.CLICS_SUPABASE_CONFIGURED === 'boolean') { cb(); return; }
    window.addEventListener('clics:sbready', () => cb(), { once: true });
    setTimeout(cb, 8000);
  }

  // /me carries linked_providers (+ the freshest specialty/position). Show "Link Google" only when
  // Google is configured AND not already linked.
  (async () => {
    const me = await api.me().catch(() => null);
    const u = me && me.user;
    if (!u) return;
    renderIdentity(u);
    try { localStorage.setItem('clics_user', JSON.stringify({ ...user, ...u })); } catch {}
    const linked = Array.isArray(u.linked_providers) && u.linked_providers.includes('google');
    if (linked) return;
    whenSbReady(() => { if (window.CLICS_SUPABASE_CONFIGURED && window.sbClient) wrap.style.display = ''; });
  })();

  btn.addEventListener('click', async () => {
    if (!window.sbClient) { if (msg) msg.textContent = 'Google ไม่พร้อมใช้งาน / Google not available.'; return; }
    btn.disabled = true;
    try { localStorage.setItem('clics_oauth_flow', JSON.stringify({ kind: 'link' })); } catch {}
    const redirectTo = location.origin + '/auth/callback';
    const { error } = await window.sbClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error) { btn.disabled = false; if (msg) msg.textContent = error.message || 'เชื่อมบัญชีไม่สำเร็จ / Link failed.'; }
  });
})();

// ---- Pilot: informed-consent gate (human-subjects study). The banner was removed by request;
// the de-identified-cases + provisional-scores expectations live in the consent dialog text. ----
(function pilotGate() {
  if (user.consented_at) return; // already consented

  // A warm, scannable welcome — three promises as icon rows, not a wall of legal text.
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `
    <div class="modal-card" style="max-width:520px;max-height:90vh;overflow:auto;" role="dialog" aria-modal="true">
      <p class="eyebrow">ยินดีต้อนรับสู่โครงการนำร่อง · Welcome</p>
      <h2 style="margin-bottom:6px;">ก่อนเริ่ม มีสามเรื่องที่อยากให้มั่นใจ<span class="bi-en" style="display:block;font-size:15px;margin-top:3px;">Three things, before you begin</span></h2>
      <div style="display:flex;flex-direction:column;gap:16px;margin:20px 0 18px;">
        <div class="consent-point">${icon('shield', 22)}<div><b>ใช้เฉพาะเคสที่ไม่ระบุตัวตน<span class="bi-en">Use de-identified cases only</span></b><p>ไม่ต้องใส่ชื่อหรือรหัสผู้ป่วย — ระบบเก็บเฉพาะการให้เหตุผลของคุณ / No patient names or IDs — we keep only your reasoning.</p></div></div>
        <div class="consent-point">${icon('hourglass', 22)}<div><b>คะแนนระยะนี้เป็นการทดลอง<span class="bi-en">Scores are provisional for now</span></b><p>ยังไม่นับเป็นหน่วยกิต CME — ระยะนี้คือการปรับเทียบเครื่องมือ / Not yet CME credit — this phase calibrates the instrument.</p></div></div>
        <div class="consent-point">${icon('checkCircle', 22)}<div><b>บันทึกและตรวจโดย AI และผู้ตรวจประเมิน<span class="bi-en">Recorded & reviewed by AI + auditors</span></b><p>เพื่อตรวจสอบความเที่ยงตรงและเป็นธรรมของการให้คะแนน / To validate that scoring is accurate and fair.</p></div></div>
      </div>
      <div id="consentChecks" style="display:flex;flex-direction:column;gap:9px;margin:4px 0 16px;font-size:13px;line-height:1.5;">
        <label class="consent-chk"><input type="checkbox" data-k="voluntary"> เข้าร่วมโดยสมัครใจ ถอนตัวได้ทุกเมื่อ / I take part voluntarily and may withdraw anytime.</label>
        <label class="consent-chk"><input type="checkbox" data-k="no_patient_data"> จะไม่กรอกข้อมูลที่ระบุตัวผู้ป่วย / I will not enter patient-identifiable data.</label>
        <label class="consent-chk"><input type="checkbox" data-k="research_only"> เข้าใจว่าคะแนนเป็นข้อมูลวิจัย ไม่ใช้ตัดสินใบอนุญาต / Scores are research data, not used for licensure.</label>
        <label class="consent-chk"><input type="checkbox" data-k="ai_expert_review"> ยินยอมให้ AI และผู้เชี่ยวชาญประเมินแบบไม่ระบุตัวตน / I consent to de-identified AI + expert evaluation.</label>
      </div>
      <p id="consentErr" class="error-msg" style="display:none;"></p>
      <button id="consentBtn" class="btn btn-primary" style="width:100%;" disabled>ยอมรับและเริ่มใช้งาน<span class="bi-en">I consent — let's begin</span></button>
    </div>`;
  document.body.appendChild(ov);
  const consentLabel = ov.querySelector('#consentBtn').innerHTML;
  // The button enables only when every required acknowledgement (Appendix 03) is ticked.
  const checks = [...ov.querySelectorAll('#consentChecks input[type=checkbox]')];
  const allChecked = () => checks.every(c => c.checked);
  checks.forEach(c => c.addEventListener('change', () => { document.getElementById('consentBtn').disabled = !allChecked(); }));
  document.getElementById('consentBtn').addEventListener('click', async () => {
    if (!allChecked()) return;
    const btn = document.getElementById('consentBtn'); btn.disabled = true; btn.textContent = 'กำลังบันทึก… / Saving…';
    const checkboxes = Object.fromEntries(checks.map(c => [c.dataset.k, c.checked]));
    const r = await api.consent({ context: 'physician', version: 'physician-v1', checkboxes });
    if (r?.ok) {
      user.consented_at = r.consented_at;
      try { localStorage.setItem('clics_user', JSON.stringify(user)); } catch {}
      ov.remove();
    } else {
      const e = document.getElementById('consentErr'); e.textContent = r?.error || 'บันทึกไม่สำเร็จ ลองใหม่ / Could not save — please try again.'; e.style.display = 'block';
      btn.disabled = false; btn.innerHTML = consentLabel;
    }
  });
})();

// ---- AI usage meter (pilot budget) ----
// Pull fresh figures from the server (cached login user predates any spend).
// Rendering lives in the shared helper (js/usage.js) so the dashboard and chat page match.
renderUsageBar(document.getElementById('usageBar'));

// ---- At-a-glance hero stats (a row of key numbers) ----
// Total + Passed come from the loaded PLE list; Latest score from the LPDP timeline. AI usage is
// NOT duplicated here — it has its own bar below. All derive from existing endpoints.
// Hidden by DEFAULT; the toggle button reveals them and the choice is remembered (clics_hero_stats).
function heroStatsShown() { try { return localStorage.getItem('clics_hero_stats') === '1'; } catch { return false; } }
function applyHeroStatsVisibility() {
  const host = document.getElementById('heroStats');
  const btn = document.getElementById('toggleStatsBtn');
  const shown = heroStatsShown();
  if (host && host.dataset.ready === '1') host.hidden = !shown; // reveal only once the cards are built
  if (btn) btn.innerHTML = (shown ? 'ซ่อนสถิติ' : 'แสดงสถิติ') +
    '<span class="bi-en">' + (shown ? 'Hide stats' : 'Show stats') + '</span>';
}

// CREC082 ICF §3 step 4: one brief questionnaire at the end of participation. A named SECONDARY
// OUTCOME in the SAP, so an unanswered one is a missing result — but it is also entirely voluntary,
// which is why this is a prompt on the dashboard rather than a gate in front of anything.
//
// Rendered only when it is genuinely due: at least one completed PLE, and no response on file. The
// server decides both; asking it here keeps one definition of "due" rather than two.
async function renderAcceptabilityPrompt() {
  const host = document.getElementById('acceptabilityPrompt');
  if (!host) return;
  let d;
  try { d = await api.getAcceptability(); } catch { return; }
  if (!d || d.error || !d.eligible || d.response) return;
  // Stronger nudge once they have finished all three, since that is the protocol's expected moment.
  const done = d.completed_ples >= 3;
  host.innerHTML =
    `<div class="card" style="margin-bottom:14px;display:flex;flex-wrap:wrap;gap:.8rem;align-items:center;justify-content:space-between">
       <div style="min-width:0">
         <p style="margin:0;font-weight:500">${done ? 'ท่านทำครบแล้ว — ขอความเห็นสักเล็กน้อย' : 'ขอความเห็นเกี่ยวกับระบบ'}<span class="bi-en">${done ? "You've completed the study — a few questions before you go" : 'Tell us how the system is working for you'}</span></p>
         <p class="sub" style="margin:.25rem 0 0;font-size:.85rem">แบบสอบถามสั้น ๆ ครั้งเดียว ประมาณ 10 นาที · ตอบหรือไม่ตอบก็ได้ / One short questionnaire, about 10 minutes. Entirely voluntary.</p>
       </div>
       <a href="/acceptability" class="btn ${done ? 'btn-primary' : 'btn-ghost'}" style="flex-shrink:0">ตอบแบบสอบถาม<span class="bi-en">Answer</span></a>
     </div>`;
}

async function renderHeroStats() {
  const host = document.getElementById('heroStats');
  if (!host) return;
  const total = ples.length;
  // 'ple_pass' is transient — a scored PLE moves straight to 'evaluated'. Counting only 'ple_pass'
  // showed 0 completed to physicians who had in fact finished. Mirrors backend lib/ple-status.js.
  const passed = ples.filter(p => p.status === 'ple_pass' || p.status === 'evaluated').length;

  let latest = '—'; // most recent composite (0–100), '—' until a PLE passes
  let latestLabel = 'คะแนนล่าสุด / Latest score';
  try {
    const lpdp = await api.getLpdp();
    // Accepts both the bare array and the { snapshots, held } shape — the portal and the backend
    // deploy independently, so one is routinely ahead of the other.
    const snaps = Array.isArray(lpdp) ? lpdp : (lpdp?.snapshots ?? []);
    const held = Array.isArray(lpdp) ? 0 : (lpdp?.held ?? 0);
    // '—' is honest for "none yet" but misleading for "withheld pending audit". The distinction
    // goes in the label rather than the value: this slot is numeric everywhere else, and the strip
    // is bilingual everywhere else. Wording matches ple-result.html and /lpdp.
    if (snaps.length) latest = Math.round(snaps[snaps.length - 1].composite_score);
    else if (held > 0) latestLabel = 'อยู่ระหว่างการตรวจประเมิน / Under expert review';
  } catch { /* leave '—' */ }

  // Each KPI is a link to the progress page, which details these numbers over time.
  const cards = [
    { value: total, label: 'บทเรียนทั้งหมด / Total' },
    { value: passed, label: 'ผ่านแล้ว / Passed' },
    { value: latest, label: latestLabel },
  ];
  host.innerHTML = cards.map(c =>
    `<a class="stat-card" href="/lpdp"><p class="stat-value">${esc(String(c.value))}</p><p class="stat-label">${c.label}</p></a>`
  ).join('');
  host.dataset.ready = '1';
  applyHeroStatsVisibility(); // respect the remembered show/hide choice (default hidden)
}

// Wire the show/hide stats toggle (default hidden; choice remembered across visits).
(function wireStatsToggle() {
  const btn = document.getElementById('toggleStatsBtn');
  if (!btn) return;
  applyHeroStatsVisibility(); // set the initial label (before the cards finish building)
  btn.addEventListener('click', () => {
    try { localStorage.setItem('clics_hero_stats', heroStatsShown() ? '0' : '1'); } catch {}
    applyHeroStatsVisibility();
  });
})();

// ---- Dual-role: auditor-console shortcut / request-auditor button (header slot) ----
// can_audit physicians get a direct link to the auditor console; plain physicians can
// request the role (POST /auth/request-auditor → admin approval). GET drives initial state.
(async function auditorEntry() {
  const slot = document.getElementById('auditorSlot');
  if (!slot) return;

  function makeBtn(text) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost';
    b.style.cssText = 'font-size:12px;padding:6px 12px;';
    b.textContent = text;
    return b;
  }
  function renderShortcut() {
    const a = document.createElement('a');
    a.className = 'btn btn-ghost';
    a.style.cssText = 'font-size:12px;padding:6px 12px;';
    a.textContent = 'ตรวจประเมิน / Auditor console →';
    a.href = (window.CLICS_DASHBOARD_URL || 'http://localhost:3002')
      + '/login?token=' + encodeURIComponent(localStorage.getItem('clics_token'));
    slot.replaceChildren(a);
  }
  function renderPending() {
    const b = makeBtn('รออนุมัติ / Pending approval');
    b.disabled = true;
    slot.replaceChildren(b);
  }
  function renderRequest() {
    const b = makeBtn('ขอสิทธิ์ผู้ตรวจ / Request auditor role');
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'กำลังส่ง... / Sending...';
      const res = await api.requestAuditor();
      const code = res?.body?.code;
      if (res?.status === 202 || (res?.status === 409 && code === 'pending')) renderPending();
      else if (res?.status === 409 && code === 'already_auditor') renderShortcut();
      else { b.disabled = false; b.textContent = 'ขอสิทธิ์ผู้ตรวจ / Request auditor role'; }
    });
    slot.replaceChildren(b);
  }

  if (user.can_audit) { renderShortcut(); return; }
  if (user.role !== 'physician') return;
  // Stored user may be stale (rights granted after login) — ask the server for the truth.
  let res = null;
  try { res = await api.getAuditorRequest(); } catch { /* leave the slot empty on failure */ }
  if (!res || !res.ok || !res.body) return;
  if (res.body.can_audit) renderShortcut();
  else if (res.body.request?.status === 'pending') renderPending();
  else renderRequest();
})();

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.logout();
  // Preserve display prefs across logout (mirror the index.html ?logout=1 handler) so signing out
  // doesn't reset a dark-mode user to light.
  const t = localStorage.getItem('clics_theme'), v = localStorage.getItem('clics_view');
  localStorage.clear();
  if (t) localStorage.setItem('clics_theme', t);
  if (v) localStorage.setItem('clics_view', v);
  window.location.href = '/';
});

// STATUS_LABELS comes from /js/labels.js (loaded before this script).
const UNCAT = '__uncat__';
const listEl = document.getElementById('pleList');

let folders = [];      // [{id, name, ...}]
let ples = [];         // [{id, title, chief_complaint, folder_id, status, ...}]

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Transient error banner for folder/conversation mutations (failures used to revert silently).
// Uses the server's error string when it has one; zod-flatten objects fall back to the message.
let flashErrTimer = null;
function flashError(res, fallback) {
  const msg = (typeof res?.error === 'string' && res.error) || fallback;
  let el = document.getElementById('listErr');
  if (!el) {
    el = document.createElement('p');
    el.id = 'listErr';
    el.className = 'error-msg';
    listEl.before(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(flashErrTimer);
  flashErrTimer = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

function collapsedSet() {
  try { return new Set(JSON.parse(localStorage.getItem('clics_folders_collapsed') || '[]')); }
  catch { return new Set(); }
}
function persistCollapsed(set) {
  try { localStorage.setItem('clics_folders_collapsed', JSON.stringify([...set])); } catch {}
}

function convTitle(p) {
  return p.title || p.chief_complaint || `Professional Learning Episode ${new Date(p.started_at).toLocaleDateString('th-TH')}`;
}

function folderOptions(currentId) {
  const cur = currentId ?? '';
  const opts = [`<option value="" ${cur === '' ? 'selected' : ''}>— ไม่จัดหมวด / Uncategorized</option>`];
  for (const f of folders) {
    opts.push(`<option value="${esc(f.id)}" ${cur === f.id ? 'selected' : ''}>${esc(f.name)}</option>`);
  }
  return opts.join('');
}

// Invariant glyphs (no per-row data) — build the SVG once, not per conversation row on every render().
const ICON_PENCIL = icon('pencil');
const ICON_TRASH = icon('trash');

function convRow(p) {
  const date = new Date(p.started_at).toLocaleDateString('th-TH');
  return `
    <div class="conv-row" data-id="${esc(p.id)}">
      <div class="conv-main" data-action="open" data-id="${esc(p.id)}" role="button" tabindex="0">
        <p class="conv-title" data-title="${esc(convTitle(p))}">${esc(convTitle(p))}</p>
        <p class="conv-meta">${p.turn_count ?? 0} รอบ · ${esc(date)}</p>
      </div>
      <div class="conv-side">
        <span class="badge badge-${esc(p.status)}">${esc(STATUS_LABELS[p.status] ?? p.status)}</span>
        <div class="conv-actions">
          <button class="icon-btn" type="button" title="เปลี่ยนชื่อ / Rename" aria-label="เปลี่ยนชื่อ / Rename" data-action="rename-conv" data-id="${esc(p.id)}">${ICON_PENCIL}</button>
          <select class="conv-move" title="ย้ายโฟลเดอร์ / Move to folder" data-action="move-conv" data-id="${esc(p.id)}">
            ${folderOptions(p.folder_id)}
          </select>
          <button class="icon-btn icon-btn-danger" type="button" title="ลบ / Delete" aria-label="ลบ / Delete" data-action="delete-conv" data-id="${esc(p.id)}">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`;
}

function groupHtml(key, name, items, { deletable }) {
  const collapsed = collapsedSet().has(key);
  const controls = deletable ? `
    <span class="folder-controls">
      <button class="icon-btn" type="button" title="เปลี่ยนชื่อโฟลเดอร์ / Rename folder" aria-label="เปลี่ยนชื่อโฟลเดอร์ / Rename folder" data-action="rename-folder" data-id="${esc(key)}">${ICON_PENCIL}</button>
      <button class="icon-btn icon-btn-danger" type="button" title="ลบโฟลเดอร์ / Delete folder" aria-label="ลบโฟลเดอร์ / Delete folder" data-action="delete-folder" data-id="${esc(key)}">${ICON_TRASH}</button>
    </span>` : '';
  const body = items.length
    ? items.map(convRow).join('')
    : `<p class="list-empty">ยังไม่มีการสนทนาในโฟลเดอร์นี้</p>`;
  return `
    <section class="folder-group ${collapsed ? 'is-collapsed' : ''}" data-key="${esc(key)}">
      <div class="folder-head">
        <button class="folder-toggle" type="button" data-action="toggle" data-key="${esc(key)}" aria-expanded="${!collapsed}">
          <span class="folder-caret">▾</span>
          <span class="folder-name" data-name="${esc(name)}">${esc(name)}</span>
          <span class="folder-count">${items.length}</span>
        </button>
        ${controls}
      </div>
      <div class="folder-body">${body}</div>
    </section>`;
}

function render() {
  if (!ples.length && !folders.length) {
    // The call-to-action lives IN the void, where the eye lands — not only up in the toolbar.
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>ยังไม่มี Professional Learning Episode</h3>
        <p>เริ่มบทเรียนต่อเนื่องแรกของคุณได้เลย / Start your first Professional Learning Episode.</p>
        <a href="/ple-new" class="btn btn-primary btn-lg">+ เริ่ม Professional Learning Episode ใหม่<span class="bi-en">New Professional Learning Episode</span></a>
      </div>`;
    return;
  }
  const byFolder = new Map();
  for (const f of folders) byFolder.set(f.id, []);
  const uncat = [];
  for (const p of ples) {
    if (p.folder_id && byFolder.has(p.folder_id)) byFolder.get(p.folder_id).push(p);
    else uncat.push(p);
  }

  const sections = [];
  for (const f of folders) {
    sections.push(groupHtml(f.id, f.name, byFolder.get(f.id), { deletable: true }));
  }
  if (uncat.length || !folders.length) {
    sections.push(groupHtml(UNCAT, 'ไม่จัดหมวด / Uncategorized', uncat, { deletable: false }));
  }
  listEl.innerHTML = sections.join('');
}

// ----- inline editing helper -----
// maxLen mirrors the backend zod limits: 80 for folder names, 120 for conversation titles.
function inlineEdit(spanEl, current, onSave, maxLen = 120) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit';
  input.value = current;
  input.maxLength = maxLen;
  // The span lives inside a data-action element (conv-main "open" / folder-toggle);
  // stop pointer events so clicking into the field doesn't navigate or collapse.
  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('click', e => e.stopPropagation());
  spanEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const val = input.value.trim();
    if (commit && val && val !== current) await onSave(val);
    render(); // rebuild from state
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// ----- event delegation -----
listEl.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;

  if (action === 'open') {
    window.location.href = `/ple-chat?id=${encodeURIComponent(t.dataset.id)}`;
  } else if (action === 'toggle') {
    const key = t.dataset.key;
    const set = collapsedSet();
    set.has(key) ? set.delete(key) : set.add(key);
    persistCollapsed(set);
    t.closest('.folder-group').classList.toggle('is-collapsed');
    t.setAttribute('aria-expanded', String(!set.has(key)));
  } else if (action === 'rename-folder') {
    const id = t.dataset.id;
    const nameSpan = t.closest('.folder-head').querySelector('.folder-name');
    inlineEdit(nameSpan, nameSpan.dataset.name, async (val) => {
      const updated = await api.renameFolder(id, val);
      if (updated?.name) {
        const f = folders.find(x => x.id === id);
        if (f) f.name = updated.name;
      } else {
        flashError(updated, 'เปลี่ยนชื่อโฟลเดอร์ไม่สำเร็จ / Could not rename folder');
      }
    }, 80);
  } else if (action === 'delete-folder') {
    const id = t.dataset.id;
    const f = folders.find(x => x.id === id);
    const okDel = await confirmModal({
      title: 'ลบโฟลเดอร์? / Delete folder?',
      body: `ลบโฟลเดอร์ <b>"${esc(f?.name ?? '')}"</b>? การสนทนาจะย้ายไปยัง “ไม่จัดหมวด”<br><span style="color:var(--muted)">Its conversations move to Uncategorized.</span>`,
      confirmLabel: 'ลบ / Delete', danger: true,
    });
    if (!okDel) return;
    const res = await api.deleteFolder(id);
    if (!res?.ok) flashError(res, 'ลบโฟลเดอร์ไม่สำเร็จ / Could not delete folder');
    await load(); // resync either way (the folder may already be gone server-side)
  } else if (action === 'rename-conv') {
    const id = t.dataset.id;
    const titleEl = t.closest('.conv-row').querySelector('.conv-title');
    inlineEdit(titleEl, titleEl.dataset.title, async (val) => {
      const updated = await api.updatePle(id, { title: val });
      if (updated?.title) {
        const p = ples.find(x => x.id === id);
        if (p) p.title = updated.title;
      } else {
        flashError(updated, 'เปลี่ยนชื่อไม่สำเร็จ / Could not rename conversation');
      }
    });
  } else if (action === 'delete-conv') {
    const id = t.dataset.id;
    const p = ples.find(x => x.id === id);
    const okDel = await confirmModal({
      title: 'ลบการสนทนา? / Delete conversation?',
      body: `ลบถาวร: <b>"${esc(p ? convTitle(p) : '')}"</b><br><span style="color:var(--muted)">This cannot be undone.</span>`,
      confirmLabel: 'ลบ / Delete', danger: true,
    });
    if (!okDel) return;
    const res = await api.deletePle(id);
    if (res && res.ok) {
      ples = ples.filter(x => x.id !== id);
      render();
    } else {
      toast('ลบไม่สำเร็จ / Could not delete', 'error');
    }
  }
});

// move-to-folder select
listEl.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-action="move-conv"]');
  if (!sel) return;
  const id = sel.dataset.id;
  const folderId = sel.value || null;
  const updated = await api.updatePle(id, { folder_id: folderId });
  if (updated && updated.id) {
    const p = ples.find(x => x.id === id);
    if (p) p.folder_id = updated.folder_id ?? null;
    render();
  } else {
    toast('ย้ายโฟลเดอร์ไม่สำเร็จ / Could not move conversation', 'error');
    await load(); // resync from server
  }
});

// keyboard open on conv-main
listEl.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('conv-main')) {
    e.preventDefault();
    window.location.href = `/ple-chat?id=${encodeURIComponent(e.target.dataset.id)}`;
  }
});

// ----- new-folder toolbar -----
const newFolderBtn = document.getElementById('newFolderBtn');
const newFolderForm = document.getElementById('newFolderForm');
const newFolderName = document.getElementById('newFolderName');
newFolderBtn.addEventListener('click', () => {
  newFolderForm.hidden = !newFolderForm.hidden;
  if (!newFolderForm.hidden) newFolderName.focus();
});
document.getElementById('cancelFolderBtn').addEventListener('click', () => {
  newFolderForm.hidden = true; newFolderName.value = '';
});
newFolderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newFolderName.value.trim();
  if (!name) return;
  const created = await api.createFolder(name);
  if (created?.id) { folders.push(created); newFolderName.value = ''; newFolderForm.hidden = true; render(); }
  else flashError(created, 'สร้างโฟลเดอร์ไม่สำเร็จ / Could not create folder');
});

// ----- load -----
async function load() {
  const [f, p] = await Promise.all([api.getFolders(), api.getPlEs()]);
  // An error envelope ({error}) is NOT an empty result. Coercing it to [] used to render the
  // "ยังไม่มี PLE / No episodes yet" empty state on a 502/network blip — telling a physician with a
  // full history they have nothing. Show the error + Retry instead; only render empty on a real [].
  if (!Array.isArray(f) || !Array.isArray(p)) {
    listEl.innerHTML = '<p class="error-msg">โหลดข้อมูลไม่สำเร็จ กรุณารีเฟรช / Could not load your episodes. Please refresh.</p>';
    return;
  }
  folders = f;
  ples = p;
  render();
  renderHeroStats(); // fire-and-forget; computes from the freshly loaded list + LPDP/usage
  renderAcceptabilityPrompt(); // fire-and-forget; shows nothing unless the questionnaire is due
}

load().catch(() => {
  listEl.innerHTML = '<p class="error-msg">โหลดข้อมูลไม่สำเร็จ กรุณารีเฟรช / Could not load your episodes. Please refresh.</p>';
});
