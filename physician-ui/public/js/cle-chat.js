const cleId = new URLSearchParams(location.search).get('id');
if (!cleId) window.location.href = '/dashboard';

let turns = 0;
let tokenCount = 0;          // running depth signal, seeded from the server on load
let lastUserMessage = null;  // for Retry after a failed turn
let nextMsgIndex = 0;        // stable per-message index for deterministic artifact IDs

// Session minimums (mirror backend/src/services/cle-gate.js Tier-1). We surface PROGRESS toward
// these so the physician knows when a session is substantive — Socratic mode itself stays hidden.
const T_TIME = 600, T_TURNS = 4, T_TOKENS = 10000;

// Active-engagement timer: count a second only while the tab is VISIBLE and the
// physician is actually working — typed/sent within the grace window, or the AI is
// answering. Idle or backgrounded ("open frozen screen") time is not counted.
let activeSeconds = 0, lastActivity = Date.now(), aiInFlight = false;
const IDLE_GRACE_MS = 90000;
function markActivity() { lastActivity = Date.now(); }
let timerInterval = setInterval(() => {
  const idleMs = Date.now() - lastActivity;
  const engaged = document.visibilityState === 'visible' && (aiInFlight || idleMs < IDLE_GRACE_MS);
  if (engaged) activeSeconds += 1;
  document.getElementById('timer').textContent =
    String(Math.floor(activeSeconds / 60)).padStart(2,'0') + ':' + String(activeSeconds % 60).padStart(2,'0');
  updateProgress();
}, 1000);

['input','keydown','focus','pointerdown'].forEach(ev =>
  document.getElementById('input').addEventListener(ev, markActivity));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markActivity(); });

// ---- Session-progress meters (time / turns / depth) ----
function setMeter(meterId, fillId, pct, met) {
  document.getElementById(fillId).style.width = Math.min(100, pct) + '%';
  document.getElementById(meterId).classList.toggle('met', met);
}
function updateProgress() {
  const mins = Math.floor(activeSeconds / 60);
  document.getElementById('spTimeNow').textContent = mins;
  setMeter('spTime', 'spTimeFill', activeSeconds / T_TIME * 100, activeSeconds >= T_TIME);
  document.getElementById('spTurnsNow').textContent = turns;
  setMeter('spTurns', 'spTurnsFill', turns / T_TURNS * 100, turns >= T_TURNS);
  const depthMet = tokenCount >= T_TOKENS;
  setMeter('spDepth', 'spDepthFill', tokenCount / T_TOKENS * 100, depthMet);
  const ds = document.getElementById('spDepthState');
  // No raw token number — show a qualitative state only.
  if (depthMet) ds.innerHTML = icon('check', 13) + ' ครบ';
  else ds.textContent = tokenCount > 0 ? 'กำลังสร้าง' : '—';
}

// ---- Scrolling: only auto-stick to the bottom when the reader is already there ----
const msgEl = document.getElementById('messages');
const scrollBtn = document.getElementById('scrollBottomBtn');
function nearBottom() { return msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 80; }
function scrollToBottom() { msgEl.scrollTop = msgEl.scrollHeight; }
msgEl.addEventListener('scroll', () => scrollBtn.classList.toggle('show', !nearBottom()));
scrollBtn.addEventListener('click', () => { scrollToBottom(); scrollBtn.classList.remove('show'); });

function fmtClock(d) {
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

function renderMessage(role, content, refs, socratic, opts) {
  opts = opts || {};
  const stick = nearBottom();
  const div = document.createElement('div');
  div.className = role === 'physician' ? 'msg-physician' : 'msg-assistant';
  if (role === 'physician') {
    div.textContent = content;
  } else {
    // Lift any clinical artifacts out of the bubble BEFORE the ❓-strip and markdown render — they become
    // a chip here and open in the side panel. Parsing the raw content means they re-appear on reload too.
    let work = content, artifacts = [];
    if (window.CLICSArtifacts) {
      const ex = CLICSArtifacts.extract(content, opts.msgIndex);
      work = ex.cleanContent; artifacts = ex.artifacts;
    }
    const mainContent = work.replace(/\n❓[^\n]*$/, '').trim();
    // AI output is untrusted HTML once marked.parse runs it — sanitize before injecting, and
    // fail SAFE to plain text if either lib is unavailable (never inject unsanitized markup).
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      div.innerHTML = DOMPurify.sanitize(marked.parse(mainContent));
    } else {
      div.textContent = mainContent;
    }
    artifacts.forEach(a => { CLICSArtifacts.register(a); div.appendChild(CLICSArtifacts.chip(a)); });
    // Auto-open the panel for a freshly-generated artifact (live turn), like Claude does; never on reload.
    if (opts.live && artifacts.length) CLICSArtifacts.open(artifacts[artifacts.length - 1].id);
    if (refs?.length) {
      const r = document.createElement('div');
      r.className = 'msg-refs';
      const lab = document.createElement('div');
      lab.className = 'refs-label';
      lab.insertAdjacentHTML('beforeend', icon('paperclip', 13));
      lab.insertAdjacentHTML('beforeend', '<span>อ้างอิง / Sources</span>');
      r.appendChild(lab);
      const chips = document.createElement('div');
      chips.className = 'refs-chips';
      // Citations are inline (Source, Year) text from the AI — no stored URL — so each chip is a link
      // that opens a web search for that source in a new tab (lets the physician look it up).
      refs.forEach(ref => {
        const label = ref.source ?? ref.title ?? ref;
        const c = document.createElement('a');
        c.className = 'ref-chip';
        c.textContent = label;
        c.href = 'https://www.google.com/search?q=' + encodeURIComponent(String(label));
        c.target = '_blank';
        c.rel = 'noopener noreferrer';
        c.title = 'ค้นหาแหล่งอ้างอิงนี้ / Look up this source';
        chips.appendChild(c);
      });
      r.appendChild(chips);
      div.appendChild(r);
    }
    if (socratic) {
      const sq = document.createElement('div');
      sq.className = 'msg-socratic';
      sq.insertAdjacentHTML('beforeend', icon('help', 17));
      const body = document.createElement('div');
      const lbl = document.createElement('span');
      lbl.className = 'soc-label';
      lbl.textContent = 'คำถามชวนคิด / A question for you';
      const txt = document.createElement('span');
      txt.className = 'soc-text';
      txt.textContent = socratic;
      body.appendChild(lbl); body.appendChild(txt);
      sq.appendChild(body);
      div.appendChild(sq);
    }
    // Per-message actions: Copy always; Retry only on a failed turn (re-sends the same question).
    if (!opts.error) addActions(div, mainContent, false);
    else addActions(div, mainContent, true);
  }
  // Timestamp
  const t = document.createElement('div');
  t.className = 'msg-time';
  t.textContent = fmtClock(opts.at ? new Date(opts.at) : new Date());
  div.appendChild(t);

  msgEl.appendChild(div);
  if (stick) scrollToBottom(); else scrollBtn.classList.add('show');
  return div;
}

function addActions(div, rawText, isError) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  if (!isError) {
    const copy = document.createElement('button');
    copy.className = 'msg-act-btn';
    copy.type = 'button';
    copy.insertAdjacentHTML('beforeend', icon('copy', 14));
    copy.insertAdjacentHTML('beforeend', '<span>คัดลอก / Copy</span>');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(rawText); toast('คัดลอกแล้ว / Copied', 'success'); }
      catch { toast('คัดลอกไม่สำเร็จ / Copy failed', 'error'); }
    });
    bar.appendChild(copy);
  } else if (lastUserMessage) {
    const retry = document.createElement('button');
    retry.className = 'msg-act-btn';
    retry.type = 'button';
    retry.insertAdjacentHTML('beforeend', icon('refresh', 14));
    retry.insertAdjacentHTML('beforeend', '<span>ลองใหม่ / Retry</span>');
    retry.addEventListener('click', () => { div.remove(); deliver(lastUserMessage); });
    bar.appendChild(retry);
  }
  div.appendChild(bar);
}

function refreshUsage() {
  if (typeof renderUsageBar === 'function') renderUsageBar(document.getElementById('usageBar'), { mini: true });
}

api.getPle(cleId).then(cle => {
  // A transient failure returns an { error } envelope (no .status) — DON'T bounce to /cle-result
  // (which would then falsely read "Episode not found"); show a recoverable message in place.
  if (cle && cle.error) {
    msgEl.innerHTML =
      '<div class="msg-assistant">' + icon('warn', 16) + ' โหลดเซสชันไม่สำเร็จ กรุณารีเฟรชหน้านี้ / Could not load this session — please refresh.</div>';
    return;
  }
  if (!cle || cle.status !== 'active') { window.location.href = `/cle-result?id=${cleId}`; return; }
  const titleEl = document.getElementById('chatTitle');
  if (titleEl && (cle.title || cle.chief_complaint)) titleEl.textContent = cle.title || cle.chief_complaint;
  // Show which episode of the 3-CLE study sequence this is (CLICS §6.4). We show only the number,
  // never the mode (natural vs Socratic), so the experimental manipulation stays blind to the physician.
  const ebEl = document.getElementById('cleEyebrow');
  if (ebEl && cle.episode_number) ebEl.textContent = `CLE ${cle.episode_number}/3`;
  turns = cle.turn_count ?? 0;
  tokenCount = cle.token_count ?? 0;
  document.getElementById('turns').textContent = turns;
  (cle.messages ?? []).forEach((m, i) => renderMessage(m.role, m.content, m.refs, m.socratic_question, { at: m.created_at, msgIndex: i }));
  nextMsgIndex = (cle.messages ?? []).length;   // live turns continue the index for stable artifact IDs
  document.getElementById('sessionProgress').hidden = false;
  updateProgress();
  refreshUsage();
});

// Core turn delivery — shared by Send and Retry so neither re-draws the physician bubble.
async function deliver(message) {
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = true;
  const loading = document.createElement('div');
  loading.className = 'msg-assistant';
  loading.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  msgEl.appendChild(loading);
  if (nearBottom()) scrollToBottom();
  markActivity(); aiInFlight = true;          // keep the timer running while the AI answers
  const language = /[฀-๿]/.test(message) ? 'th' : 'en';
  const res = await api.sendMessage(cleId, { message, language });
  aiInFlight = false; markActivity();
  loading.remove();
  if (res?.content) {
    renderMessage('assistant', res.content, res.refs, res.socratic_question, { msgIndex: nextMsgIndex++, live: true });
    turns += 1;
    tokenCount += (res.input_tokens || 0) + (res.output_tokens || 0);
    document.getElementById('turns').textContent = turns;
    updateProgress();
    refreshUsage();
  } else if (res?.code === 'budget_exceeded') {
    renderMessage('assistant', 'ถึงขีดจำกัดการใช้งาน AI แล้ว — ติดต่อผู้ดูแลระบบ คุณยังสามารถจบเซสชันนี้ได้ / AI usage limit reached — contact an administrator. You can still end this session.', [], null);
    document.getElementById('input').value = message; // restore the typed question
    refreshUsage();
  } else {
    // The turn failed — restore the text and offer a Retry on the error bubble.
    renderMessage('assistant', 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong — please try again.', [], null, { error: true });
    document.getElementById('input').value = message;
  }
  sendBtn.disabled = false;
  document.getElementById('input').focus();
}

async function sendMessage() {
  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn.disabled) return; // a turn is in flight — Enter must not start a concurrent one
  const input = document.getElementById('input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  autoGrow();
  lastUserMessage = message;
  renderMessage('physician', message, null, null, { msgIndex: nextMsgIndex++ });
  deliver(message);
}

// Auto-growing textarea (cap ~6 rows) so longer clinical questions are fully visible.
const inputEl = document.getElementById('input');
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 168) + 'px';
}
inputEl.addEventListener('input', autoGrow);
autoGrow(); // size the rows=1 composer correctly on load

document.getElementById('sendBtn').addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// Pre-submit "declare guard": surface the Tier-1 checks we can verify on the client (duration /
// turns / depth) as met-or-not, note the AI-judged content criteria run on submit, and warn that
// submitting is irreversible. The deterministic thresholds mirror the backend Tier-1 gate.
function tierOneGuardBody() {
  const rows = [
    { met: activeSeconds >= T_TIME, label: 'ระยะเวลา ≥ 10 นาที / Duration ≥ 10 min' },
    { met: turns >= T_TURNS,        label: 'จำนวนรอบสนทนา ≥ 4 / Turns ≥ 4' },
    { met: tokenCount >= T_TOKENS,  label: 'ความลึกของบทสนทนา / Conversation depth' },
  ];
  const list = rows.map(r =>
    `<div style="display:flex;align-items:center;gap:8px;margin:5px 0">` +
      icon(r.met ? 'checkCircle' : 'xCircle', 18) +
      `<span style="${r.met ? '' : 'color:var(--muted)'}">${r.label}</span></div>`).join('');
  const metCount = rows.filter(r => r.met).length;
  return (
    `<p style="margin:0 0 8px">เกณฑ์ Tier-1 ที่ตรวจได้ตอนนี้ (${metCount}/3) / Tier-1 checks we can verify now:</p>` +
    list +
    `<p style="margin:12px 0 0;font-size:.85rem;color:var(--muted)">เกณฑ์ด้านเนื้อหา (คำถามเชิงคลินิก, follow-up เชิงลึก, สรุปการเรียนรู้) จะถูกประเมินโดย AI ตอนส่ง / Content criteria (clinical question, deep follow-ups, learning summary) are judged by AI on submit.</p>` +
    `<p style="margin:10px 0 0"><b>ส่งแล้วทำต่อไม่ได้อีก</b> <span style="color:var(--muted)">— This session can't be resumed once submitted.</span></p>`
  );
}

document.getElementById('endBtn').addEventListener('click', async () => {
  const allClientMet = activeSeconds >= T_TIME && turns >= T_TURNS && tokenCount >= T_TOKENS;
  const ok = await confirmModal({
    title: 'จบและส่งประเมิน? / End & submit?',
    body: tierOneGuardBody(),
    // When the client-checkable criteria aren't all met, make the action read as a deliberate override.
    confirmLabel: allClientMet ? 'จบและส่ง / End & submit' : 'ส่งทั้งที่ยังไม่ครบ / Submit anyway',
    cancelLabel: 'ยังไม่จบ / Keep going',
    danger: !allClientMet,
  });
  if (!ok) return;
  const endBtn = document.getElementById('endBtn');
  const origLabel = endBtn.innerHTML;
  endBtn.disabled = true;
  endBtn.textContent = 'กำลังประมวลผล... / Finishing…';
  const res = await api.endPle(cleId, { active_seconds: activeSeconds });
  // Navigate on any status that means the session is DONE from the physician's view ('ended' = tier-2
  // pending — reconcile finishes it; the result page shows "evaluating…"). On a genuine failure keep
  // the timer running and let them retry — don't strand them with the engagement time lost.
  const TERMINAL = ['cle_pass', 'cle_fail_t1', 'cle_flag_t2', 'ended', 'evaluated'];
  if (res && TERMINAL.includes(res.status)) {
    clearInterval(timerInterval);
    window.location.href = `/cle-result?id=${cleId}`;
    return;
  }
  // The response may have been LOST after the server already finished (a network drop on the way back).
  // Re-query: if the session is no longer active, it WAS finished — route to the result instead of
  // stranding the physician on a button that now 400s 'CLE not active' on every retry.
  const check = await api.getPle(cleId).catch(() => null);
  if (check && !check.error && check.status && check.status !== 'active') {
    clearInterval(timerInterval);
    window.location.href = `/cle-result?id=${cleId}`;
    return;
  }
  toast(res && res.error ? `จบไม่สำเร็จ / Could not finish: ${res.error}` : 'จบไม่สำเร็จ กรุณาลองใหม่ / Could not finish — please try again.', 'error');
  endBtn.disabled = false;
  endBtn.innerHTML = origLabel;
});
