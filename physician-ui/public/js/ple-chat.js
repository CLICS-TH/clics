const pleId = new URLSearchParams(location.search).get('id');
if (!pleId) window.location.href = '/dashboard';

let turns = 0, tokens = 0;

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
}, 1000);

['input','keydown','focus','pointerdown'].forEach(ev =>
  document.getElementById('input').addEventListener(ev, markActivity));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markActivity(); });

function renderMessage(role, content, refs, socratic) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = role === 'physician' ? 'msg-physician' : 'msg-assistant';
  if (role === 'physician') {
    div.textContent = content;
  } else {
    const mainContent = content.replace(/\n❓[^\n]*$/, '').trim();
    if (typeof marked !== 'undefined') div.innerHTML = marked.parse(mainContent);
    else div.textContent = mainContent;
    if (refs?.length) {
      const r = document.createElement('div');
      r.className = 'msg-refs';
      r.append('📎 ');
      refs.forEach((ref, i) => {
        if (i) r.append(' · ');
        const em = document.createElement('em');
        em.textContent = ref.source ?? ref.title ?? ref;
        r.appendChild(em);
      });
      div.appendChild(r);
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

api.getPle(pleId).then(ple => {
  if (!ple || ple.status !== 'active') { window.location.href = `/ple-result?id=${pleId}`; return; }
  const titleEl = document.getElementById('chatTitle');
  if (titleEl && (ple.title || ple.chief_complaint)) titleEl.textContent = ple.title || ple.chief_complaint;
  turns = ple.turn_count ?? 0; tokens = ple.token_count ?? 0;
  document.getElementById('turns').textContent = turns;
  document.getElementById('tokens').textContent = tokens;
  (ple.messages ?? []).forEach(m => renderMessage(m.role, m.content, m.refs, m.socratic_question));
});

async function sendMessage() {
  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn.disabled) return; // a turn is in flight — Enter must not start a concurrent one
  const input = document.getElementById('input');
  const message = input.value.trim();
  if (!message) return;
  sendBtn.disabled = true; input.value = '';
  renderMessage('physician', message);
  const language = /[฀-๿]/.test(message) ? 'th' : 'en';
  const loading = document.createElement('div');
  loading.className = 'msg-assistant'; loading.style.color = 'var(--muted-soft)';
  loading.textContent = 'กำลังคิด... / Thinking...';
  document.getElementById('messages').appendChild(loading);
  markActivity(); aiInFlight = true;          // keep the timer running while the AI answers
  const res = await api.sendMessage(pleId, { message, language });
  aiInFlight = false; markActivity();
  loading.remove();
  if (res?.content) {
    renderMessage('assistant', res.content, res.refs, res.socratic_question);
    turns += 1; tokens += res.token_count ?? 0;
    document.getElementById('turns').textContent = turns;
    document.getElementById('tokens').textContent = tokens;
  } else if (res?.code === 'budget_exceeded') {
    renderMessage('assistant', '⚠️ ถึงขีดจำกัดการใช้งาน AI แล้ว — ติดต่อผู้ดูแลระบบ คุณยังสามารถจบเซสชันนี้ได้ / AI usage limit reached — contact an administrator. You can still end this session.', [], null);
  } else {
    renderMessage('assistant', '⚠️ เกิดข้อผิดพลาด กรุณาลองใหม่', [], null);
  }
  sendBtn.disabled = false; input.focus();
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
  await api.endPle(pleId, { active_seconds: activeSeconds });
  window.location.href = `/ple-result?id=${pleId}`;
});
