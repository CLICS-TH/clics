const user = auth.guardRole('physician'); // throws (and heals storage) when the session is unusable
document.getElementById('greeting').textContent = `สวัสดี, ${user.full_name_th || user.full_name_en}`;

// ---- Pilot: expectation banner + informed-consent gate (human-subjects study) ----
(function pilotGate() {
  const host = document.querySelector('main') || document.body;
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#fff5e6;border:1px solid #e8a55a;color:#6b4a1a;padding:8px 14px;border-radius:10px;font-size:13px;margin:0 0 14px;';
  banner.innerHTML = '⚠️ ใช้เคสที่ไม่ระบุตัวตนผู้ป่วยเท่านั้น · คะแนนเป็นเบื้องต้น ยังไม่ใช่หน่วยกิต CME — Use de-identified cases only · scores are provisional (not yet CME credit).';
  host.insertBefore(banner, host.firstChild);

  if (user.consented_at) return; // already consented

  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px;';
  ov.innerHTML = `
    <div style="background:var(--surface-card,#fff);color:var(--body-color,#1a1a1a);max-width:560px;border-radius:16px;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,.3);max-height:85vh;overflow:auto;">
      <h2 style="margin:0 0 10px;color:var(--ink,#141413);">ความยินยอมเข้าร่วม / Informed consent</h2>
      <p style="font-size:14px;line-height:1.6;">
        นี่คือการศึกษานำร่อง (pilot) ของระบบ CLICS เพื่อพัฒนาการประเมินการให้เหตุผลทางคลินิก บทสนทนาของคุณจะถูกบันทึกและประเมินด้วย AI และผู้ตรวจประเมิน <b>กรุณาใช้เฉพาะเคสที่ไม่ระบุตัวตนผู้ป่วย</b> และคะแนนในระยะนี้ยังไม่ใช่หน่วยกิต CME<br><br>
        This is a CLICS pilot study. Your conversations are recorded and scored (by AI + expert auditors) to validate the system. <b>Use de-identified cases only.</b> Scores in this phase are provisional and do not yet count as CME credit.
      </p>
      <p id="consentErr" style="color:#c0392b;font-size:13px;display:none;"></p>
      <button id="consentBtn" class="btn btn-primary" style="width:100%;margin-top:8px;">ยอมรับและเริ่มใช้งาน / I consent</button>
    </div>`;
  document.body.appendChild(ov);
  document.getElementById('consentBtn').addEventListener('click', async () => {
    const btn = document.getElementById('consentBtn'); btn.disabled = true; btn.textContent = 'กำลังบันทึก…';
    const r = await api.consent();
    if (r?.ok) {
      user.consented_at = r.consented_at;
      try { localStorage.setItem('clics_user', JSON.stringify(user)); } catch {}
      ov.remove();
    } else {
      const e = document.getElementById('consentErr'); e.textContent = r?.error || 'บันทึกไม่สำเร็จ ลองใหม่'; e.style.display = 'block';
      btn.disabled = false; btn.textContent = 'ยอมรับและเริ่มใช้งาน / I consent';
    }
  });
})();

// ---- AI usage meter (pilot budget) ----
// Pull fresh figures from the server (cached login user predates any spend).
(async function usageMeter() {
  const host = document.getElementById('usageBar');
  if (!host) return;
  let me;
  try { me = await api.me(); } catch { return; }
  const u = me?.user;
  const limit = Number(u?.usage_limit_effective_usd);
  if (!u || !Number.isFinite(limit) || limit <= 0) return; // nothing meaningful to show
  const used = Number(u.usage_cost_usd ?? 0);
  const tokens = (Number(u.usage_input_tokens) || 0) + (Number(u.usage_output_tokens) || 0);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const over = used >= limit;
  const color = over ? '#c0392b' : pct >= 80 ? '#e08a1e' : '#3a8a52';
  host.innerHTML = `
    <div style="background:var(--surface-card,#fff);border:1px solid var(--hairline,#e2e2e2);color:var(--body-color,#1a1a1a);border-radius:12px;padding:10px 14px;margin:0 0 14px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;">
        <span>การใช้งาน AI / AI usage</span>
        <span style="font-variant-numeric:tabular-nums;color:${color};font-weight:600;">$${used.toFixed(4)} / $${limit.toFixed(2)} (${pct}%) <span style="color:var(--muted,#6c6a64);font-weight:400;">· ${tokens.toLocaleString()} tokens</span></span>
      </div>
      <div style="height:8px;background:rgba(127,127,127,.22);border-radius:99px;overflow:hidden;margin-top:6px;">
        <div style="height:100%;width:${pct}%;background:${color};transition:width .3s;"></div>
      </div>
      ${over ? '<div style="color:#c0392b;font-weight:600;margin-top:5px;">ถึงขีดจำกัดแล้ว — ติดต่อผู้ดูแลระบบ / Limit reached — contact an administrator.</div>' : ''}
    </div>`;
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
  localStorage.clear();
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

function collapsedSet() {
  try { return new Set(JSON.parse(localStorage.getItem('clics_folders_collapsed') || '[]')); }
  catch { return new Set(); }
}
function persistCollapsed(set) {
  try { localStorage.setItem('clics_folders_collapsed', JSON.stringify([...set])); } catch {}
}

function convTitle(p) {
  return p.title || p.chief_complaint || `PLE ${new Date(p.started_at).toLocaleDateString('th-TH')}`;
}

function folderOptions(currentId) {
  const cur = currentId ?? '';
  const opts = [`<option value="" ${cur === '' ? 'selected' : ''}>— ไม่จัดหมวด / Uncategorized</option>`];
  for (const f of folders) {
    opts.push(`<option value="${esc(f.id)}" ${cur === f.id ? 'selected' : ''}>${esc(f.name)}</option>`);
  }
  return opts.join('');
}

function convRow(p) {
  const date = new Date(p.started_at).toLocaleDateString('th-TH');
  return `
    <div class="conv-row" data-id="${esc(p.id)}">
      <div class="conv-main" data-action="open" data-id="${esc(p.id)}" role="button" tabindex="0">
        <p class="conv-title" data-title="${esc(convTitle(p))}">${esc(convTitle(p))}</p>
        <p class="conv-meta">${p.turn_count ?? 0} รอบ · ${p.token_count ?? 0} tokens · ${esc(date)}</p>
      </div>
      <div class="conv-side">
        <span class="badge badge-${esc(p.status)}">${esc(STATUS_LABELS[p.status] ?? p.status)}</span>
        <div class="conv-actions">
          <button class="icon-btn" type="button" title="เปลี่ยนชื่อ / Rename" data-action="rename-conv" data-id="${esc(p.id)}">✎</button>
          <select class="conv-move" title="ย้ายโฟลเดอร์ / Move to folder" data-action="move-conv" data-id="${esc(p.id)}">
            ${folderOptions(p.folder_id)}
          </select>
          <button class="icon-btn icon-btn-danger" type="button" title="ลบ / Delete" data-action="delete-conv" data-id="${esc(p.id)}">🗑</button>
        </div>
      </div>
    </div>`;
}

function groupHtml(key, name, items, { deletable }) {
  const collapsed = collapsedSet().has(key);
  const controls = deletable ? `
    <span class="folder-controls">
      <button class="icon-btn" type="button" title="เปลี่ยนชื่อโฟลเดอร์ / Rename folder" data-action="rename-folder" data-id="${esc(key)}">✎</button>
      <button class="icon-btn icon-btn-danger" type="button" title="ลบโฟลเดอร์ / Delete folder" data-action="delete-folder" data-id="${esc(key)}">🗑</button>
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
    listEl.innerHTML = '<p class="list-empty" style="padding:40px">ยังไม่มี PLE — เริ่มต้นได้เลย! / No episodes yet — get started!</p>';
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
function inlineEdit(spanEl, current, onSave) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit';
  input.value = current;
  input.maxLength = 120;
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
      const f = folders.find(x => x.id === id);
      if (f && updated?.name) f.name = updated.name;
    });
  } else if (action === 'delete-folder') {
    const id = t.dataset.id;
    const f = folders.find(x => x.id === id);
    if (!confirm(`ลบโฟลเดอร์ "${f?.name ?? ''}"? การสนทนาจะย้ายไปยัง "ไม่จัดหมวด"\nDelete folder? Its conversations move to Uncategorized.`)) return;
    await api.deleteFolder(id);
    await load();
  } else if (action === 'rename-conv') {
    const id = t.dataset.id;
    const titleEl = t.closest('.conv-row').querySelector('.conv-title');
    inlineEdit(titleEl, titleEl.dataset.title, async (val) => {
      const updated = await api.updatePle(id, { title: val });
      const p = ples.find(x => x.id === id);
      if (p && updated?.title) p.title = updated.title;
    });
  } else if (action === 'delete-conv') {
    const id = t.dataset.id;
    const p = ples.find(x => x.id === id);
    if (!confirm(`ลบการสนทนานี้ถาวร? / Delete this conversation permanently?\n"${p ? convTitle(p) : ''}"`)) return;
    const res = await api.deletePle(id);
    if (res && res.ok) {
      ples = ples.filter(x => x.id !== id);
      render();
    } else {
      alert('ลบไม่สำเร็จ / Could not delete');
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
    alert('ย้ายโฟลเดอร์ไม่สำเร็จ / Could not move conversation');
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
});

// ----- load -----
async function load() {
  const [f, p] = await Promise.all([api.getFolders(), api.getPlEs()]);
  folders = Array.isArray(f) ? f : [];
  ples = Array.isArray(p) ? p : [];
  render();
}

load().catch(() => {
  listEl.innerHTML = '<p class="error-msg">โหลดข้อมูลไม่สำเร็จ</p>';
});
