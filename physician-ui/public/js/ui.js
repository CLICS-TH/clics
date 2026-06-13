// Themed confirm-modal + toast — replaces the browser's raw confirm()/alert(), which can't be
// themed or translated and read as "unfinished" next to the editorial UI. Globals: confirmModal, toast.
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // confirmModal({ title, body, confirmLabel, cancelLabel, danger }) -> Promise<boolean>
  // title/body may contain trusted HTML (callers pass bilingual markup); plain strings are fine too.
  window.confirmModal = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      var confirmCls = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
      ov.innerHTML =
        '<div class="modal-card" role="document">' +
          (opts.title ? '<h2>' + opts.title + '</h2>' : '') +
          '<div class="modal-body">' + (opts.body || '') + '</div>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-ghost" data-act="cancel">' + (opts.cancelLabel || 'ยกเลิก / Cancel') + '</button>' +
            '<button type="button" class="' + confirmCls + '" data-act="ok">' + (opts.confirmLabel || 'ยืนยัน / Confirm') + '</button>' +
          '</div>' +
        '</div>';
      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        ov.remove();
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); close(true); }
      }
      ov.addEventListener('click', function (e) {
        if (e.target === ov) close(false);
        var act = e.target.closest && e.target.closest('[data-act]');
        if (act) close(act.getAttribute('data-act') === 'ok');
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(ov);
      var ok = ov.querySelector('[data-act="ok"]');
      if (ok) ok.focus();
    });
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
