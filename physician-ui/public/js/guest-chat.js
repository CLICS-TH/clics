// Guest mode chat — ephemeral. The token lives only in this page's memory (never
// localStorage), the history is held client-side and replayed each turn, and the
// server enforces a hard 2-prompt cap. Nothing is persisted anywhere.
let guestToken = null;
let promptsRemaining = 2;
let ended = false;
const history = []; // [{ role: 'physician'|'assistant', content }]

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const remainingEl = document.getElementById('remaining');
const hintEl = document.getElementById('hint');

function renderMessage(role, content, refs, socratic) {
  const div = document.createElement('div');
  div.className = role === 'physician' ? 'msg-physician' : 'msg-assistant';
  if (role === 'physician') {
    div.textContent = content;
  } else {
    const main = (content || '').replace(/\n❓[^\n]*$/, '').trim();
    // AI output is untrusted HTML once marked.parse runs it — sanitize before injecting, and
    // fail SAFE to plain text if either lib is unavailable (never inject unsanitized markup).
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      div.innerHTML = DOMPurify.sanitize(marked.parse(main));
    } else {
      div.textContent = main;
    }
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
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setRemaining(n) {
  promptsRemaining = n;
  remainingEl.textContent = n === 1 ? '1 prompt left' : `${n} prompts left`;
}

function endSession(msg) {
  ended = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;
  remainingEl.textContent = 'session ended';
  hintEl.innerHTML = (msg || 'จบโหมดผู้เยี่ยมชมแล้ว / Guest session ended.')
    + ' &nbsp;<a href="/" style="color:var(--coral);font-weight:600">สมัครด้วย Google / Sign up with Google →</a>';
}

async function start() {
  sendBtn.disabled = true;
  const res = await api.guestStart();
  if (res.ok && res.body?.token) {
    guestToken = res.body.token;
    setRemaining(res.body.max_prompts ?? 2);
    sendBtn.disabled = false;
    inputEl.focus();
  } else {
    // Don't dead-end with the send button stuck disabled and no session — tell the guest how to retry.
    const busy = res.status === 429 || res.status === 503;
    renderMessage('assistant', busy
      ? '⚠️ ระบบทดลองใช้งานไม่ว่างขณะนี้ กรุณารีเฟรชเพื่อลองใหม่ / The trial is busy right now — please refresh to try again.'
      : '⚠️ ไม่สามารถเริ่มเซสชันผู้เยี่ยมชมได้ กรุณารีเฟรช / Could not start a guest session — please refresh to try again.');
  }
}

async function send() {
  if (ended) return;
  const message = inputEl.value.trim();
  if (!message || !guestToken) return;
  sendBtn.disabled = true; inputEl.value = '';
  renderMessage('physician', message);
  history.push({ role: 'physician', content: message });

  const language = /[฀-๿]/.test(message) ? 'th' : 'en';
  const loading = document.createElement('div');
  loading.className = 'msg-assistant'; loading.style.color = 'var(--muted-soft)';
  loading.textContent = 'กำลังคิด... / Thinking...';
  messagesEl.appendChild(loading);

  // Send all but the just-pushed message as history; the message goes in `message`.
  const priorHistory = history.slice(0, -1);
  const res = await api.guestMessage(guestToken, { message, language, history: priorHistory });
  loading.remove();

  if (res.ok && res.body?.content) {
    renderMessage('assistant', res.body.content, res.body.refs, res.body.socratic_question);
    history.push({ role: 'assistant', content: res.body.content });
    setRemaining(res.body.prompts_remaining ?? 0);
    if (res.body.session_ended) {
      endSession('ครบ 2 คำถามแล้ว / You\'ve used both guest prompts.');
    } else {
      sendBtn.disabled = false; inputEl.focus();
    }
  } else if (res.status === 403) {
    endSession(res.body?.error);
  } else {
    renderMessage('assistant', '⚠️ ' + (res.body?.error || 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong.'));
    setRemaining(promptsRemaining); // unchanged display
    history.pop();                  // the turn failed — drop it so a retry doesn't duplicate the turn
    inputEl.value = message;        // restore the typed text so the guest can retry
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

start();
