const pleId = new URLSearchParams(location.search).get('id');
if (!pleId) window.location.href = '/dashboard';

let turns = 0;

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
    // AI output is untrusted HTML once marked.parse runs it — sanitize before injecting, and
    // fail SAFE to plain text if either lib is unavailable (never inject unsanitized markup).
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      div.innerHTML = DOMPurify.sanitize(marked.parse(mainContent));
    } else {
      div.textContent = mainContent;
    }
    if (refs?.length) {
      const r = document.createElement('div');
      r.className = 'msg-refs';
      r.insertAdjacentHTML('beforeend', icon('paperclip', 14));
      r.append(' ');
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
      sq.insertAdjacentHTML('beforeend', icon('help', 16));
      const sqt = document.createElement('span');
      sqt.textContent = ' ' + socratic;
      sq.appendChild(sqt);
      div.appendChild(sq);
    }
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

api.getPle(pleId).then(ple => {
  // A transient failure returns an { error } envelope (no .status) — DON'T bounce to /ple-result
  // (which would then falsely read "Episode not found"); show a recoverable message in place.
  if (ple && ple.error) {
    document.getElementById('messages').innerHTML =
      '<div class="msg-assistant">' + icon('warn', 16) + ' โหลดเซสชันไม่สำเร็จ กรุณารีเฟรชหน้านี้ / Could not load this session — please refresh.</div>';
    return;
  }
  if (!ple || ple.status !== 'active') { window.location.href = `/ple-result?id=${pleId}`; return; }
  const titleEl = document.getElementById('chatTitle');
  if (titleEl && (ple.title || ple.chief_complaint)) titleEl.textContent = ple.title || ple.chief_complaint;
  turns = ple.turn_count ?? 0;
  document.getElementById('turns').textContent = turns;
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
    turns += 1;
    document.getElementById('turns').textContent = turns;
  } else if (res?.code === 'budget_exceeded') {
    renderMessage('assistant', 'ถึงขีดจำกัดการใช้งาน AI แล้ว — ติดต่อผู้ดูแลระบบ คุณยังสามารถจบเซสชันนี้ได้ / AI usage limit reached — contact an administrator. You can still end this session.', [], null);
    input.value = message; // don't discard the question they typed — restore it (consistent w/ the error branch)
  } else {
    // The turn failed — RESTORE the physician's text (it was cleared on send) so they can retry
    // without retyping the whole clinical question.
    renderMessage('assistant', 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong — your message is restored below, please try again.', [], null);
    input.value = message;
  }
  sendBtn.disabled = false; input.focus();
}

document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById('endBtn').addEventListener('click', async () => {
  const ok = await confirmModal({
    title: 'จบและส่งประเมิน? / End & submit?',
    body: 'เซสชันจะถูกส่งให้ประเมินคะแนนและ<b>ทำต่อไม่ได้อีก</b><br><span style="color:var(--muted)">This session will be submitted for scoring and can\'t be resumed.</span>',
    confirmLabel: 'จบและส่ง / End & submit', cancelLabel: 'ยังไม่จบ / Keep going',
  });
  if (!ok) return;
  const endBtn = document.getElementById('endBtn');
  const origLabel = endBtn.innerHTML;
  endBtn.disabled = true;
  endBtn.textContent = 'กำลังประมวลผล... / Finishing…';
  const res = await api.endPle(pleId, { active_seconds: activeSeconds });
  // Navigate on any status that means the session is DONE from the physician's view ('ended' = tier-2
  // pending — reconcile finishes it; the result page shows "evaluating…"). On a genuine failure keep
  // the timer running and let them retry — don't strand them with the engagement time lost.
  const TERMINAL = ['cle_pass', 'cle_fail_t1', 'cle_flag_t2', 'ended', 'evaluated'];
  if (res && TERMINAL.includes(res.status)) {
    clearInterval(timerInterval);
    window.location.href = `/ple-result?id=${pleId}`;
    return;
  }
  // The response may have been LOST after the server already finished (a network drop on the way back).
  // Re-query: if the session is no longer active, it WAS finished — route to the result instead of
  // stranding the physician on a button that now 400s 'PLE not active' on every retry.
  const check = await api.getPle(pleId).catch(() => null);
  if (check && !check.error && check.status && check.status !== 'active') {
    clearInterval(timerInterval);
    window.location.href = `/ple-result?id=${pleId}`;
    return;
  }
  toast(res && res.error ? `จบไม่สำเร็จ / Could not finish: ${res.error}` : 'จบไม่สำเร็จ กรุณาลองใหม่ / Could not finish — please try again.', 'error');
  endBtn.disabled = false;
  endBtn.innerHTML = origLabel;
});
