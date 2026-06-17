# CLICS Frontend Implementation Plan

> ⚠️ **SUPERSEDED / HISTORICAL (kept for reference).** This is the original 2026-06-04 build plan. Parts are
> now out of date — notably, the auditor scorer is no longer sliders: it is tappable 0–5 chips in
> `audit-dashboard/components/DomainScorer.tsx` (the old `DomainSliders.tsx` was deleted in the 2026-06-13
> Claude Design audit). For the current state see [`../../HANDOFF.md`](../../HANDOFF.md) and the per-layer
> READMEs; verify against the actual code before implementing anything from this doc.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build both CLICS frontend apps — the physician HTML/JS interface (port 3000) and the Next.js audit dashboard (port 3002) — on top of the completed backend (see `2026-06-04-clics-backend.md`).

**Architecture:** Two separate apps sharing one Supabase Auth JWT. Physician UI is plain HTML + Vanilla JS served by a static file server. Audit Dashboard is Next.js 14 App Router with role-based routing, shadcn/ui components, and Recharts for ICC/LPDP visualisations.

**Tech Stack:** HTML5, Vanilla JS, marked.js (physician UI) · Next.js 14, React 18, shadcn/ui, Recharts (audit dashboard) · Shared: Supabase JS SDK v2

**Prerequisite:** Backend (port 3001) and RIMPL (port 3003) must be running before testing these apps.

---

## File Structure

```
clics/
├── physician-ui/
│   ├── package.json               # serve + marked.js
│   ├── public/
│   │   ├── index.html             # Login page
│   │   ├── dashboard.html
│   │   ├── cle-new.html
│   │   ├── cle-chat.html
│   │   ├── cle-result.html
│   │   ├── lpdp.html
│   │   ├── js/
│   │   │   ├── api.js             # fetch wrapper with JWT + BASE_URL
│   │   │   ├── auth.js            # login(), logout(), getUser(), guardPage()
│   │   │   ├── dashboard.js
│   │   │   ├── cle-new.js
│   │   │   ├── cle-chat.js        # chat loop, timer, turn/token counters
│   │   │   ├── cle-result.js      # PIS-7 radar chart (Chart.js)
│   │   │   └── lpdp.js            # LPDP line chart (Chart.js)
│   │   └── css/
│   │       └── main.css
│
├── audit-dashboard/
│   ├── package.json
│   ├── next.config.mjs
│   ├── app/
│   │   ├── layout.tsx             # Root layout + font
│   │   ├── page.tsx               # Redirect to /login
│   │   ├── login/
│   │   │   └── page.tsx
│   │   ├── auditor/
│   │   │   ├── queue/page.tsx
│   │   │   └── cles/[id]/page.tsx
│   │   └── admin/
│   │       ├── cles/page.tsx
│   │       ├── flagged/page.tsx
│   │       ├── stats/page.tsx
│   │       ├── users/page.tsx
│   │       ├── icc/page.tsx
│   │       └── lpdp/[id]/page.tsx
│   ├── components/
│   │   ├── DomainSliders.tsx      # 7-domain scoring sliders
│   │   ├── IccPanel.tsx           # ICC estimate + CI + interpretation badge
│   │   ├── BlandAltmanPlot.tsx    # Recharts scatter plot
│   │   ├── LpdpChart.tsx          # Recharts line chart
│   │   └── TranscriptView.tsx     # Read-only message thread
│   └── lib/
│       ├── api.ts                 # typed fetch wrapper
│       └── auth.ts                # getToken(), redirectIfNoAuth()
```

---

## Task 19: Physician UI — Scaffold + Shared API Layer

**Files:**
- Create: `physician-ui/package.json`
- Create: `physician-ui/public/js/api.js`
- Create: `physician-ui/public/js/auth.js`
- Create: `physician-ui/public/css/main.css`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "clics-physician-ui",
  "version": "1.0.0",
  "scripts": {
    "dev": "npx serve public -l 3000 --cors"
  },
  "devDependencies": {
    "serve": "^14.2.0"
  }
}
```

- [ ] **Step 2: Write public/js/api.js**

```javascript
// physician-ui/public/js/api.js
const BASE = 'http://localhost:3001';

function getToken() {
  return localStorage.getItem('clics_token');
}

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
  if (res.status === 401) {
    localStorage.clear();
    window.location.href = '/index.html';
    return;
  }
  return res.json();
}

window.api = {
  login: (email, password) =>
    apiFetch('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => apiFetch('/auth/logout', { method: 'POST' }),
  me: () => apiFetch('/auth/me'),
  createPle: (body) => apiFetch('/cles', { method: 'POST', body }),
  getPlEs: () => apiFetch('/cles'),
  getPle: (id) => apiFetch(`/cles/${id}`),
  sendMessage: (id, body) => apiFetch(`/cles/${id}/message`, { method: 'POST', body }),
  endPle: (id) => apiFetch(`/cles/${id}/end`, { method: 'POST' }),
  getEvaluation: (id) => apiFetch(`/cles/${id}/evaluation`),
  getLpdp: () => apiFetch('/auth/me').then(({ user }) =>
    apiFetch(`/admin/lpdp/${user.id}`)
  ),
};
```

- [ ] **Step 3: Write public/js/auth.js**

```javascript
// physician-ui/public/js/auth.js
function getUser() {
  const raw = localStorage.getItem('clics_user');
  return raw ? JSON.parse(raw) : null;
}

function guardPage() {
  const token = localStorage.getItem('clics_token');
  if (!token) window.location.href = '/index.html';
}

function guardRole(...roles) {
  const user = getUser();
  if (!user || !roles.includes(user.role)) {
    window.location.href = '/index.html';
  }
}

window.auth = { getUser, guardPage, guardRole };
```

- [ ] **Step 4: Write public/css/main.css**

```css
/* physician-ui/public/css/main.css */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Noto Sans Thai', 'Noto Sans', sans-serif;
  background: #f5f7fa;
  color: #1a1a2e;
  font-size: 15px;
  line-height: 1.6;
}

.container { max-width: 860px; margin: 0 auto; padding: 24px 16px; }

/* Cards */
.card {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  padding: 20px 24px;
  margin-bottom: 16px;
}

/* Status badges */
.badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.badge-active      { background: #dbeafe; color: #1d4ed8; }
.badge-evaluated   { background: #dcfce7; color: #166534; }
.badge-cle_pass    { background: #d1fae5; color: #065f46; }
.badge-cle_fail_t1 { background: #fee2e2; color: #991b1b; }
.badge-cle_flag_t2 { background: #fef9c3; color: #854d0e; }
.badge-ended       { background: #f3f4f6; color: #374151; }

/* Buttons */
.btn {
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.btn:hover { opacity: 0.85; }
.btn-primary { background: #2563eb; color: #fff; }
.btn-danger  { background: #dc2626; color: #fff; }
.btn-ghost   { background: #f3f4f6; color: #374151; }

/* Chat layout */
.chat-window {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 200px);
  min-height: 400px;
}
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg-physician {
  align-self: flex-end;
  background: #2563eb;
  color: #fff;
  padding: 12px 16px;
  border-radius: 16px 16px 4px 16px;
  max-width: 72%;
}
.msg-assistant {
  align-self: flex-start;
  background: #fff;
  border: 1px solid #e5e7eb;
  padding: 12px 16px;
  border-radius: 16px 16px 16px 4px;
  max-width: 82%;
}
.msg-refs {
  margin-top: 8px;
  font-size: 12px;
  color: #6b7280;
}
.msg-socratic {
  margin-top: 10px;
  font-style: italic;
  color: #2563eb;
  font-weight: 500;
}
.chat-input-row {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid #e5e7eb;
}
.chat-input-row textarea {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  resize: none;
  font-family: inherit;
  font-size: 14px;
}
.session-bar {
  display: flex;
  gap: 20px;
  align-items: center;
  background: #f8fafc;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13px;
  color: #64748b;
  margin-bottom: 12px;
}
.session-bar span { font-weight: 600; color: #1e293b; }

/* Form */
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-weight: 600; margin-bottom: 6px; }
.form-group input, .form-group textarea, .form-group select {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
}
.error-msg { color: #dc2626; font-size: 13px; margin-top: 8px; }

/* Nav */
nav {
  background: #1e293b;
  color: #fff;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
nav .brand { font-weight: 700; font-size: 16px; letter-spacing: 0.5px; }
nav a { color: #94a3b8; text-decoration: none; font-size: 13px; margin-left: 16px; }
nav a:hover { color: #fff; }
```

- [ ] **Step 5: Install and run dev server**

```bash
cd physician-ui && npm install && npm run dev
```
Expected: serving on http://localhost:3000

- [ ] **Step 6: Commit**

```bash
git add physician-ui/
git commit -m "feat: scaffold physician ui with api and auth helpers"
```

---

## Task 20: Physician UI — Login Page

**Files:**
- Create: `physician-ui/public/index.html`
- Create: `physician-ui/public/js/login.js` (inline in HTML)

- [ ] **Step 1: Write index.html**

```html
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CLICS — เข้าสู่ระบบ</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/main.css" />
  <style>
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-box { width: 100%; max-width: 420px; }
    .logo { text-align: center; margin-bottom: 32px; }
    .logo h1 { font-size: 28px; font-weight: 700; color: #2563eb; }
    .logo p { color: #64748b; font-size: 13px; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="logo">
      <h1>CLICS</h1>
      <p>Clinical Learning Intelligence Credit System</p>
    </div>
    <div class="card">
      <div class="form-group">
        <label for="email">อีเมล / Email</label>
        <input type="email" id="email" placeholder="doctor@hospital.th" autocomplete="email" />
      </div>
      <div class="form-group">
        <label for="password">รหัสผ่าน / Password</label>
        <input type="password" id="password" autocomplete="current-password" />
      </div>
      <div id="error" class="error-msg" style="display:none"></div>
      <button class="btn btn-primary" style="width:100%" id="loginBtn">
        เข้าสู่ระบบ / Login
      </button>
    </div>
  </div>

  <script src="/js/api.js"></script>
  <script>
    // Redirect if already logged in
    if (localStorage.getItem('clics_token')) {
      window.location.href = '/dashboard.html';
    }

    document.getElementById('loginBtn').addEventListener('click', async () => {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const errEl = document.getElementById('error');
      errEl.style.display = 'none';

      if (!email || !password) {
        errEl.textContent = 'กรุณากรอกอีเมลและรหัสผ่าน';
        errEl.style.display = 'block';
        return;
      }

      const btn = document.getElementById('loginBtn');
      btn.textContent = 'กำลังเข้าสู่ระบบ...';
      btn.disabled = true;

      const data = await api.login(email, password);
      btn.textContent = 'เข้าสู่ระบบ / Login';
      btn.disabled = false;

      if (data?.access_token) {
        localStorage.setItem('clics_token', data.access_token);
        localStorage.setItem('clics_user', JSON.stringify(data.user));
        // Role-based redirect
        if (data.user.role === 'physician') {
          window.location.href = '/dashboard.html';
        } else {
          window.location.href = 'http://localhost:3002/login?token=' + encodeURIComponent(data.access_token);
        }
      } else {
        errEl.textContent = data?.error ?? 'เข้าสู่ระบบไม่สำเร็จ';
        errEl.style.display = 'block';
      }
    });

    document.getElementById('password').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('loginBtn').click();
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Manually test login page**

Open http://localhost:3000. Verify:
- Page renders with CLICS header and bilingual labels
- Empty submit shows Thai error message
- Valid credentials → redirect to `/dashboard.html`
- Invalid credentials → shows error text from API

- [ ] **Step 3: Commit**

```bash
git add physician-ui/public/index.html
git commit -m "feat: add physician login page"
```

---

## Task 21: Physician UI — Dashboard

**Files:**
- Create: `physician-ui/public/dashboard.html`
- Create: `physician-ui/public/js/dashboard.js`

- [ ] **Step 1: Write dashboard.html**

```html
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CLICS — Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/main.css" />
</head>
<body>
  <nav>
    <span class="brand">CLICS</span>
    <div>
      <a href="/dashboard.html">หน้าหลัก</a>
      <a href="/lpdp.html">ความก้าวหน้า</a>
      <a href="#" id="logoutBtn">ออกจากระบบ</a>
    </div>
  </nav>
  <div class="container">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <div>
        <h2 id="greeting" style="font-size:20px;font-weight:700"></h2>
        <p style="color:#64748b;font-size:13px">Clinical Learning Episodes ของคุณ</p>
      </div>
      <a href="/cle-new.html" class="btn btn-primary">+ เริ่ม CLE ใหม่</a>
    </div>
    <div id="cleList">
      <p style="color:#94a3b8;text-align:center;padding:40px">กำลังโหลด...</p>
    </div>
  </div>
  <script src="/js/api.js"></script>
  <script src="/js/auth.js"></script>
  <script src="/js/dashboard.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write dashboard.js**

```javascript
// physician-ui/public/js/dashboard.js
auth.guardPage();
auth.guardRole('physician');

const user = auth.getUser();
document.getElementById('greeting').textContent =
  `สวัสดี, ${user.full_name_th || user.full_name_en}`;

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.logout();
  localStorage.clear();
  window.location.href = '/index.html';
});

const STATUS_LABELS = {
  active: 'กำลังดำเนินการ',
  ended: 'สิ้นสุดแล้ว',
  cle_pass: 'ผ่าน CLE',
  cle_fail_t1: 'ไม่ผ่าน CLE',
  cle_flag_t2: 'รอตรวจสอบ',
  evaluated: 'ประเมินแล้ว',
};

function renderPlEs(cles) {
  const container = document.getElementById('cleList');
  if (!cles.length) {
    container.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:40px">ยังไม่มี CLE — เริ่มต้นได้เลย!</p>';
    return;
  }
  container.innerHTML = cles.map(p => `
    <div class="card" style="cursor:pointer" onclick="window.location.href='/cle-chat.html?id=${p.id}'">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <p style="font-weight:600;margin-bottom:4px">CLE ${new Date(p.started_at).toLocaleDateString('th-TH')}</p>
          <p style="font-size:12px;color:#64748b">${p.turn_count ?? 0} รอบ · ${p.token_count ?? 0} tokens</p>
        </div>
        <span class="badge badge-${p.status}">${STATUS_LABELS[p.status] ?? p.status}</span>
      </div>
    </div>
  `).join('');
}

api.getPlEs().then(cles => renderPlEs(cles ?? [])).catch(() => {
  document.getElementById('cleList').innerHTML = '<p class="error-msg">โหลดข้อมูลไม่สำเร็จ</p>';
});
```

- [ ] **Step 3: Manually test dashboard**

Open http://localhost:3000/dashboard.html after login. Verify:
- Physician name shown in greeting
- Empty state shows Thai message
- CLE cards render with status badges
- "เริ่ม CLE ใหม่" button navigates to `/cle-new.html`

- [ ] **Step 4: Commit**

```bash
git add physician-ui/public/dashboard.html physician-ui/public/js/dashboard.js
git commit -m "feat: add physician dashboard"
```

---

## Task 22: Physician UI — New CLE + Chat Page

**Files:**
- Create: `physician-ui/public/cle-new.html`
- Create: `physician-ui/public/cle-chat.html`
- Create: `physician-ui/public/js/cle-chat.js`

- [ ] **Step 1: Write cle-new.html**

```html
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CLICS — เริ่ม CLE ใหม่</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/main.css" />
</head>
<body>
  <nav>
    <span class="brand">CLICS</span>
    <div><a href="/dashboard.html">← กลับ</a></div>
  </nav>
  <div class="container" style="max-width:560px">
    <h2 style="margin-bottom:24px;font-size:20px">เริ่ม CLE ใหม่ / New Clinical Learning Episode</h2>
    <div class="card">
      <div class="form-group">
        <label>สาขาวิชา / Specialty</label>
        <select id="specialty">
          <option value="">เลือกสาขา...</option>
          <option>Internal Medicine / อายุรศาสตร์</option>
          <option>Family Medicine / เวชศาสตร์ครอบครัว</option>
          <option>Surgery / ศัลยศาสตร์</option>
          <option>Pediatrics / กุมารเวชศาสตร์</option>
          <option>Emergency Medicine / เวชศาสตร์ฉุกเฉิน</option>
          <option>Obstetrics & Gynecology / สูติ-นรีเวช</option>
          <option>Other / อื่น ๆ</option>
        </select>
      </div>
      <div class="form-group">
        <label>อาการสำคัญ / Chief Complaint <span style="color:#dc2626">*</span></label>
        <textarea id="complaint" rows="3" placeholder="เช่น ผู้ป่วยมาด้วยเจ็บหน้าอก / e.g. Patient presents with chest pain"></textarea>
      </div>
      <div id="error" class="error-msg" style="display:none"></div>
      <button class="btn btn-primary" id="startBtn" style="width:100%">เริ่มการสนทนา / Start Session</button>
    </div>
  </div>
  <script src="/js/api.js"></script>
  <script src="/js/auth.js"></script>
  <script>
    auth.guardPage();
    document.getElementById('startBtn').addEventListener('click', async () => {
      const complaint = document.getElementById('complaint').value.trim();
      const specialty = document.getElementById('specialty').value;
      const errEl = document.getElementById('error');
      if (!complaint) {
        errEl.textContent = 'กรุณากรอกอาการสำคัญ';
        errEl.style.display = 'block';
        return;
      }
      errEl.style.display = 'none';
      const btn = document.getElementById('startBtn');
      btn.disabled = true; btn.textContent = 'กำลังสร้าง...';
      const cle = await api.createPle({ specialty, chief_complaint: complaint });
      if (cle?.id) {
        window.location.href = `/cle-chat.html?id=${cle.id}`;
      } else {
        errEl.textContent = cle?.error ?? 'เกิดข้อผิดพลาด';
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'เริ่มการสนทนา / Start Session';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Write cle-chat.html**

```html
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CLICS — CLE</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/main.css" />
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
  <nav>
    <span class="brand">CLICS</span>
    <div><a href="/dashboard.html">← Dashboard</a></div>
  </nav>
  <div class="container">
    <div class="session-bar">
      <div>⏱ <span id="timer">00:00</span></div>
      <div>💬 <span id="turns">0</span> รอบ</div>
      <div>📝 <span id="tokens">0</span> tokens</div>
      <div style="margin-left:auto">
        <button class="btn btn-danger" id="endBtn">จบ Session / End</button>
      </div>
    </div>
    <div class="chat-window card" style="padding:0">
      <div class="chat-messages" id="messages" style="padding:16px"></div>
      <div style="padding:12px 16px;border-top:1px solid #e5e7eb">
        <div class="chat-input-row">
          <textarea id="input" rows="2" placeholder="พิมพ์คำถามเกี่ยวกับเคส... / Type your clinical question..."></textarea>
          <button class="btn btn-primary" id="sendBtn">ส่ง</button>
        </div>
        <p style="font-size:11px;color:#94a3b8;margin-top:6px">Shift+Enter ขึ้นบรรทัดใหม่ · Enter ส่ง</p>
      </div>
    </div>
  </div>
  <script src="/js/api.js"></script>
  <script src="/js/auth.js"></script>
  <script src="/js/cle-chat.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write cle-chat.js**

```javascript
// physician-ui/public/js/cle-chat.js
auth.guardPage();

const cleId = new URLSearchParams(location.search).get('id');
if (!cleId) window.location.href = '/dashboard.html';

let turns = 0;
let tokens = 0;
let startTime = Date.now();
let timerInterval;

// Timer
function updateTimer() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  document.getElementById('timer').textContent = `${m}:${s}`;
}
timerInterval = setInterval(updateTimer, 1000);

function renderMessage(role, content, refs, socratic) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = role === 'physician' ? 'msg-physician' : 'msg-assistant';

  if (role === 'physician') {
    div.textContent = content;
  } else {
    // Remove socratic question from main content for separate rendering
    const mainContent = content.replace(/\n❓[^\n]*$/, '').trim();
    div.innerHTML = marked.parse(mainContent);

    if (refs?.length) {
      const refDiv = document.createElement('div');
      refDiv.className = 'msg-refs';
      refDiv.innerHTML = '📎 ' + refs.map(r => `<em>${r.source}</em>`).join(' · ');
      div.appendChild(refDiv);
    }

    if (socratic) {
      const sq = document.createElement('div');
      sq.className = 'msg-socratic';
      sq.textContent = '❓ ' + socratic;
      div.appendChild(sq);
    }
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// Load existing messages on resume
api.getPle(cleId).then(cle => {
  if (cle?.status !== 'active') {
    window.location.href = `/cle-result.html?id=${cleId}`;
    return;
  }
  startTime = new Date(cle.started_at).getTime();
  turns = cle.turn_count ?? 0;
  tokens = cle.token_count ?? 0;
  document.getElementById('turns').textContent = turns;
  document.getElementById('tokens').textContent = tokens;
  (cle.messages ?? []).forEach(m =>
    renderMessage(m.role, m.content, m.references, m.socratic_question)
  );
});

async function sendMessage() {
  const input = document.getElementById('input');
  const message = input.value.trim();
  if (!message) return;

  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = true;
  input.value = '';

  renderMessage('physician', message);

  // Detect language
  const language = /[฀-๿]/.test(message) ? 'th' : 'en';

  // Loading indicator
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'msg-assistant';
  loadingDiv.style.color = '#94a3b8';
  loadingDiv.textContent = 'กำลังคิด... / Thinking...';
  document.getElementById('messages').appendChild(loadingDiv);

  const res = await api.sendMessage(cleId, { message, language });
  loadingDiv.remove();

  if (res?.content) {
    renderMessage('assistant', res.content, res.references, res.socratic_question);
    turns += 1;
    tokens += res.token_count ?? 0;
    document.getElementById('turns').textContent = turns;
    document.getElementById('tokens').textContent = tokens;
  } else {
    renderMessage('assistant', '⚠️ เกิดข้อผิดพลาด กรุณาลองใหม่', [], null);
  }

  sendBtn.disabled = false;
  input.focus();
}

document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

document.getElementById('endBtn').addEventListener('click', async () => {
  if (!confirm('จบ Session นี้หรือไม่? / End this session?')) return;
  clearInterval(timerInterval);
  document.getElementById('endBtn').disabled = true;
  document.getElementById('endBtn').textContent = 'กำลังประมวลผล...';
  const result = await api.endPle(cleId);
  window.location.href = `/cle-result.html?id=${cleId}`;
});
```

- [ ] **Step 4: Manually test the chat flow**

1. Login as a physician
2. Create new CLE with a specialty and complaint
3. Send 4+ messages with clinical questions
4. Verify: AI response renders with markdown, 📎 references appear, ❓ Socratic question appears in blue italic
5. Verify session bar updates turn count and token count
6. End session → verify redirect to result page

- [ ] **Step 5: Commit**

```bash
git add physician-ui/public/cle-new.html physician-ui/public/cle-chat.html physician-ui/public/js/cle-chat.js
git commit -m "feat: add cle new and chat pages"
```

---

## Task 23: Physician UI — Result + LPDP Pages

**Files:**
- Create: `physician-ui/public/cle-result.html`
- Create: `physician-ui/public/lpdp.html`

- [ ] **Step 1: Write cle-result.html**

```html
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CLICS — ผลการประเมิน</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/main.css" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>
  <nav><span class="brand">CLICS</span><div><a href="/dashboard.html">← Dashboard</a></div></nav>
  <div class="container" style="max-width:640px">
    <div id="content"><p style="text-align:center;padding:40px;color:#94a3b8">กำลังโหลด...</p></div>
  </div>
  <script src="/js/api.js"></script>
  <script src="/js/auth.js"></script>
  <script>
    auth.guardPage();
    const cleId = new URLSearchParams(location.search).get('id');

    const DOMAIN_LABELS = [
      'Clinical Question Intelligence',
      'Reasoning Depth',
      'Contextual Integration',
      'Iterative Inquiry',
      'Critical Appraisal',
      'Reflective Synthesis',
      'AI Literacy & Prompt Skill',
    ];

    const CRITERIA_LABELS = {
      c1: 'ระยะเวลา ≥ 15 นาที', c2: 'จำนวนรอบ ≥ 4',
      c3: 'Tokens ≥ 800', c4: 'คำถามเชิงคลินิก',
      c5: 'Follow-up เชิงลึก ≥ 2', c6: 'สรุปการเรียนรู้',
    };

    async function load() {
      const cle = await api.getPle(cleId);
      const container = document.getElementById('content');

      if (!cle || cle.status === 'active') {
        container.innerHTML = '<p>กรุณาจบ session ก่อน</p>'; return;
      }

      if (cle.status === 'cle_fail_t1' || cle.status === 'cle_flag_t2') {
        const criteria = ['c1','c2','c3','c4','c5','c6'];
        container.innerHTML = `
          <div class="card">
            <h2 style="color:#dc2626;margin-bottom:16px">
              ${cle.status === 'cle_fail_t1' ? '❌ ไม่ผ่านเกณฑ์ CLE (Tier 1)' : '⏳ รอตรวจสอบ (Tier 2)'}
            </h2>
            <p style="color:#64748b;margin-bottom:16px">ผลเกณฑ์ทั้ง 6 ข้อ:</p>
            ${criteria.map(c => `
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <span>${cle[c + '_pass'] ? '✅' : '❌'}</span>
                <span>${CRITERIA_LABELS[c]}</span>
              </div>`).join('')}
            <a href="/dashboard.html" class="btn btn-ghost" style="display:inline-block;margin-top:16px">← กลับ</a>
          </div>`;
        return;
      }

      if (cle.status === 'cle_pass') {
        container.innerHTML = `
          <div class="card" style="text-align:center">
            <p style="font-size:32px;margin-bottom:8px">✅</p>
            <h2>ผ่านเกณฑ์ CLE แล้ว</h2>
            <p style="color:#64748b;margin-top:8px">กำลังประเมินผล PIS-7 อยู่...</p>
            <button class="btn btn-ghost" onclick="load()" style="margin-top:16px">🔄 รีเฟรช</button>
          </div>`;
        return;
      }

      // Evaluated
      const eval_ = await api.getEvaluation(cleId);
      if (!eval_ || eval_.status === 'cle_pass') {
        container.innerHTML = `<div class="card" style="text-align:center"><p>กำลังประเมิน... <button class="btn btn-ghost" onclick="load()">รีเฟรช</button></p></div>`;
        return;
      }

      const scores = [eval_.d1, eval_.d2, eval_.d3, eval_.d4, eval_.d5, eval_.d6, eval_.d7];
      container.innerHTML = `
        <div class="card" style="text-align:center;margin-bottom:16px">
          <p style="font-size:48px;font-weight:700;color:#2563eb">${Math.round(eval_.composite_score)}</p>
          <p style="color:#64748b">คะแนน PIS-7 / 100</p>
          <div class="badge badge-evaluated" style="margin-top:8px">✅ ได้รับ CPD Credit</div>
        </div>
        <div class="card">
          <canvas id="radarChart" height="260"></canvas>
        </div>
        <div class="card">
          <h3 style="margin-bottom:12px">ผลรายโดเมน</h3>
          ${DOMAIN_LABELS.map((label, i) => `
            <div style="margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <span style="font-size:13px">${label}</span>
                <strong>${scores[i]}/5</strong>
              </div>
              <div style="background:#f1f5f9;border-radius:4px;height:6px">
                <div style="background:#2563eb;height:6px;border-radius:4px;width:${scores[i]/5*100}%"></div>
              </div>
              <p style="font-size:12px;color:#64748b;margin-top:4px">${eval_.domain_rationale?.['d' + (i+1)] ?? ''}</p>
            </div>`).join('')}
        </div>`;

      new Chart(document.getElementById('radarChart'), {
        type: 'radar',
        data: {
          labels: DOMAIN_LABELS.map(l => l.split(' ').slice(0,2).join(' ')),
          datasets: [{ label: 'PIS-7 Score', data: scores, backgroundColor: 'rgba(37,99,235,0.15)', borderColor: '#2563eb', pointBackgroundColor: '#2563eb' }],
        },
        options: { scales: { r: { min: 0, max: 5, ticks: { stepSize: 1 } } }, plugins: { legend: { display: false } } },
      });
    }

    load();
  </script>
</body>
</html>
```

- [ ] **Step 2: Write lpdp.html**

```html
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CLICS — ความก้าวหน้า</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/main.css" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>
  <nav><span class="brand">CLICS</span><div><a href="/dashboard.html">← Dashboard</a></div></nav>
  <div class="container" style="max-width:700px">
    <h2 style="margin-bottom:20px">ความก้าวหน้าของคุณ / Your LPDP</h2>
    <div class="card"><canvas id="lpdpChart" height="220"></canvas></div>
    <p id="noData" style="display:none;color:#94a3b8;text-align:center;padding:20px">ยังไม่มีข้อมูล — กรุณาทำ CLE ให้ผ่านก่อน</p>
  </div>
  <script src="/js/api.js"></script>
  <script src="/js/auth.js"></script>
  <script>
    auth.guardPage();
    const user = auth.getUser();

    fetch(`http://localhost:3001/admin/lpdp/${user.id}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('clics_token')}` }
    })
    .then(r => r.json())
    .then(data => {
      if (!data?.length) { document.getElementById('noData').style.display = 'block'; return; }
      const labels = data.map((_, i) => `CLE ${i + 1}`);
      const scores = data.map(d => d.composite_score);
      new Chart(document.getElementById('lpdpChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{ label: 'คะแนน PIS-7', data: scores, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)', tension: 0.3, pointRadius: 5 }],
        },
        options: {
          scales: { y: { min: 0, max: 100, title: { display: true, text: 'คะแนน / 100' } } },
          plugins: { legend: { display: false } },
        },
      });
    });
  </script>
</body>
</html>
```

- [ ] **Step 3: Manually test result and LPDP pages**

1. Complete a full CLE session (≥15 min, ≥4 turns, ≥800 tokens)
2. End session → verify result page shows CLE gate outcome
3. Wait for AI evaluation (fire-and-forget) → refresh → verify PIS-7 radar chart and scores render
4. Visit `/lpdp.html` → verify line chart shows composite score progression

- [ ] **Step 4: Commit**

```bash
git add physician-ui/public/cle-result.html physician-ui/public/lpdp.html
git commit -m "feat: add cle result and lpdp pages"
```

---

## Task 24: Audit Dashboard — Scaffold + Auth

**Files:**
- Create: `audit-dashboard/package.json`
- Create: `audit-dashboard/next.config.mjs`
- Create: `audit-dashboard/app/layout.tsx`
- Create: `audit-dashboard/app/page.tsx`
- Create: `audit-dashboard/app/login/page.tsx`
- Create: `audit-dashboard/lib/api.ts`
- Create: `audit-dashboard/lib/auth.ts`

- [ ] **Step 1: Initialise Next.js project**

```bash
cd audit-dashboard && npx create-next-app@latest . --typescript --tailwind --app --no-src-dir --import-alias "@/*"
```
Accept all defaults.

- [ ] **Step 2: Install shadcn/ui and Recharts**

```bash
npx shadcn@latest init
npx shadcn@latest add button card badge slider table
npm install recharts
```

- [ ] **Step 3: Write lib/api.ts**

```typescript
// audit-dashboard/lib/api.ts
const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('clics_token');
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) {
    localStorage.clear();
    window.location.href = '/login';
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 4: Write lib/auth.ts**

```typescript
// audit-dashboard/lib/auth.ts
export interface ClicsUser {
  id: string;
  email: string;
  role: 'superadmin' | 'admin' | 'physician' | 'auditor';
  full_name_th: string;
  full_name_en: string;
}

export function getUser(): ClicsUser | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('clics_user');
  return raw ? JSON.parse(raw) : null;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('clics_token');
}
```

- [ ] **Step 5: Write app/page.tsx**

```typescript
// audit-dashboard/app/page.tsx
import { redirect } from 'next/navigation';
export default function Home() { redirect('/login'); }
```

- [ ] **Step 6: Write app/login/page.tsx**

```typescript
// audit-dashboard/app/login/page.tsx
'use client';
import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Accept token forwarded from physician UI login
  useEffect(() => {
    const token = params.get('token');
    if (token) {
      localStorage.setItem('clics_token', token);
      apiFetch<{ user: any }>('/auth/me').then(({ user }) => {
        localStorage.setItem('clics_user', JSON.stringify(user));
        redirectByRole(user.role, router);
      });
    }
  }, [params, router]);

  async function handleLogin() {
    setError(''); setLoading(true);
    const data: any = await apiFetch('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    setLoading(false);
    if (data?.access_token) {
      localStorage.setItem('clics_token', data.access_token);
      localStorage.setItem('clics_user', JSON.stringify(data.user));
      redirectByRole(data.user.role, router);
    } else {
      setError(data?.error ?? 'เข้าสู่ระบบไม่สำเร็จ');
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <div className="w-full max-w-sm space-y-4 p-8 bg-white rounded-xl shadow">
        <h1 className="text-2xl font-bold text-center text-blue-600">CLICS</h1>
        <p className="text-center text-sm text-slate-500">Audit Dashboard</p>
        <input className="w-full border rounded-lg px-3 py-2 text-sm" type="email"
          placeholder="อีเมล / Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input className="w-full border rounded-lg px-3 py-2 text-sm" type="password"
          placeholder="รหัสผ่าน / Password" value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleLogin()} />
        {error && <p className="text-red-500 text-sm">{error}</p>}
        <Button className="w-full" onClick={handleLogin} disabled={loading}>
          {loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ / Login'}
        </Button>
      </div>
    </div>
  );
}

function redirectByRole(role: string, router: any) {
  if (role === 'auditor') router.push('/auditor/queue');
  else if (role === 'admin') router.push('/admin/cles');
  else if (role === 'superadmin') router.push('/admin/icc');
  else router.push('/login');
}
```

- [ ] **Step 7: Start dev server**

```bash
cd audit-dashboard && npm run dev -- -p 3002
```
Expected: Next.js running on http://localhost:3002, login page renders.

- [ ] **Step 8: Commit**

```bash
git add audit-dashboard/
git commit -m "feat: scaffold audit dashboard with auth"
```

---

## Task 25: Audit Dashboard — Auditor Queue + Transcript + Scoring

**Files:**
- Create: `audit-dashboard/components/DomainSliders.tsx`
- Create: `audit-dashboard/components/TranscriptView.tsx`
- Create: `audit-dashboard/app/auditor/queue/page.tsx`
- Create: `audit-dashboard/app/auditor/cles/[id]/page.tsx`

- [ ] **Step 1: Write DomainSliders.tsx**

```typescript
// audit-dashboard/components/DomainSliders.tsx
'use client';
import { Slider } from '@/components/ui/slider';

const DOMAINS = [
  { key: 'd1', label: 'Clinical Question Intelligence', weight: '15%' },
  { key: 'd2', label: 'Reasoning Depth', weight: '20%' },
  { key: 'd3', label: 'Contextual Integration', weight: '15%' },
  { key: 'd4', label: 'Iterative Inquiry', weight: '15%' },
  { key: 'd5', label: 'Critical Appraisal', weight: '15%' },
  { key: 'd6', label: 'Reflective Synthesis', weight: '10%' },
  { key: 'd7', label: 'AI Literacy & Prompt Skill', weight: '10%' },
];

interface Props {
  scores: Record<string, number>;
  onChange: (key: string, value: number) => void;
  disabled?: boolean;
}

export function DomainSliders({ scores, onChange, disabled }: Props) {
  return (
    <div className="space-y-5">
      {DOMAINS.map(({ key, label, weight }) => (
        <div key={key}>
          <div className="flex justify-between mb-1">
            <span className="text-sm font-medium">{label}</span>
            <span className="text-sm text-slate-500">{weight} · <strong>{scores[key] ?? 0}/5</strong></span>
          </div>
          <Slider
            min={0} max={5} step={1}
            value={[scores[key] ?? 0]}
            onValueChange={([v]) => onChange(key, v)}
            disabled={disabled}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-slate-400 mt-1 px-0.5">
            <span>0 ไม่พบ</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5 ดีเยี่ยม</span>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Write TranscriptView.tsx**

```typescript
// audit-dashboard/components/TranscriptView.tsx
interface Message {
  role: string; content: string;
  references?: { source: string }[];
  socratic_question?: string;
}

export function TranscriptView({ messages }: { messages: Message[] }) {
  return (
    <div className="space-y-3 max-h-[60vh] overflow-y-auto p-4 bg-slate-50 rounded-lg">
      {messages.map((m, i) => (
        <div key={i} className={`rounded-xl p-3 text-sm max-w-[85%] ${
          m.role === 'physician' ? 'ml-auto bg-blue-600 text-white' : 'bg-white border'
        }`}>
          <p className="whitespace-pre-wrap">{m.content}</p>
          {m.references?.length ? (
            <p className="mt-1 text-xs opacity-70">📎 {m.references.map(r => r.source).join(' · ')}</p>
          ) : null}
          {m.socratic_question && (
            <p className="mt-1 text-xs italic text-blue-300">❓ {m.socratic_question}</p>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write auditor/queue/page.tsx**

```typescript
// audit-dashboard/app/auditor/queue/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { getUser } from '@/lib/auth';

interface CleItem { id: string; ended_at: string; turn_count: number; token_count: number; }

export default function AuditorQueue() {
  const [cles, setPlEs] = useState<CleItem[]>([]);
  const router = useRouter();

  useEffect(() => {
    const user = getUser();
    if (!user || user.role !== 'auditor') { router.push('/login'); return; }
    apiFetch<CleItem[]>('/auditor/queue').then(setPlEs);
  }, [router]);

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-6">คิวการประเมิน / Scoring Queue</h1>
      {cles.length === 0
        ? <p className="text-slate-400 text-center py-10">ยังไม่มี CLE ที่ได้รับมอบหมาย</p>
        : cles.map(p => (
          <div key={p.id} className="border rounded-xl p-4 mb-3 cursor-pointer hover:bg-slate-50"
            onClick={() => router.push(`/auditor/cles/${p.id}`)}>
            <div className="flex justify-between items-center">
              <div>
                <p className="font-semibold">CLE — {new Date(p.ended_at).toLocaleDateString('th-TH')}</p>
                <p className="text-xs text-slate-500">{p.turn_count} รอบ · {p.token_count} tokens</p>
              </div>
              <Badge variant="outline">รอประเมิน</Badge>
            </div>
          </div>
        ))
      }
    </div>
  );
}
```

- [ ] **Step 4: Write auditor/cles/[id]/page.tsx**

```typescript
// audit-dashboard/app/auditor/cles/[id]/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { DomainSliders } from '@/components/DomainSliders';
import { TranscriptView } from '@/components/TranscriptView';
import { Button } from '@/components/ui/button';

const WEIGHTS: Record<string, number> = { d1:0.15, d2:0.20, d3:0.15, d4:0.15, d5:0.15, d6:0.10, d7:0.10 };

function computeComposite(scores: Record<string, number>) {
  return Object.entries(WEIGHTS).reduce((acc, [k, w]) => acc + (scores[k] ?? 0) * w, 0) * 20;
}

export default function AuditorScorePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [scores, setScores] = useState<Record<string, number>>({ d1:0,d2:0,d3:0,d4:0,d5:0,d6:0,d7:0 });
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch<any>(`/auditor/cles/${id}`).then(d => {
      setData(d);
      if (d?.audit_score) {
        const { d1,d2,d3,d4,d5,d6,d7, notes: n } = d.audit_score;
        setScores({ d1,d2,d3,d4,d5,d6,d7 });
        setNotes(n ?? '');
        setSubmitted(true);
      }
    });
  }, [id]);

  async function submit() {
    setSubmitting(true);
    await apiFetch(`/auditor/cles/${id}/score`, {
      method: 'POST', body: JSON.stringify({ ...scores, notes }),
    });
    setSubmitted(true);
    setSubmitting(false);
    // Reload to reveal AI scores
    apiFetch<any>(`/auditor/cles/${id}`).then(setData);
  }

  if (!data) return <div className="p-8 text-slate-400">กำลังโหลด...</div>;

  const composite = computeComposite(scores);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-bold">ประเมิน CLE (Blinded)</h1>
        <Button variant="outline" onClick={() => router.push('/auditor/queue')}>← กลับ</Button>
      </div>

      <TranscriptView messages={data.cle?.messages ?? data.messages ?? []} />

      <div className="border rounded-xl p-5">
        <h2 className="font-semibold mb-4">PIS-7 Scoring</h2>
        <DomainSliders scores={scores} onChange={(k, v) => setScores(s => ({ ...s, [k]: v }))} disabled={submitted} />
        <div className="mt-4 text-right text-lg font-bold text-blue-600">
          คะแนนรวม: {composite.toFixed(1)} / 100
        </div>
        <textarea className="w-full border rounded-lg p-3 text-sm mt-3" rows={3}
          placeholder="หมายเหตุ / Notes (optional)" value={notes}
          onChange={e => setNotes(e.target.value)} disabled={submitted} />
        {!submitted
          ? <Button className="w-full mt-3" onClick={submit} disabled={submitting}>
              {submitting ? 'กำลังบันทึก...' : 'ส่งคะแนน / Submit Score'}
            </Button>
          : <p className="text-green-600 font-medium mt-3 text-center">✅ บันทึกแล้ว</p>
        }
      </div>

      {submitted && data.ai_evaluation && (
        <div className="border rounded-xl p-5 bg-blue-50">
          <h2 className="font-semibold mb-2">AI Score (เปิดเผยหลังส่งคะแนน)</h2>
          <p className="text-2xl font-bold text-blue-600">{data.ai_evaluation.composite_score?.toFixed(1)} / 100</p>
          <p className="text-sm text-slate-500 mt-1">คะแนนของคุณ: {composite.toFixed(1)}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Manually test auditor flow**

1. Login as auditor → should redirect to `/auditor/queue`
2. Verify assigned CLEs appear
3. Open a CLE → transcript renders, 7 sliders visible
4. Adjust sliders → composite score updates live
5. Submit → AI score revealed below

- [ ] **Step 6: Commit**

```bash
git add audit-dashboard/components/DomainSliders.tsx audit-dashboard/components/TranscriptView.tsx audit-dashboard/app/auditor/
git commit -m "feat: add auditor queue and scoring pages"
```

---

## Task 26: Audit Dashboard — Admin Pages

**Files:**
- Create: `audit-dashboard/app/admin/cles/page.tsx`
- Create: `audit-dashboard/app/admin/flagged/page.tsx`
- Create: `audit-dashboard/app/admin/stats/page.tsx`
- Create: `audit-dashboard/app/admin/users/page.tsx`

- [ ] **Step 1: Write admin/cles/page.tsx**

```typescript
// audit-dashboard/app/admin/cles/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const STATUS_MAP: Record<string, string> = {
  active:'กำลังดำเนินการ', ended:'สิ้นสุด', cle_pass:'ผ่าน CLE',
  cle_fail_t1:'ไม่ผ่าน T1', cle_flag_t2:'รอตรวจสอบ', evaluated:'ประเมินแล้ว',
};

export default function AdminClesPage() {
  const [cles, setPlEs] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [auditors, setAuditors] = useState<any[]>([]);

  useEffect(() => {
    apiFetch<any[]>('/admin/cles').then(setPlEs);
    apiFetch<any[]>('/admin/users').then(all =>
      setAuditors((all ?? []).filter(u => u.role === 'auditor'))
    );
  }, []);

  const filtered = filter ? cles.filter(p => p.status === filter) : cles;

  async function assign(cleId: string, auditorId: string) {
    await apiFetch(`/admin/cles/${cleId}/assign`, { method: 'POST', body: JSON.stringify({ auditor_id: auditorId }) });
    apiFetch<any[]>('/admin/cles').then(setPlEs);
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-4">จัดการ CLEs ทั้งหมด</h1>
      <div className="flex gap-2 mb-4 flex-wrap">
        {['','active','cle_pass','cle_flag_t2','evaluated'].map(s => (
          <Button key={s} variant={filter===s?'default':'outline'} size="sm" onClick={() => setFilter(s)}>
            {s ? STATUS_MAP[s] : 'ทั้งหมด'}
          </Button>
        ))}
      </div>
      <div className="border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="px-4 py-3 text-left">แพทย์</th>
            <th className="px-4 py-3 text-left">วันที่</th>
            <th className="px-4 py-3 text-left">สถานะ</th>
            <th className="px-4 py-3 text-left">Assign Auditor</th>
          </tr></thead>
          <tbody>{filtered.map(p => (
            <tr key={p.id} className="border-t hover:bg-slate-50">
              <td className="px-4 py-3">{p.professionals?.full_name_th ?? '—'}</td>
              <td className="px-4 py-3">{new Date(p.started_at).toLocaleDateString('th-TH')}</td>
              <td className="px-4 py-3"><Badge variant="outline">{STATUS_MAP[p.status]??p.status}</Badge></td>
              <td className="px-4 py-3">
                {p.status === 'evaluated' && !p.auditor_id && (
                  <select className="border rounded px-2 py-1 text-xs"
                    onChange={e => e.target.value && assign(p.id, e.target.value)}>
                    <option value="">เลือก Auditor...</option>
                    {auditors.map(a => <option key={a.id} value={a.id}>{a.full_name_th}</option>)}
                  </select>
                )}
                {p.auditor_id && <span className="text-xs text-green-600">✓ Assigned</span>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write admin/flagged/page.tsx**

```typescript
// audit-dashboard/app/admin/flagged/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';

export default function FlaggedPage() {
  const [cles, setPlEs] = useState<any[]>([]);

  const load = () => apiFetch<any[]>('/admin/cles/flagged').then(setPlEs);
  useEffect(() => { load(); }, []);

  async function approve(id: string) {
    await apiFetch(`/admin/cles/${id}/approve`, { method: 'POST' });
    load();
  }

  async function reject(id: string) {
    await apiFetch(`/admin/cles/${id}/reject`, { method: 'POST' });
    load();
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-6">QA Queue — Tier 2 Flagged Sessions</h1>
      {cles.length === 0
        ? <p className="text-slate-400 text-center py-10">ไม่มี session รอตรวจสอบ ✅</p>
        : cles.map(p => (
          <div key={p.id} className="border rounded-xl p-4 mb-3">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-semibold">{p.professionals?.full_name_th ?? 'Unknown'}</p>
                <p className="text-xs text-slate-500">{p.turn_count} รอบ · {p.token_count} tokens</p>
                <div className="flex gap-3 mt-2 text-xs">
                  {['c4','c5','c6'].map(c => (
                    <span key={c} className={p[c+'_pass'] ? 'text-green-600' : 'text-red-500'}>
                      {c.toUpperCase()}: {p[c+'_pass'] ? '✓' : '✗'}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => approve(p.id)}>✅ อนุมัติ</Button>
                <Button size="sm" variant="destructive" onClick={() => reject(p.id)}>❌ ปฏิเสธ</Button>
              </div>
            </div>
          </div>
        ))
      }
    </div>
  );
}
```

- [ ] **Step 3: Write admin/stats/page.tsx**

```typescript
// audit-dashboard/app/admin/stats/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

export default function StatsPage() {
  const [stats, setStats] = useState<any>(null);
  const [icc, setIcc] = useState<any>(null);

  useEffect(() => {
    apiFetch('/admin/stats').then(setStats);
    apiFetch('/admin/icc').then(setIcc);
  }, []);

  if (!stats) return <div className="p-8 text-slate-400">กำลังโหลด...</div>;

  const cards = [
    { label: 'CLEs ทั้งหมด', value: stats.total },
    { label: 'ผ่าน CLE', value: stats.cle_pass ?? 0 },
    { label: 'ประเมินแล้ว', value: stats.evaluated ?? 0 },
    { label: 'รอ QA', value: stats.cle_flag_t2 ?? 0 },
  ];

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-6">สถิติ Pilot Study</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {cards.map(c => (
          <div key={c.label} className="border rounded-xl p-4 text-center">
            <p className="text-3xl font-bold text-blue-600">{c.value}</p>
            <p className="text-xs text-slate-500 mt-1">{c.label}</p>
          </div>
        ))}
      </div>
      {icc?.overall && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-2">ICC ปัจจุบัน (AI vs Auditor)</h2>
          <p className="text-3xl font-bold text-blue-600">{icc.overall.icc}</p>
          <p className="text-sm text-slate-500">95% CI: [{icc.overall.lower}, {icc.overall.upper}] · n={icc.overall.n}</p>
          <p className={`text-sm font-medium mt-1 ${icc.overall.icc >= 0.75 ? 'text-green-600' : 'text-red-500'}`}>
            {icc.overall.interpretation}
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write admin/users/page.tsx**

```typescript
// audit-dashboard/app/admin/users/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const ROLE_LABELS: Record<string, string> = { superadmin:'Superadmin', admin:'Admin', physician:'แพทย์', auditor:'Auditor' };

export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email:'', password:'', role:'physician', full_name_th:'', full_name_en:'', specialty:'', license_number:'' });
  const [err, setErr] = useState('');

  const load = () => apiFetch<any[]>('/admin/users').then(setUsers);
  useEffect(() => { load(); }, []);

  async function createUser() {
    setErr('');
    const res: any = await apiFetch('/admin/users', { method:'POST', body: JSON.stringify(form) });
    if (res?.id) { setShowForm(false); load(); }
    else setErr(res?.error?.fieldErrors ? JSON.stringify(res.error.fieldErrors) : res?.error ?? 'Error');
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-bold">จัดการผู้ใช้งาน</h1>
        <Button onClick={() => setShowForm(v => !v)}>+ เพิ่มผู้ใช้</Button>
      </div>
      {showForm && (
        <div className="border rounded-xl p-5 mb-6 space-y-3">
          {['full_name_th','full_name_en','email','password','specialty','license_number'].map(f => (
            <input key={f} className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder={f} value={(form as any)[f]}
              type={f==='password'?'password':'text'}
              onChange={e => setForm(s => ({ ...s, [f]: e.target.value }))} />
          ))}
          <select className="w-full border rounded-lg px-3 py-2 text-sm"
            value={form.role} onChange={e => setForm(s => ({ ...s, role: e.target.value }))}>
            {Object.entries(ROLE_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {err && <p className="text-red-500 text-sm">{err}</p>}
          <Button className="w-full" onClick={createUser}>สร้างผู้ใช้</Button>
        </div>
      )}
      <div className="border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr>
            <th className="px-4 py-3 text-left">ชื่อ</th>
            <th className="px-4 py-3 text-left">อีเมล</th>
            <th className="px-4 py-3 text-left">Role</th>
          </tr></thead>
          <tbody>{users.map(u => (
            <tr key={u.id} className="border-t hover:bg-slate-50">
              <td className="px-4 py-3">{u.full_name_th}</td>
              <td className="px-4 py-3 text-slate-500">{u.id}</td>
              <td className="px-4 py-3"><Badge variant="outline">{ROLE_LABELS[u.role]??u.role}</Badge></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add audit-dashboard/app/admin/
git commit -m "feat: add admin cles, flagged, stats, and users pages"
```

---

## Task 27: Audit Dashboard — ICC Dashboard + LPDP Chart

**Files:**
- Create: `audit-dashboard/components/IccPanel.tsx`
- Create: `audit-dashboard/components/BlandAltmanPlot.tsx`
- Create: `audit-dashboard/components/LpdpChart.tsx`
- Create: `audit-dashboard/app/admin/icc/page.tsx`
- Create: `audit-dashboard/app/admin/lpdp/[id]/page.tsx`

- [ ] **Step 1: Write IccPanel.tsx**

```typescript
// audit-dashboard/components/IccPanel.tsx
interface Props {
  icc: number; lower: number; upper: number; n: number; interpretation: string;
}
export function IccPanel({ icc, lower, upper, n, interpretation }: Props) {
  const color = icc >= 0.75 ? 'text-green-600' : 'text-red-500';
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-3">ICC(2,1) — AI vs Expert Auditor</h2>
      <p className={`text-4xl font-bold ${color}`}>{icc.toFixed(3)}</p>
      <p className="text-sm text-slate-500 mt-1">95% CI: [{lower.toFixed(3)}, {upper.toFixed(3)}] · n = {n}</p>
      <span className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-semibold ${
        icc >= 0.95 ? 'bg-green-100 text-green-700' :
        icc >= 0.85 ? 'bg-blue-100 text-blue-700' :
        icc >= 0.75 ? 'bg-yellow-100 text-yellow-700' :
        'bg-red-100 text-red-700'
      }`}>{interpretation}</span>
      <p className="text-xs text-slate-400 mt-2">เป้าหมาย: ICC ≥ 0.75 (lower bound)</p>
    </div>
  );
}
```

- [ ] **Step 2: Write BlandAltmanPlot.tsx**

```typescript
// audit-dashboard/components/BlandAltmanPlot.tsx
'use client';
import { ScatterChart, Scatter, XAxis, YAxis, ReferenceLine, Tooltip, ResponsiveContainer } from 'recharts';

interface Props { pairs: { ai: number; human: number }[]; }

export function BlandAltmanPlot({ pairs }: Props) {
  const data = pairs.map(p => ({ mean: (p.ai + p.human) / 2, diff: p.ai - p.human }));
  const diffs = data.map(d => d.diff);
  const meanDiff = diffs.reduce((a,b) => a+b, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((a,b) => a + (b-meanDiff)**2, 0) / diffs.length);
  const loa = sd * 1.96;

  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-1">Bland-Altman Plot</h2>
      <p className="text-xs text-slate-500 mb-3">Mean diff: {meanDiff.toFixed(2)} · LoA: ±{loa.toFixed(2)}</p>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart>
          <XAxis dataKey="mean" name="Mean" label={{ value:'Mean score', position:'insideBottom', offset:-2 }} />
          <YAxis dataKey="diff" name="AI − Human" label={{ value:'AI − Human', angle:-90, position:'insideLeft' }} />
          <Tooltip />
          <ReferenceLine y={meanDiff} stroke="#3b82f6" strokeDasharray="4 4" />
          <ReferenceLine y={meanDiff + loa} stroke="#ef4444" strokeDasharray="3 3" />
          <ReferenceLine y={meanDiff - loa} stroke="#ef4444" strokeDasharray="3 3" />
          <Scatter data={data} fill="#2563eb" opacity={0.7} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: Write LpdpChart.tsx**

```typescript
// audit-dashboard/components/LpdpChart.tsx
'use client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

interface Props { data: { label: string; composite_score: number }[]; }

export function LpdpChart({ data }: Props) {
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-3">Longitudinal Professional Development Profile</h2>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <XAxis dataKey="label" />
          <YAxis domain={[0,100]} label={{ value:'Score/100', angle:-90, position:'insideLeft' }} />
          <Tooltip />
          <ReferenceLine y={75} stroke="#f59e0b" strokeDasharray="4 4" label="ผ่าน" />
          <Line type="monotone" dataKey="composite_score" stroke="#2563eb" strokeWidth={2} dot={{ r:4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Write admin/icc/page.tsx**

```typescript
// audit-dashboard/app/admin/icc/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { IccPanel } from '@/components/IccPanel';
import { BlandAltmanPlot } from '@/components/BlandAltmanPlot';

const DOMAIN_LABELS = ['CQI','RD','CI','II','CA','RS','ALPS'];

export default function IccPage() {
  const [data, setData] = useState<any>(null);
  const [pairs, setPairs] = useState<any[]>([]);

  useEffect(() => {
    apiFetch<any>('/admin/icc').then(setData);
    // Fetch raw pairs for Bland-Altman
    Promise.all([
      apiFetch<any[]>('/admin/cles?status=evaluated'),
    ]).then(async () => {
      const raw = await apiFetch<any>('/admin/icc');
      setData(raw);
    });
  }, []);

  if (!data?.overall) return <div className="p-8 text-slate-400">ยังไม่มีข้อมูล ICC — รอให้ Auditors ส่งคะแนน</div>;

  const { overall, per_domain } = data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <h1 className="text-xl font-bold">ICC Dashboard</h1>
      <IccPanel {...overall} />
      {per_domain && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-4">ICC รายโดเมน</h2>
          <div className="space-y-3">
            {Object.entries(per_domain).map(([key, d]: any, i) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-12 text-xs text-slate-500">{DOMAIN_LABELS[i]}</span>
                <div className="flex-1 bg-slate-100 rounded-full h-4 relative overflow-hidden">
                  <div className={`h-full rounded-full ${d?.icc >= 0.75 ? 'bg-green-500' : 'bg-red-400'}`}
                    style={{ width: `${Math.max(0, (d?.icc ?? 0)) * 100}%` }} />
                </div>
                <span className="text-sm font-mono w-14">{d?.icc?.toFixed(3) ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write admin/lpdp/[id]/page.tsx**

```typescript
// audit-dashboard/app/admin/lpdp/[id]/page.tsx
'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { LpdpChart } from '@/components/LpdpChart';

export default function LpdpPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any[]>([]);
  const [name, setName] = useState('');

  useEffect(() => {
    apiFetch<any[]>(`/admin/lpdp/${id}`).then(d => {
      setData((d ?? []).map((s, i) => ({ ...s, label: `CLE ${i+1}` })));
    });
    apiFetch<any[]>('/admin/users').then(users => {
      const user = users?.find(u => u.id === id);
      if (user) setName(user.full_name_th);
    });
  }, [id]);

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-6">{name || 'LPDP'} — ความก้าวหน้า</h1>
      {data.length ? <LpdpChart data={data} /> : <p className="text-slate-400">ยังไม่มีข้อมูล</p>}
    </div>
  );
}
```

- [ ] **Step 6: Manually test ICC and LPDP pages**

1. Login as superadmin → navigate to `/admin/icc`
2. Verify ICC panel shows value, CI, interpretation badge
3. Per-domain bar chart renders
4. Navigate to `/admin/lpdp/<physician-id>` → LPDP line chart renders

- [ ] **Step 7: Commit**

```bash
git add audit-dashboard/components/ audit-dashboard/app/admin/icc/ audit-dashboard/app/admin/lpdp/
git commit -m "feat: add icc dashboard, bland-altman plot, and lpdp chart"
```

---

## Running the Full System

```bash
# Terminal 1 — RIMPL (on-premise)
cd rimpl && npm run dev

# Terminal 2 — Backend API
cd backend && npm run dev

# Terminal 3 — Physician UI
cd physician-ui && npm run dev

# Terminal 4 — Audit Dashboard
cd audit-dashboard && npm run dev -- -p 3002
```

**Smoke test checklist:**
- [ ] http://localhost:3000 — physician login renders
- [ ] Login as physician → dashboard shows CLEs
- [ ] Start CLE → chat sends message → AI response with refs + ❓ appears
- [ ] End CLE → CLE gate result shown
- [ ] http://localhost:3002 — auditor/admin login works
- [ ] Auditor queue shows assigned CLE → slider scoring works → AI score revealed
- [ ] Admin stats page shows pilot counts + ICC
- [ ] Superadmin ICC dashboard renders ICC panel
