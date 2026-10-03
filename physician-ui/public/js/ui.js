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
  // COPY PENDING owner/ethics sign-off — "AI" is a neutral placeholder, not approved wording.
  // BLINDING: this is ONE fixed pair for every session, experimental arm and provider. Never derive it
  // from the response, the arm or the model, and never name a model or provider here — arm and model
  // are hidden from the physician by design. Change the wording here and nowhere else.
  window.AI_LABEL = { th: 'AI', en: 'AI' };

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
