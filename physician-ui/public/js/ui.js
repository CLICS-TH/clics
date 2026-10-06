// Themed confirm-modal + toast — replaces the browser's raw confirm()/alert(), which can't be
// themed or translated and read as "unfinished" next to the editorial UI. Globals: confirmModal, toast.
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // confirmModal({ title, body, confirmLabel, cancelLabel, danger, irreversible }) -> Promise<boolean>
  // title/body may contain trusted HTML (callers pass bilingual markup); plain strings are fine too.
  //
  // Keyboard contract (the modal must never let one stray keypress do the irreversible thing):
  //   - Focus starts on Cancel when the action is `danger` (destroys data) or `irreversible` (cannot be
  //     resumed, e.g. End & submit); otherwise on the confirm button.
  //   - Enter activates the FOCUSED button only. It is never a blanket "confirm": Enter on Cancel cancels,
  //     and a held-down Enter that opened the dialog (auto-repeat) is swallowed.
  //   - Tab / Shift+Tab stay inside the dialog; Esc cancels; focus returns to whatever opened it.
  var confirmSeq = 0;
  window.confirmModal = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var uid = 'confirmModal' + (++confirmSeq);
      var ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      // Accessible name = the heading; falls back to the body text for a title-less confirm.
      ov.setAttribute('aria-labelledby', opts.title ? uid + 'Title' : uid + 'Body');
      if (opts.title) ov.setAttribute('aria-describedby', uid + 'Body');
      var confirmCls = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
      var cautious = !!(opts.danger || opts.irreversible);
      ov.innerHTML =
        '<div class="modal-card" role="document" tabindex="-1">' +
          (opts.title ? '<h2 id="' + uid + 'Title">' + opts.title + '</h2>' : '') +
          '<div class="modal-body" id="' + uid + 'Body">' + (opts.body || '') + '</div>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-ghost" data-act="cancel">' + (opts.cancelLabel || 'ยกเลิก / Cancel') + '</button>' +
            '<button type="button" class="' + confirmCls + '" data-act="ok">' + (opts.confirmLabel || 'ยืนยัน / Confirm') + '</button>' +
          '</div>' +
        '</div>';
      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        ov.remove();
        if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus(); } catch (e) {} }
        resolve(result);
      }
      function stops() {
        return Array.prototype.slice.call(ov.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
          .filter(function (el) { return !el.disabled && el.getClientRects().length > 0; });
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
        if (e.key === 'Enter') {
          // Never a global confirm. A repeat means the key that opened this dialog is still held down.
          if (e.repeat) e.preventDefault();
          return; // otherwise leave it to the focused button's own activation
        }
        if (e.key !== 'Tab') return;
        var list = stops();
        if (!list.length) { e.preventDefault(); return; }
        var i = list.indexOf(document.activeElement);
        if (i === -1) { e.preventDefault(); list[e.shiftKey ? list.length - 1 : 0].focus(); }        // focus had left the dialog
        else if (e.shiftKey && i === 0) { e.preventDefault(); list[list.length - 1].focus(); }
        else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
      }
      ov.addEventListener('click', function (e) {
        if (e.target === ov) close(false);
        var act = e.target.closest && e.target.closest('[data-act]');
        if (act) close(act.getAttribute('data-act') === 'ok');
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(ov);
      var first = ov.querySelector(cautious ? '[data-act="cancel"]' : '[data-act="ok"]');
      if (first) first.focus();
    });
  };

  // The visible "this is the AI" marker on every assistant bubble (/ple-chat, /guest-chat).
  //
  // Approved by the product owner 2026-10-03
  // BLINDING: this is ONE fixed pair for every session, experimental arm and provider. Never derive it
  // from the response, the arm or the model, and never name a model or provider here — arm and model
  // are hidden from the physician by design. Change the wording here and nowhere else.
  window.AI_LABEL = { th: 'AI', en: 'AI' };

  // Does Enter send? Fine pointer (desktop): Enter sends, Shift+Enter is a newline. Coarse pointer (phone /
  // tablet keyboard, which has no Shift+Enter): Enter is a newline and only the Send button submits.
  // The SAME media query drives the visible hint in css/main.css (.hint-fine / .hint-touch), evaluated per
  // keypress, so the hint and the behaviour cannot disagree — not even after a rotation or an external keyboard
  // changes the primary pointer.
  window.COMPOSER_TOUCH_QUERY = '(pointer: coarse)';
  window.enterSends = function (e) {
    if (e.key !== 'Enter' || e.shiftKey) return false;
    if (e.isComposing || e.keyCode === 229) return false;   // IME candidate confirm (229 half unverified on Android Gboard)
    return !(window.matchMedia && window.matchMedia(window.COMPOSER_TOUCH_QUERY).matches);
  };

  // aiChip() -> <span class="ai-chip">. Slate-blue via --ai-* (never the human coral). It is also the
  // screen-reader speaker label, so callers must NOT add a separate sr-only "AI".
  window.aiChip = function () {
    var c = document.createElement('span');
    c.className = 'ai-chip';
    c.textContent = window.AI_LABEL.th;
    if (window.AI_LABEL.en && window.AI_LABEL.en !== window.AI_LABEL.th) {
      var en = document.createElement('span');
      en.className = 'bi-en';
      en.textContent = window.AI_LABEL.en;
      c.appendChild(en);
    }
    return c;
  };

  // ---- The chat announcer (one visually hidden role=status node per chat page, #chatLive).
  //
  // The message list is role=log with aria-live=off: an accessibility-tree dump showed that, read live, every new
  // bubble also announced its Copy / Report buttons. So new replies and notices are announced HERE instead, as
  // "speaker: plain text" only. Never called while history is drawn. The node is cleared first so the same
  // text twice still announces, and a long reply is cut so it does not hold the reader for minutes.
  var ANNOUNCE_MAX = 600;
  var ANNOUNCE_MORE = '… (อ่านต่อในแชต / continue in the chat)';
  var announceTimer = null;
  // The speaker label the AI chip shows, as text (same constant, so the two can never disagree).
  window.aiSpeakerLabel = function () {
    var L = window.AI_LABEL;
    return L.en && L.en !== L.th ? L.th + ' / ' + L.en : L.th;
  };
  window.SYSTEM_SPEAKER = 'ระบบ / System';
  // Plain text of rendered content, with a space at every block boundary (textContent alone glues
  // "Heading" + "Paragraph" and table cells into one word).
  var BLOCK = /^(P|DIV|LI|H[1-6]|TD|TH|TR|PRE|BLOCKQUOTE|UL|OL|TABLE|BR|HR)$/;
  window.plainTextOf = function (node) {
    var out = [];
    (function walk(n) {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1 && (n.getAttribute('aria-hidden') === 'true' || n.classList.contains('sr-only'))) return;
      var block = n.nodeType === 1 && BLOCK.test(n.tagName);
      if (block) out.push(' ');
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
      if (block) out.push(' ');
    })(node);
    return out.join('').replace(/\s+/g, ' ').trim();
  };
  window.announceChat = function (speaker, text) {
    var n = document.getElementById('chatLive');
    if (!n) return;
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (t.length > ANNOUNCE_MAX) {
      var cut = t.slice(0, ANNOUNCE_MAX);
      var sp = cut.lastIndexOf(' ');
      if (sp > ANNOUNCE_MAX - 80) cut = cut.slice(0, sp);   // end on a word when one is near (Thai often has none)
      t = cut + ANNOUNCE_MORE;
    }
    n.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () { n.textContent = speaker + ': ' + t; }, 120);
  };

  // ---- Safe markdown, ONE helper for every place AI text becomes DOM (/ple-chat, /guest-chat, the artifact panel).
  //
  // markdownFragment(md) -> DocumentFragment, or null when marked / DOMPurify did not load (the caller then
  // falls back to textContent, never to unsanitised HTML). DOMPurify stays the sanitiser; on top of it:
  //   - nothing that fetches a remote URL or restyles the page. DOMPurify's defaults (3.1.6, measured in a browser)
  //     let ALL of these through: <img>, <picture><source srcset>, <video>/<audio src>, <svg><image href>,
  //     style="…url()", <style> with url() / @import / @font-face (and <style>body{display:none}</style>, which
  //     hid the whole page), <table|td background>, <input type=image src>, and <form action> + <button>.
  //     So whole tags (media, svg/math, style, form, object/embed/iframe, link/meta) and the attributes that load
  //     or post (style, background, src, srcset, poster, action, formaction, ping) are forbidden outright.
  //     Any <input> that is not a GFM task-list checkbox is removed. Kept: task-list checkboxes, table `align`, links;
  //   - headings are announced as level 3+ (role=heading aria-level = n+2, capped at 6) so a reply never
  //     outranks the page's own headings, while the element and its CSS stay as they are;
  //   - tables and code blocks scroll inside a focusable, labelled group so a keyboard user can reach them.
  // Links are left exactly as DOMPurify delivers them today (clickable <a href>, no target/rel added).
  var MD_FORBID = ['img', 'picture', 'source', 'video', 'audio', 'track', 'image', 'svg', 'math',
    'style', 'form', 'object', 'embed', 'iframe', 'link', 'meta'];
  var MD_FORBID_ATTR = ['style', 'background', 'src', 'srcset', 'poster', 'action', 'formaction', 'ping'];
  function mdWrap(el, label) {
    var w = document.createElement('div');
    w.className = 'md-scroll';
    w.setAttribute('role', 'group');
    w.setAttribute('aria-label', label);
    w.tabIndex = 0;
    el.parentNode.replaceChild(w, el);
    w.appendChild(el);
  }
  window.markdownFragment = function (md) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return null;
    var frag = DOMPurify.sanitize(marked.parse(md), { FORBID_TAGS: MD_FORBID, FORBID_ATTR: MD_FORBID_ATTR, RETURN_DOM_FRAGMENT: true });
    // The only input markdown legitimately produces is a GFM task-list checkbox; anything else (an <input
    // type=image> with its src already stripped, a text field, a button-like input) is dropped.
    Array.prototype.forEach.call(frag.querySelectorAll('input'), function (i) {
      if ((i.getAttribute('type') || '').toLowerCase() !== 'checkbox') i.remove();
    });
    Array.prototype.forEach.call(frag.querySelectorAll('h1,h2,h3,h4,h5,h6'), function (h) {
      h.setAttribute('role', 'heading');
      h.setAttribute('aria-level', String(Math.min(6, Number(h.tagName.charAt(1)) + 2)));
    });
    Array.prototype.forEach.call(frag.querySelectorAll('table'), function (t) { mdWrap(t, 'ตาราง / Table'); });
    Array.prototype.forEach.call(frag.querySelectorAll('pre'), function (p) { mdWrap(p, 'โค้ด / Code'); });
    return frag;
  };

  // A visible line in the typing bubble once a turn has run long (before its first word, when the reply is
  // streamed). There are no stages to report and this says nothing about any: it only tells the reader the
  // wait is expected. COPY PENDING owner/ethics sign-off — placeholder wording; one fixed pair, never varying by
  // session, arm or provider. The delay is a plain number so it can be tuned in one place.
  window.AI_SLOW = { afterMs: 8000, th: 'ยังทำงานอยู่', en: 'Still working…' };
  // armSlowNote(bubble, onShow) -> disarm(). Call disarm() when the reply (or an error) arrives.
  window.armSlowNote = function (bubble, onShow) {
    var t = setTimeout(function () {
      if (!bubble.isConnected) return;
      var n = document.createElement('div');
      n.className = 'typing-note';
      n.textContent = window.AI_SLOW.th;
      var en = document.createElement('span');
      en.className = 'bi-en';
      en.textContent = window.AI_SLOW.en;
      n.appendChild(en);
      bubble.appendChild(n);
      window.announceChat(window.aiSpeakerLabel(), window.AI_SLOW.th + ' / ' + window.AI_SLOW.en);
      if (onShow) onShow();
    }, window.AI_SLOW.afterMs);
    return function () { clearTimeout(t); };
  };

  // toast(message, type) — type: '' | 'success' | 'error'. Auto-dismisses.
  window.toast = function (msg, type) {
    var wrap = document.querySelector('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' toast-' + type : '');
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    t.innerHTML = esc(msg);
    wrap.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .25s ease';
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 260);
    }, type === 'error' ? 4200 : 3000);
  };
})();
