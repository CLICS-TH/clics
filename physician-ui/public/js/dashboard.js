auth.guardRole('physician');
const user = auth.getUser();
document.getElementById('greeting').textContent = `สวัสดี, ${user.full_name_th || user.full_name_en}`;

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.logout();
  localStorage.clear();
  window.location.href = '/';
});

const STATUS_LABELS = {
  active: 'กำลังดำเนินการ / Active',
  ended: 'สิ้นสุดแล้ว / Ended',
  cle_pass: 'ผ่าน CLE / Passed',
  cle_fail_t1: 'ไม่ผ่าน CLE / Failed',
  cle_flag_t2: 'รอตรวจสอบ / Under Review',
  evaluated: 'ประเมินแล้ว / Evaluated',
};

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
