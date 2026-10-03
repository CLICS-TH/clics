const pleId = new URLSearchParams(location.search).get('id');
if (!pleId) window.location.href = '/dashboard';

let turns = 0;
let tokenCount = 0;          // running depth signal, seeded from the server on load
let lastUserMessage = null;  // for Retry after a failed turn
let nextMsgIndex = 0;        // stable per-message index for deterministic artifact IDs
let pendingTurn = null;      // { key, text, sentAt }: the turn whose outcome is not settled; its key is reused on retry
let lastStoredId = null;     // id of the newest stored message this page knows about (text-match fallback anchor)
let lastErrorBubble = null;  // the failed-turn notice, so a re-send can take it down
let settling = false;        // reading the episode back after a lost connection (see settleLostTurn)

// Transcript-length cap (server-enforced; the local model has a finite context). Seeded from
// GET /ples/:id and refreshed from every turn's response as { used, limit, pct, warn }. `warn` is the
// server's call; an older backend that sends only { used, limit, warn_pct } gets it derived here.
// Once the cap is reached the composer locks — End stays live, because ending is the way forward.
let transcript = null, composerLocked = false;
function transcriptWarn(t) {
  if (!t || typeof t !== 'object') return false;
  if (typeof t.warn === 'boolean') return t.warn;
  const used = Number(t.used), limit = Number(t.limit), warnPct = Number(t.warn_pct != null ? t.warn_pct : 80);
  return limit > 0 && Number.isFinite(used) && (used / limit) * 100 >= warnPct;
}
function transcriptFull(t) {
  return !!t && Number(t.limit) > 0 && Number(t.used) >= Number(t.limit);
}
function renderTranscriptNotice() {
  const el = document.getElementById('transcriptNotice');
  if (!el) return;
  const show = !composerLocked && transcriptWarn(transcript);
  el.hidden = !show;
  el.innerHTML = show
    ? icon('warn', 18) + '<span>บทสนทนาใกล้ถึงขีดจำกัดความยาว — ควรสรุปและจบเซสชันเร็ว ๆ นี้ / Near the length limit — consider wrapping up soon</span>'
    : '';
}
function applyTranscript(t) {
  if (!t || typeof t !== 'object') return;
  transcript = t;
  renderTranscriptNotice();
}
// No more turns: input + Send lock; the End button is deliberately left alone.
function lockComposer() {
  composerLocked = true;
  document.getElementById('input').disabled = true;
  document.getElementById('sendBtn').disabled = true;
  renderTranscriptNotice();
}
const LIMIT_REACHED_MSG = 'บทสนทนานี้ยาวถึงขีดจำกัดแล้ว กรุณาจบเซสชันเพื่อส่งประเมิน / This conversation has reached its length limit — please end the session to submit it';

// Engagement reference points (mirror backend/src/services/ple-gate.js c1-c3). They are NOT the
// pass criteria — CREC082 §1 judges a learning episode on four qualities, not on minutes or tokens —
// so the progress meters read as "is this session substantive yet?", never as a bar to clear. T_TURNS
// doubles as the point at which the Socratic rescue may open (§4), which stays hidden from the UI.
const T_TIME = 600, T_TURNS = 4, T_TOKENS = 10000;

// Active-engagement timer: count a second only while the tab is VISIBLE and the
// physician is actually working — typed/sent within the grace window, or the AI is
// answering. Idle or backgrounded ("open frozen screen") time is not counted.
let activeSeconds = 0, lastActivity = Date.now(), aiInFlight = false;
const IDLE_GRACE_MS = 90000;
function markActivity() { lastActivity = Date.now(); }
let timerInterval = setInterval(() => {
  const idleMs = Date.now() - lastActivity;
  // Not while settling: re-reading the episode after a lost connection is not the physician working.
  const engaged = document.visibilityState === 'visible' && !settling && (aiInFlight || idleMs < IDLE_GRACE_MS);
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

// ---- Reporting an AI reply (CREC082 Risk & Incident Plan: the safety event log) ----
// MIRRORS backend/src/lib/schemas.js REPORT_REASONS / REPORT_NOTE_MAX — backend/tests/reply-report.test.js
// reads this block and fails if the two drift. The server stamps WHICH model said it; nothing here
// ever sees or sends that.
const REPORT_NOTE_MAX = 500;
const REPORT_REASONS = [
  { key: 'wrong_fact',           th: 'ข้อมูลทางการแพทย์ไม่ถูกต้อง',               en: 'Incorrect medical fact' },
  { key: 'unsafe_advice',        th: 'คำแนะนำที่อาจไม่ปลอดภัยต่อผู้ป่วย',          en: 'Advice that could be unsafe for a patient' },
  { key: 'fabricated_reference', th: 'อ้างอิงที่ไม่มีอยู่จริงหรือไม่ตรงกับเนื้อหา', en: 'A reference that does not exist or does not match' },
  { key: 'wrong_language',       th: 'ภาษาผิดหรือสื่อความหมายคลาดเคลื่อน',         en: 'Wrong or misleading language' },
  { key: 'other',                th: 'อื่น ๆ',                                    en: 'Something else' },
];

// Static strings only: every interpolated value is a constant above, never user text.
function reportErrorMessage(res) {
  if (res && res.code === 'report_rate_limited') return 'รายงานบ่อยเกินไป กรุณารอสักครู่ / Too many reports — please wait a few minutes.';
  if (res && res.code === 'report_limit_reached') return 'เซสชันนี้มีรายงานครบจำนวนสูงสุดแล้ว / This session already has the maximum number of reports.';
  return 'ส่งรายงานไม่สำเร็จ กรุณาลองใหม่ / Could not send the report — please try again.';
}

// Resolves true once the report is saved, false if the physician cancels. Not confirmModal: that one
// confirms on Enter, which would submit the form from inside the note field.
function openReportDialog(messageId) {
  return new Promise(function (resolve) {
    const opener = document.activeElement;
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'reportTitle');
    ov.innerHTML =
      '<form class="modal-card report-card" novalidate>' +
        '<h2 id="reportTitle">รายงานคำตอบของ AI<span class="bi-en">Report an AI reply</span></h2>' +
        '<p class="report-lead">ช่วยให้ทีมงานตรวจสอบคำตอบที่ผิดหรือไม่ปลอดภัย รายงานนี้ไม่มีผลต่อคะแนนของคุณ' +
          '<span class="bi-en">Help the team review a wrong or unsafe answer. A report does not affect your score.</span></p>' +
        '<fieldset class="report-reasons"><legend>เกิดปัญหาแบบไหน<span class="bi-en">What went wrong?</span></legend>' +
          REPORT_REASONS.map(function (r) {
            return '<label class="report-opt"><input type="radio" name="reportReason" value="' + r.key + '">' +
              '<span>' + r.th + '<span class="bi-en">' + r.en + '</span></span></label>';
          }).join('') +
        '</fieldset>' +
        '<div class="report-note">' +
          '<label for="reportNote">รายละเอียดเพิ่มเติม (ไม่บังคับ)<span class="bi-en">More detail (optional)</span></label>' +
          '<textarea id="reportNote" rows="3" maxlength="' + REPORT_NOTE_MAX + '" aria-describedby="reportNoteHint"></textarea>' +
          '<p class="report-hint" id="reportNoteHint">ห้ามใส่ชื่อหรือข้อมูลที่ระบุตัวผู้ป่วย ข้อความนี้เห็นได้เฉพาะผู้ดูแลระบบของโครงการ และไม่ถูกส่งให้ AI' +
            '<span class="bi-en">Do not include patient names or identifiers. Visible only to project administrators; never sent to an AI.</span></p>' +
        '</div>' +
        '<p class="error-msg report-error" id="reportError" role="alert" hidden></p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-ghost" data-act="cancel">ยกเลิก / Cancel</button>' +
          '<button type="submit" class="btn btn-primary" data-act="send">ส่งรายงาน / Send report</button>' +
        '</div>' +
      '</form>';

    const form = ov.querySelector('form');
    const err = ov.querySelector('#reportError');
    const sendBtn = ov.querySelector('[data-act="send"]');
    const note = ov.querySelector('#reportNote');
    let busy = false;

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      if (opener && opener.focus) { try { opener.focus(); } catch (e) {} }
      resolve(result);
    }
    function showError(msg) { err.textContent = msg; err.hidden = false; }
    // The dialog's Tab stops in DOM order. A radio group is ONE stop for the browser (the checked radio,
    // or the first when none is checked), so it is one here too — listing every radio put "first" on a
    // radio the browser never Tabs to, and Shift+Tab from the checked one walked out of the modal.
    function tabStops() {
      const radios = Array.prototype.slice.call(ov.querySelectorAll('input[type="radio"]'));
      const radioStop = radios.filter(function (r) { return r.checked; })[0] || radios[0];
      return Array.prototype.slice.call(ov.querySelectorAll('input, textarea, button')).filter(function (el) {
        return !el.disabled && (el.type !== 'radio' || el === radioStop);
      });
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); if (!busy) close(false); return; }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the dialog: the page behind it is inert to a modal.
      const stops = tabStops();
      if (!stops.length) return;
      const active = document.activeElement;
      const here = (active && active.type === 'radio') ? stops.filter(function (s) { return s.type === 'radio'; })[0] : active;
      const i = stops.indexOf(here);
      if (i === -1) { e.preventDefault(); stops[e.shiftKey ? stops.length - 1 : 0].focus(); }   // focus had left the dialog
      else if (e.shiftKey && i === 0) { e.preventDefault(); stops[stops.length - 1].focus(); }
      else if (!e.shiftKey && i === stops.length - 1) { e.preventDefault(); stops[0].focus(); }
    }
    // Choosing a reason answers the "please choose" error; do not leave it standing.
    form.addEventListener('change', function () { err.hidden = true; });
    ov.querySelector('[data-act="cancel"]').addEventListener('click', function () { if (!busy) close(false); });
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (busy) return;
      const chosen = form.querySelector('input[name="reportReason"]:checked');
      if (!chosen) {
        showError('กรุณาเลือกประเภทของปัญหา / Please choose what went wrong.');
        form.querySelector('input[name="reportReason"]').focus();
        return;
      }
      busy = true; err.hidden = true;
      sendBtn.disabled = true;
      sendBtn.textContent = 'กำลังส่ง… / Sending…';
      const body = { reason: chosen.value };
      const text = note.value.trim();
      if (text) body.note = text.slice(0, REPORT_NOTE_MAX);
      const res = await api.reportReply(pleId, messageId, body);
      busy = false;
      if (res && res.ok === true) { close(true); return; }
      sendBtn.disabled = false;
      sendBtn.textContent = 'ส่งรายงาน / Send report';
      showError(reportErrorMessage(res));
    });

    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    form.querySelector('input[name="reportReason"]').focus();
  });
}

function addReportButton(bar, messageId) {
  const btn = document.createElement('button');
  btn.className = 'msg-act-btn msg-report-btn';
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-label', 'รายงานคำตอบนี้ว่าไม่ถูกต้องหรือไม่ปลอดภัย / Report this reply as wrong or unsafe');
  btn.insertAdjacentHTML('beforeend', icon('flag', 14));
  btn.insertAdjacentHTML('beforeend', '<span>รายงาน / Report</span>');
  btn.addEventListener('click', async () => {
    // aria-disabled, not disabled: a disabled button drops focus to <body> the moment the dialog
    // hands it back, which strands a keyboard user at the top of the page.
    if (btn.getAttribute('aria-disabled') === 'true') {
      toast('คุณรายงานคำตอบนี้แล้ว / You already reported this reply', '');
      return;
    }
    const sent = await openReportDialog(messageId);
    if (!sent) return;
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-label', 'รายงานคำตอบนี้แล้ว / This reply was reported');
    btn.querySelector('span').textContent = 'รายงานแล้ว / Reported';
    toast('ส่งรายงานแล้ว ขอบคุณ ทีมงานจะตรวจสอบ / Report sent — thank you, the team will review it', 'success');
  });
  bar.appendChild(btn);
}

function fmtClock(d) {
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

// opts.system marks a CLIENT-generated notice (limit reached, AI busy, error): it is not model output, so it
// never wears the AI chip. It gets a neutral style (.msg-system) and an sr-only "ระบบ / System:"; a live one is
// announced once through #chatLive (no role=status on the bubble, which would announce it twice).
function renderMessage(role, content, refs, socratic, opts) {
  opts = opts || {};
  const stick = nearBottom();
  const div = document.createElement('div');
  div.className = role === 'physician' ? 'msg-physician' : 'msg-assistant' + (opts.system ? ' msg-system' : '');
  let spoken = '';   // what #chatLive says for a live reply / notice: the content only, never buttons or the clock
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
    // AI output is untrusted HTML once marked.parse runs it. markdownFragment (js/ui.js) sanitises it and
    // hardens it (no remote media, level-3+ headings, focusable table/code scrollers); it returns null when
    // the libs did not load, and then we fail SAFE to plain text, never to unsanitised markup.
    const mdFrag = markdownFragment(mainContent);
    if (mdFrag) div.appendChild(mdFrag); else div.textContent = mainContent;
    spoken = plainTextOf(div);
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
      spoken += ' ' + socratic;
      body.appendChild(lbl); body.appendChild(txt);
      sq.appendChild(body);
      div.appendChild(sq);
    }
    // Per-message actions: Copy always; Retry only on a failed turn (re-sends the same question).
    if (!opts.error) addActions(div, mainContent, false, opts.messageId);
    else addActions(div, mainContent, true);
  }
  // Speaker label. Physician: sr-only "คุณ / You:" (the coral bubble on the right is the visible cue).
  // Assistant: the visible AI chip, which is also what a screen reader hears — no second sr-only "AI".
  // One fixed label for every session, arm and provider (see AI_LABEL in js/ui.js).
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
  // Timestamp
  const t = document.createElement('div');
  t.className = 'msg-time';
  // Decorative: an AX-tree dump showed the clock read inside every bubble. Still visible; not part of the reply.
  t.setAttribute('aria-hidden', 'true');
  // Announce a NEW reply or notice (never the history draw): speaker label + plain text, nothing else.
  if (role !== 'physician' && (opts.live || opts.announce)) {
    announceChat(opts.system ? SYSTEM_SPEAKER : aiSpeakerLabel(), spoken);
  }
  t.textContent = fmtClock(opts.at ? new Date(opts.at) : new Date());
  div.appendChild(t);

  // The newest assistant bubble keeps its action row (Copy / Report / Retry) visible; older ones show it on
  // hover or focus. A system notice only takes the mark when it carries an action (the Retry on an error).
  if (role !== 'physician' && (!opts.system || opts.error)) {
    msgEl.querySelectorAll('.msg-assistant.is-latest').forEach(b => b.classList.remove('is-latest'));
    div.classList.add('is-latest');
  }
  msgEl.appendChild(div);
  if (stick) scrollToBottom(); else scrollBtn.classList.add('show');
  return div;
}

function addActions(div, rawText, isError, messageId) {
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
    // Only a stored reply can be reported — a system notice or an error bubble has no message row.
    if (messageId) addReportButton(bar, messageId);
  } else if (lastUserMessage) {
    const retry = document.createElement('button');
    retry.className = 'msg-act-btn';
    retry.type = 'button';
    retry.insertAdjacentHTML('beforeend', icon('refresh', 14));
    retry.insertAdjacentHTML('beforeend', '<span>ลองใหม่ / Retry</span>');
    div.classList.add('has-retry');      // sendMessage() removes this bubble before any new turn starts
    retry.addEventListener('click', () => {
      // Never a second concurrent turn, and never past the transcript cap.
      if (aiInFlight || composerLocked || document.getElementById('sendBtn').disabled) return;
      div.remove();                       // removes the focused button: put focus somewhere real first
      // The failed text was put back in the box; sending it again must not leave a stale copy behind.
      if (inputEl.value.trim() === lastUserMessage) { inputEl.value = ''; autoGrow(); }
      inputEl.focus();
      deliver(lastUserMessage);
    });
    bar.appendChild(retry);
  }
  div.appendChild(bar);
}

function refreshUsage() {
  if (typeof renderUsageBar === 'function') renderUsageBar(document.getElementById('usageBar'), { mini: true });
}

// History draw: renderMessage is called without live/announce, so nothing here reaches #chatLive.
api.getPle(pleId).then(ple => {
  // A transient failure returns an { error } envelope (no .status) — DON'T bounce to /ple-result
  // (which would then falsely read "Episode not found"); show a recoverable message in place.
  if (ple && ple.error) {
    msgEl.innerHTML =
      '<div class="msg-assistant" role="alert">' + icon('warn', 16) + ' โหลดเซสชันไม่สำเร็จ กรุณารีเฟรชหน้านี้ / Could not load this session — please refresh.</div>';
    return;
  }
  if (!ple || ple.status !== 'active') { window.location.href = `/ple-result?id=${pleId}`; return; }
  const titleEl = document.getElementById('chatTitle');
  if (titleEl && (ple.title || ple.chief_complaint)) titleEl.textContent = ple.title || ple.chief_complaint;
  // Show which episode of the 3-PLE study sequence this is (CLICS §6.4). We show only the number,
  // never the mode (natural vs Socratic), so the experimental manipulation stays blind to the physician.
  const ebEl = document.getElementById('pleEyebrow');
  if (ebEl && ple.episode_number) ebEl.textContent = `PLE ${ple.episode_number}/3`;
  turns = ple.turn_count ?? 0;
  tokenCount = ple.token_count ?? 0;
  document.getElementById('turns').textContent = turns;
  (ple.messages ?? []).forEach((m, i) => renderMessage(m.role, m.content, m.refs, m.socratic_question, { at: m.created_at, msgIndex: i, messageId: m.id }));
  nextMsgIndex = (ple.messages ?? []).length;   // live turns continue the index for stable artifact IDs
  lastStoredId = (ple.messages ?? []).length ? ple.messages[ple.messages.length - 1].id : null;
  document.getElementById('sessionProgress').hidden = false;
  updateProgress();
  refreshUsage();
  applyTranscript(ple.transcript);
  // Reloaded a session that already sits at the cap: the next turn would 403 anyway — say so now.
  if (transcriptFull(transcript)) { renderMessage('assistant', LIMIT_REACHED_MSG, [], null, { system: true }); lockComposer(); }
  else resumePendingTurn(ple.messages ?? []);   // a turn this tab sent before a reload, still unsettled
}).catch(e => { console.error(e); });   // a throw while drawing history must not become an unhandled rejection

// The turn never happened: take back the physician bubble sendMessage() drew, so re-sending the
// restored text does not show the question twice. (Retry on an error bubble re-delivers without
// redrawing it, which is why that path needs no retraction.)
function retractPhysicianBubble() {
  const bubbles = msgEl.querySelectorAll('.msg-physician');
  const last = bubbles[bubbles.length - 1];
  if (!last) return;
  last.remove();
  nextMsgIndex = Math.max(0, nextMsgIndex - 1);
}

// Core turn delivery — shared by Send and Retry so neither re-draws the physician bubble.
// The failed turn's text goes back in the box without clobbering anything the physician has typed since:
// empty box -> the message; same text -> leave it; a different draft -> message first, draft kept below it.
function restoreDraft(message) {
  const cur = inputEl.value.trim();
  if (!cur) inputEl.value = message;
  else if (cur !== message) inputEl.value = message + '\n\n' + inputEl.value;
  autoGrow();
}

// Whatever happens inside a turn (including a throw while drawing the reply), the box and Send come back.
async function deliver(message) {
  return withTurnLock(() => deliverTurn(message));
}

// A turn (or the settle that finishes one) owns the composer AND End: ending mid-turn would score the
// transcript without the turn being answered (the server also refuses it: 409 turn_in_flight).
async function withTurnLock(fn) {
  const endBtn = document.getElementById('endBtn');
  endBtn.disabled = true;
  try { await fn(); }
  finally {
    aiInFlight = false; settling = false;
    inputEl.readOnly = false; inputEl.removeAttribute('aria-busy');
    endBtn.disabled = false;
    if (!composerLocked) document.getElementById('sendBtn').disabled = false;
  }
}

// ---- Lost-connection settle (client_turn_id) ----
// The backend stores a chat turn only AFTER the AI answers (up to ~100 s), so a dropped connection or a
// client timeout does not mean the turn failed: it is very often stored, and a blind Retry used to put
// the physician's message into the scored transcript twice. So each typed turn carries a client_turn_id
// (the backend will not store one turn twice), kept in sessionStorage so a reload keeps it too; and
// before Retry is offered the page reads the episode back and shows the stored turn if it is there.
//
// COPY PENDING: the Thai/English wording below is a draft (design-map-delta §4 a/b), not approved. It
// lives in this one constant so the final wording is a one-place change. No model or provider is named.
const SETTLE_COPY = {
  checking: 'การเชื่อมต่อหลุดระหว่างรอคำตอบ กำลังตรวจว่าข้อความของคุณถูกบันทึกหรือไม่ / Connection lost while waiting. Checking whether your message was saved...',
  arrived: 'คำตอบมาถึงแล้ว (การเชื่อมต่อหลุดไปชั่วครู่) / The reply arrived (the connection dropped for a moment).',
  notReceived: 'ข้อความนี้ยังไม่ได้ส่ง ข้อความยังอยู่ในช่องพิมพ์ กดส่งอีกครั้งได้ / This message was not sent. It is still in the box; you can send it again.',
  cannotConfirm: 'ยังยืนยันไม่ได้ว่าส่งข้อความสำเร็จหรือไม่ กด "ลองใหม่" เพื่อส่งอีกครั้ง หากส่งไปแล้ว จะได้คำตอบเดิมโดยไม่บันทึกซ้ำ / Could not confirm whether it was sent. Press Retry: if it already arrived, you get that reply and nothing is saved twice.',
  endInFlight: 'ข้อความล่าสุดยังรอคำตอบอยู่ กรุณารอคำตอบก่อนจบเซสชัน / A message is still being answered. Wait for the reply, then end the session.',
};
const SETTLE_POLL_MS = 3000;
// The backend's own ceiling for one turn is ~100 s (RIMPL_CHAT_TIMEOUT_MS) plus its DB writes, and it
// treats a claim as abandoned 120 s after it was taken: past this, a turn that is not stored is not coming.
const SETTLE_SERVER_CEILING_MS = 125000;
// A request that already ran past that (the 130 s client timeout, or a reload long after) still gets a
// couple of reads.
const SETTLE_MIN_MS = 6000;
const PENDING_STORE_KEY = 'clics_turn_' + pleId;

function newTurnId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;      // RFC 4122 v4
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  } catch { return null; } // no key: the request is sent unkeyed, exactly as before
}
// sessionStorage, not localStorage: the key belongs to this tab's attempt at this turn. Every access is
// guarded (private mode, blocked storage); without it the page still works, it just forgets on reload.
function setPendingTurn(t) {
  pendingTurn = t;
  try {
    if (t) sessionStorage.setItem(PENDING_STORE_KEY, JSON.stringify(t));
    else sessionStorage.removeItem(PENDING_STORE_KEY);
  } catch {}
}
function loadPendingTurn() {
  try {
    const t = JSON.parse(sessionStorage.getItem(PENDING_STORE_KEY) || 'null');
    return t && typeof t.key === 'string' && typeof t.text === 'string' ? t : null;
  } catch { return null; }
}
// One key per typed turn, REUSED while the same text is still unsettled (Retry, or Send on the restored text).
function turnKeyFor(message) {
  if (pendingTurn && pendingTurn.text === message) return pendingTurn.key;
  const key = newTurnId();
  setPendingTurn(key ? { key, text: message, sentAt: Date.now() } : null);
  return key;
}
// "No answer came back" (the server may still have acted), as opposed to a definite refusal.
function outcomeUnknown(res) {
  return !!res && !res.content && (res.code === 'network_error' || res.code === 'bad_response' || res.code === 'turn_pending');
}

// The stored turn for this key. GET /ples/:id carries client_turn_id on physician rows once the backend
// has the column; before that (no row has the field) fall back to the text, looking only at what is newer
// than the last message this page knew about, or at everything when resuming after a reload.
function findStoredTurn(msgs, text, key, opts) {
  opts = opts || {};
  const keyed = !!key && msgs.some(x => x.role === 'physician' && 'client_turn_id' in x);
  let from = 0;
  if (!keyed && !opts.fromStart && lastStoredId) {
    const i = msgs.findIndex(x => x.id === lastStoredId);
    if (i >= 0) from = i + 1;
  }
  for (let i = from; i < msgs.length; i++) {
    const x = msgs[i];
    if (x.role !== 'physician') continue;
    if (keyed ? x.client_turn_id === key : x.content === text) {
      const next = msgs[i + 1];
      return { physician: x, assistant: next && next.role === 'assistant' ? next : null };
    }
  }
  return { physician: null, assistant: null };
}

// Poll the episode until the turn's reply shows up, or the backend could not still be working on it.
// Resolves { state: 'found', ple, assistant } | { state: 'absent' } (read it: not there)
//        | { state: 'unknown' } (never read it, or the question is stored with no reply yet).
async function settleLostTurn(message, key, sentAt) {
  settling = true;
  // A system notice (not model output), announced once through #chatLive like every other notice.
  const note = renderMessage('assistant', SETTLE_COPY.checking, [], null, { system: true, announce: true });
  const deadline = Math.max(sentAt + SETTLE_SERVER_CEILING_MS, Date.now() + SETTLE_MIN_MS);
  let read = false, sawPhysician = false;
  try {
    for (;;) {
      const ple = await api.getPle(pleId);
      if (ple && !ple.error && Array.isArray(ple.messages)) {
        read = true;
        const hit = findStoredTurn(ple.messages, message, key);
        if (hit.assistant) return { state: 'found', ple, assistant: hit.assistant };
        sawPhysician = !!hit.physician;
      }
      if (Date.now() + SETTLE_POLL_MS > deadline) break;
      await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
    }
  } finally {
    note.remove();
    settling = false;
  }
  return { state: read && !sawPhysician ? 'absent' : 'unknown' };
}

// Settle, then show the outcome: the stored reply, or a failure notice whose Retry reuses the key (so a
// turn that lands late is answered from the record instead of being stored twice).
async function settleAndRender(message, key, sentAt) {
  const settled = await settleLostTurn(message, key, sentAt);
  aiInFlight = false; markActivity();
  if (settled.state === 'found') {
    const a = settled.assistant;
    setPendingTurn(null); lastStoredId = a.id;
    renderMessage('assistant', a.content, a.refs, a.socratic_question, { msgIndex: nextMsgIndex++, live: true, messageId: a.id, at: a.created_at });
    // +1 rather than the server's turn_count: the counters are written just after the reply row, so a
    // read that found the reply can still carry the old count.
    turns += 1;
    tokenCount += a.token_count || 0;
    document.getElementById('turns').textContent = turns;
    updateProgress();
    refreshUsage();
    applyTranscript(settled.ple.transcript);
    toast(SETTLE_COPY.arrived, 'success');
  } else {
    renderTurnFailure(message, settled.state === 'absent' ? SETTLE_COPY.notReceived : SETTLE_COPY.cannotConfirm);
  }
}

// Failed turn: a system notice with Retry (it holds the failed text) and the text back in the box,
// without clobbering a draft (restoreDraft).
function renderTurnFailure(message, text) {
  lastErrorBubble = renderMessage('assistant', text, [], null, { error: true, system: true, announce: true });
  restoreDraft(message);
}

// After a reload: the turn this tab sent may have been stored while the page was gone. If it is in the
// history just drawn, it is settled. If not, put the question back on screen and settle it as if the
// connection had just dropped; Retry, if it comes to that, reuses the SAME key.
function resumePendingTurn(msgs) {
  const saved = loadPendingTurn();
  if (!saved) return;
  const hit = findStoredTurn(msgs, saved.text, saved.key, { fromStart: true });
  if (hit.assistant) { setPendingTurn(null); return; }   // stored, and already drawn with the history
  pendingTurn = saved;
  lastUserMessage = saved.text;
  if (!hit.physician) renderMessage('physician', saved.text, null, null, { msgIndex: nextMsgIndex++ });
  withTurnLock(async () => {
    document.getElementById('sendBtn').disabled = true;
    inputEl.readOnly = true; inputEl.setAttribute('aria-busy', 'true');
    markActivity(); aiInFlight = true;
    await settleAndRender(saved.text, saved.key, Number(saved.sentAt) || 0);
  });
}

async function deliverTurn(message) {
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = true;
  if (lastErrorBubble) { lastErrorBubble.remove(); lastErrorBubble = null; } // a re-send replaces the old failure notice
  const turnKey = turnKeyFor(message);
  const sentAt = Date.now();
  if (pendingTurn) setPendingTurn({ ...pendingTurn, sentAt });   // the settle window runs from THIS attempt
  // Lock the box for the length of the turn. readOnly (not disabled) so it keeps focus and a screen reader
  // keeps its place; Send is disabled and aria-busy says why. Nothing can be typed over the failed text.
  inputEl.readOnly = true; inputEl.setAttribute('aria-busy', 'true');
  const loading = document.createElement('div');
  loading.className = 'msg-assistant';
  // The dots alone are silent (and, under reduced motion, indistinguishable from an empty bubble):
  // one fixed sr-only line announces the wait. Same string for every session.
  loading.appendChild(aiChip());
  loading.insertAdjacentHTML('beforeend', '<span class="sr-only">กำลังคิด… / is thinking…</span><div class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></div>');
  msgEl.appendChild(loading);
  announceChat(aiSpeakerLabel(), 'กำลังคิด… / is thinking…');
  if (nearBottom()) scrollToBottom();
  // After a while the dots alone read as a hang: add one visible line (copy + delay in js/ui.js).
  const disarmSlow = armSlowNote(loading, () => { if (nearBottom()) scrollToBottom(); });
  markActivity(); aiInFlight = true;          // keep the timer running while the AI answers
  const language = /[฀-๿]/.test(message) ? 'th' : 'en';
  const res = await api.sendMessage(pleId, turnKey ? { message, language, client_turn_id: turnKey } : { message, language });
  disarmSlow();
  // aiInFlight keeps covering the settle below when the outcome is unknown; every other outcome is final.
  if (!outcomeUnknown(res)) { aiInFlight = false; markActivity(); }
  loading.remove();
  if (res?.content) {
    setPendingTurn(null); if (res.message_id) lastStoredId = res.message_id;
    renderMessage('assistant', res.content, res.refs, res.socratic_question, { msgIndex: nextMsgIndex++, live: true, messageId: res.message_id });
    turns += 1;
    tokenCount += (res.input_tokens || 0) + (res.output_tokens || 0);
    document.getElementById('turns').textContent = turns;
    updateProgress();
    refreshUsage();
    applyTranscript(res.transcript);
  } else if (res?.code === 'budget_exceeded') {
    setPendingTurn(null); // refused before anything was stored
    // reason 'tokens' is the token-denominated cap (local AI); 'cost' the $ cap. Same outcome here.
    const unit = res.reason === 'tokens' ? ' (โทเค็น / tokens)' : '';
    retractPhysicianBubble(); // refused before it was saved — a bubble would claim it was said
    renderMessage('assistant', 'ถึงขีดจำกัดการใช้งาน AI แล้ว — ติดต่อผู้ดูแลระบบ คุณยังสามารถจบเซสชันนี้ได้ / AI usage limit reached — contact an administrator. You can still end this session.' + unit, [], null, { system: true, announce: true });
    restoreDraft(message); // restore the typed question
    refreshUsage();
  } else if (res?.code === 'transcript_limit_reached') {
    setPendingTurn(null);
    // The transcript cap: nothing more can be sent to this session. End is the only move left.
    if (res.used != null && res.limit != null) transcript = { used: res.used, limit: res.limit, warn: true };
    retractPhysicianBubble(); // refused before it was saved — a bubble would claim it was said
    renderMessage('assistant', LIMIT_REACHED_MSG, [], null, { system: true, announce: true });
    lockComposer();
  } else if (res?.code === 'ai_busy') {
    setPendingTurn(null);
    // Local AI at capacity (503) — transient. Keep the question so one tap re-sends it after the wait.
    const wait = Number(res.retry_after_s) > 0 ? Math.ceil(Number(res.retry_after_s)) : 30;
    retractPhysicianBubble();
    renderMessage('assistant', `ระบบ AI กำลังทำงานหนัก — ลองอีกครั้งใน ${wait} วินาที / AI is busy — try again in ${wait} s`, [], null, { system: true, announce: true });
    restoreDraft(message); // restore the typed question
  } else if (outcomeUnknown(res)) {
    // No answer came back, so we do not know whether the turn was stored. Look before offering Retry.
    // (turn_pending = the backend says another request is still working on it: the clock restarts now.)
    await settleAndRender(message, turnKey, res.code === 'turn_pending' ? Date.now() : sentAt);
  } else {
    // A definite failure. The key is kept for Retry, except where the server says it cannot be reused:
    // turn_id_reused (a client bug) and turn_incomplete (that question is stored without a reply).
    if (res?.code === 'turn_id_reused' || res?.code === 'turn_incomplete') setPendingTurn(null);
    // The turn failed — restore the text and offer a Retry on the error bubble.
    renderTurnFailure(message, 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong — please try again.');
  }
  inputEl.readOnly = false; inputEl.removeAttribute('aria-busy');
  if (composerLocked) return; // stays locked — never re-enable Send past the cap
  sendBtn.disabled = false;
  inputEl.focus();
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
  // A new turn supersedes any earlier failed one: drop its notice + Retry, so a stale Retry can never re-send a
  // turn after this one (or a later one) has gone through.
  msgEl.querySelectorAll('.msg-assistant.has-retry').forEach(b => b.remove());
  // Sending the restored text of an unsettled turn: its bubble is still on screen, so don't draw it twice.
  if (!(pendingTurn && pendingTurn.text === message)) {
    renderMessage('physician', message, null, null, { msgIndex: nextMsgIndex++ });
  }
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
  // Enter that confirms an IME candidate (Thai/Japanese/Chinese/Korean) must not send the half-typed
  // message. isComposing is false on the keydown that ENDS composition in some Safari versions, which
  // reports keyCode 229 instead. (The 229 half is unverified on Android Gboard.)
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// Pre-submit guard. It used to present duration / turns / depth as the Tier-1 criteria, with a red
// cross against each unmet one and a danger-styled "Submit anyway" button. Those measures no longer
// decide anything (CREC082 §1 defines a learning episode by four qualities, not by minutes), so
// framing them that way told a physician their good, concise session was about to fail — and pushed
// them into padding it, which is precisely the behaviour the protocol's definition exists to avoid.
//
// Now: say what actually decides, show engagement as context, and keep the one warning that is real.
function tierOneGuardBody() {
  const rows = [
    { met: activeSeconds >= T_TIME, label: 'ระยะเวลา ≥ 10 นาที / Duration ≥ 10 min' },
    { met: turns >= T_TURNS,        label: 'จำนวนรอบสนทนา ≥ 4 / Turns ≥ 4' },
    { met: tokenCount >= T_TOKENS,  label: 'ความลึกของบทสนทนา / Conversation depth' },
  ];
  const list = rows.map(r =>
    `<div style="display:flex;align-items:center;gap:8px;margin:5px 0;color:var(--muted)">` +
      icon(r.met ? 'checkCircle' : 'x', 16) +
      `<span>${r.label}</span></div>`).join('');
  return (
    `<p style="margin:0 0 8px">การประเมินจะดูว่าบทสนทนานี้แสดง <b>คำถามที่มีความหมาย · การพัฒนาเหตุผล · การเชื่อมโยงหลักฐาน · การสรุปการเรียนรู้</b> หรือไม่` +
    `<br><span style="color:var(--muted)">Your session is assessed on whether it shows a meaningful question, developing reasoning, evidence integration, and reflective synthesis.</span></p>` +
    `<p style="margin:14px 0 4px;color:var(--muted)">ข้อมูลการมีส่วนร่วม (บันทึกไว้ ไม่ใช่เกณฑ์ตัดสิน) / Engagement, recorded but not a criterion:</p>` +
    list +
    `<p style="margin:12px 0 0"><b>ส่งแล้วทำต่อไม่ได้อีก</b> <span style="color:var(--muted)">— This session can't be resumed once submitted.</span></p>`
  );
}

document.getElementById('endBtn').addEventListener('click', async () => {
  // No engagement-based override framing. The only genuinely irreversible thing here is submitting,
  // and the only session that cannot be assessed is an empty one.
  const hasConversation = turns >= 1;
  const ok = await confirmModal({
    title: 'จบและส่งประเมิน? / End & submit?',
    body: tierOneGuardBody(),
    confirmLabel: hasConversation ? 'จบและส่ง / End & submit' : 'ส่งทั้งที่ยังไม่ได้คุย / Submit anyway',
    cancelLabel: 'ยังไม่จบ / Keep going',
    danger: !hasConversation,
    // Submitting cannot be undone: focus starts on "Keep going", and Enter there keeps going.
    irreversible: true,
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
  const TERMINAL = ['ple_pass', 'ple_fail_t1', 'ple_flag_t2', 'ended', 'evaluated'];
  if (res && TERMINAL.includes(res.status)) {
    clearInterval(timerInterval);
    // CREC082 ICF §3 step 3: the reflection comes after the conversation and BEFORE screening,
    // because PIS-7 is assessed on "transcript และ reflection". The server says so by answering
    // pending:'reflection' and leaving the session at 'ended' rather than scoring it.
    //
    // It is a separate page rather than a panel on the result screen because that screen polls and
    // re-renders its whole body every 4s, which would wipe a half-written reflection mid-sentence.
    window.location.href = res.pending === 'reflection'
      ? `/ple-reflect?id=${pleId}`
      : `/ple-result?id=${pleId}`;
    return;
  }
  // The server refuses to close a session while a turn is being answered (it would be scored without it).
  if (res && res.code === 'turn_in_flight') {
    toast(SETTLE_COPY.endInFlight, 'error');
    endBtn.disabled = false;
    endBtn.innerHTML = origLabel;
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
