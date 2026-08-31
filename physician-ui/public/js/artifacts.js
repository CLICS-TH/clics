// Clinical artifacts — detect the AI's `:::artifact{...}` fences, lift them out of the message bubble,
// and render them in the side panel. The fence is the ON-PREM control syntax (kept in sync with
// rimpl/src/lib/transcript.js + audit-dashboard/components/TranscriptView.tsx); the inner markdown is
// the clinical content. Parsing happens here on the frontend over the raw stored `content`, so artifacts
// re-appear on reload with no extra persistence.
(function () {
  // Human label + icon per artifact type (the model emits the `type` attribute).
  var KIND = {
    differential: { label: 'Differential diagnosis', icon: 'clipboard' },
    care_plan:    { label: 'Care plan',              icon: 'clipboard' },
    algorithm:    { label: 'Clinical algorithm',     icon: 'sidebar' },
    evidence:     { label: 'Evidence summary',       icon: 'clipboard' },
  };
  function kindOf(type) { return KIND[type] || { label: 'Clinical artifact', icon: 'clipboard' }; }

  // djb2 → short base36 hash, for a stable id derived from content (no UUID/counter that drifts per render).
  function djb2(s) { var h = 5381; for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); }

  // Extract every artifact from one message's raw content. Manual scan (not one big multiline regex) so
  // truncated/unclosed fences and multiple artifacts are handled cleanly. Returns the message text with the
  // fences removed, plus the artifact list. A fence must start a line (^ or after \n).
  var OPEN_RE = /(^|\n):::artifact\{([^}\n]*)\}[ \t]*\n/;
  var CLOSE_RE = /\n:::[ \t]*(?=\n|$)/;
  function extract(content, msgIndex) {
    var rest = String(content == null ? '' : content);
    var artifacts = [];
    var clean = '';
    var k = 0;
    var m;
    while ((m = OPEN_RE.exec(rest)) !== null) {
      clean += rest.slice(0, m.index + m[1].length);     // keep the prose before the fence (incl. its \n)
      var attrs = m[2];
      var after = rest.slice(m.index + m[0].length);     // everything past the opening fence line
      var close = after.match(CLOSE_RE);
      var body, consumed, truncated;
      if (close) { body = after.slice(0, close.index); consumed = m.index + m[0].length + close.index + close[0].length; truncated = false; }
      else { body = after; consumed = rest.length; truncated = true; }   // unclosed (max-tokens cut) → to end
      body = body.replace(/\s+$/, '');
      var type = (attrs.match(/type\s*=\s*"([^"]*)"/i) || [])[1] || 'clinical';
      var title = (attrs.match(/title\s*=\s*"([^"]*)"/i) || [])[1] || kindOf(type).label;
      artifacts.push({ id: 'art-' + msgIndex + '-' + (k++) + '-' + djb2(body), type: type, title: title, body: body, truncated: truncated });
      rest = rest.slice(consumed);
    }
    clean += rest;
    return { cleanContent: clean.trim(), artifacts: artifacts };
  }

  var registry = new Map();
  function register(a) { if (!registry.has(a.id)) registry.set(a.id, a); return a.id; }

  // Sanitized markdown → HTML for the panel body; fail SAFE to plain text if either lib is unavailable
  // (mirrors ple-chat.js renderMessage — AI output is untrusted once marked.parse runs it).
  function renderBody(body) {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(marked.parse(body));
    var d = document.createElement('div'); d.textContent = body; return d.innerHTML;
  }

  // An inline chip placed in the message bubble; tapping it opens the artifact in the side panel.
  function chip(a) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'artifact-chip';
    b.dataset.artifactId = a.id;
    b.insertAdjacentHTML('beforeend', window.icon ? icon(kindOf(a.type).icon, 15) : '');
    var span = document.createElement('span');
    span.textContent = a.title;
    b.appendChild(span);
    b.addEventListener('click', function () { open(a.id); });
    return b;
  }

  function panel() { return document.getElementById('artifactPanel'); }
  function open(id) {
    var a = registry.get(id);
    var p = panel();
    if (!a || !p) return;
    document.getElementById('artifactTitle').textContent = a.title;
    var kindEl = document.getElementById('artifactKind');
    if (kindEl) kindEl.textContent = kindOf(a.type).label;
    document.getElementById('artifactBody').innerHTML = renderBody(a.body);
    var trunc = document.getElementById('artifactTrunc');
    if (trunc) trunc.hidden = !a.truncated;
    p.dataset.activeId = id;
    p.hidden = false;
    requestAnimationFrame(function () { p.classList.add('open'); });
    // mark the matching chip(s) active
    document.querySelectorAll('.artifact-chip').forEach(function (c) { c.classList.toggle('active', c.dataset.artifactId === id); });
  }
  function close() {
    var p = panel();
    if (!p) return;
    p.classList.remove('open');
    p.hidden = true;
    p.removeAttribute('data-active-id');
    document.querySelectorAll('.artifact-chip.active').forEach(function (c) { c.classList.remove('active'); });
  }

  // Wire the panel's own controls once the DOM is ready.
  function wire() {
    var closeBtn = document.getElementById('artifactClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var copyBtn = document.getElementById('artifactCopy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var p = panel(); var a = p && registry.get(p.dataset.activeId);
      if (!a) return;
      (navigator.clipboard ? navigator.clipboard.writeText(a.body) : Promise.reject())
        .then(function () { if (window.toast) toast('คัดลอกแล้ว / Copied', 'success'); })
        .catch(function () { if (window.toast) toast('คัดลอกไม่สำเร็จ / Copy failed', 'error'); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var p = panel(); if (p && !p.hidden) close(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.CLICSArtifacts = { extract: extract, register: register, chip: chip, open: open, close: close };
})();
