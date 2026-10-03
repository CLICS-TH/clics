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

// opts.system marks a CLIENT-generated notice (could not start, server error): not model output, so no AI chip.
// Neutral .msg-system style, role=status, sr-only "ระบบ / System:". Same contract as js/ple-chat.js.
function renderMessage(role, content, refs, socratic, opts) {
  opts = opts || {};
  const div = document.createElement('div');
  div.className = role === 'physician' ? 'msg-physician' : 'msg-assistant' + (opts.system ? ' msg-system' : '');
  if (opts.system) div.setAttribute('role', 'status');
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
  // Speaker label — same as the signed-in chat (js/ple-chat.js): sr-only for the physician, the visible
  // AI chip (also the screen-reader label) for the assistant. One fixed label, see AI_LABEL in js/ui.js.
  if (role === 'physician') {
    const who = document.createElement('span');
    who.className = 'sr-only';
    who.textContent = 'คุณ / You: ';
    div.insertBefore(who, div.firstChild);
  } else if (opts.system) {
    const who = document.createElement('span');
    who.className = 'sr-only';
    who.textContent = 'ระบบ / System: ';
    div.insertBefore(who, div.firstChild);
  } else {
    div.insertBefore(aiChip(), div.firstChild);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setRemaining(n) {
  promptsRemaining = n;
  // Visible countdown in the pill.
  remainingEl.textContent = n === 1 ? 'เหลือ 1 คำถาม / 1 left' : `เหลือ ${n} คำถาม / ${n} left`;
}

function endSession(msg) {
  ended = true;
  inputEl.disabled = true;
  sendBtn.disabled = true;
  remainingEl.textContent = 'ครบแล้ว / Done';
  if (msg) hintEl.textContent = msg;
  // A designed "you're out" moment — show what signing up unlocks (the whole point of the trial).
  const cta = document.getElementById('guestCta');
  if (cta && !cta.childElementCount) {
    cta.innerHTML = `
      <div class="card" style="margin-bottom:0">
        <p class="eyebrow">พร้อมไปต่อ? · Keep going</p>
        <h2 style="font-family:var(--font-display);font-size:25px;font-weight:600;margin-bottom:4px">สมัครเพื่อปลดล็อกการเรียนรู้เต็มรูปแบบ<span class="bi-en" style="display:block;font-size:15px;margin-top:2px">Sign up to unlock the full experience</span></h2>
        <div style="display:flex;flex-direction:column;gap:14px;margin:18px 0;">
          <div class="consent-point">${icon('folder', 22)}<div><b>บันทึกประวัติการเรียนรู้<span class="bi-en">Saved learning history</span></b><p>เก็บทุก Episode จัดเป็นโฟลเดอร์ กลับมาทบทวนได้ / Keep every episode, organised and revisitable.</p></div></div>
          <div class="consent-point">${icon('shield', 22)}<div><b>เครดิต CPD / CME<span class="bi-en">CPD / CME credit</span></b><p>คะแนน PIS-7 ที่นับเป็นหน่วยกิตการศึกษาต่อเนื่อง / PIS-7 scores that count toward continuing-education credit.</p></div></div>
          <div class="consent-point">${icon('checkCircle', 22)}<div><b>ติดตามความก้าวหน้า<span class="bi-en">Track your progress</span></b><p>ดูพัฒนาการการให้เหตุผลทางคลินิกของคุณตามเวลา / Watch your clinical reasoning improve over time.</p></div></div>
        </div>
        <a href="/" class="btn btn-primary btn-lg" style="width:100%">สมัครด้วย Google<span class="bi-en">Sign up with Google</span></a>
      </div>`;
    cta.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }
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
      ? 'ระบบทดลองใช้งานไม่ว่างขณะนี้ กรุณารีเฟรชเพื่อลองใหม่ / The trial is busy right now — please refresh to try again.'
      : 'ไม่สามารถเริ่มเซสชันผู้เยี่ยมชมได้ กรุณารีเฟรช / Could not start a guest session — please refresh to try again.', null, null, { system: true });
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
  // Announced by the log's live region, after the AI chip that labels the speaker.
  loading.appendChild(aiChip());
  loading.append('กำลังคิด... / Thinking...');
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
    renderMessage('assistant', (res.body?.error || 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong.'), null, null, { system: true });
    setRemaining(promptsRemaining); // unchanged display
    history.pop();                  // the turn failed — drop it so a retry doesn't duplicate the turn
    inputEl.value = message;        // restore the typed text so the guest can retry
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', e => {
  // Enter that confirms an IME candidate must not send the half-typed message (Safari reports keyCode 229;
  // the 229 half is unverified on Android Gboard)
  // on the keydown that ends composition).
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

start();
