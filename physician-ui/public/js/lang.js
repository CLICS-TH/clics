// TH/EN switch for the public bilingual pages (/, /manual). Both languages are in the DOM and CSS
// hides one under html[data-manual-lang="en"]; see scripts/manuals/build.mjs for why. The key and
// attribute keep their manual-era names because the manual tooling keys on them, and one stored
// choice should hold across every public page.
(function () {
  'use strict';

  var doc = document.documentElement;
  var LANG_KEY = 'clics_manual_lang';

  // The pre-paint snippet in <head> has already applied the stored choice; this wires the buttons
  // and keeps them, `lang`, the tab title, accessible names and image alts in sync. boot.js listens
  // for clics:langchange to relabel the theme and view toggles.
  function swap(selector, attr, set) {
    var els = document.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) set(els[i], els[i].getAttribute(attr));
  }
  function applyLang(lang) {
    if (lang === 'en') doc.setAttribute('data-manual-lang', 'en');
    else doc.removeAttribute('data-manual-lang');
    // `lang` on <html> drives font fallback, hyphenation and how a screen reader pronounces the
    // page. Leaving it at "th" while showing English is the kind of thing only a screen-reader
    // user notices, and they notice it immediately.
    doc.setAttribute('lang', lang === 'en' ? 'en' : 'th');
    var btns = document.querySelectorAll('.lang-switch [data-set-lang]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-set-lang') === lang;
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var en = lang === 'en';
    swap('img[data-alt-th][data-alt-en]', en ? 'data-alt-en' : 'data-alt-th', function (el, v) { el.alt = v; });
    swap('[data-label-th][data-label-en]', en ? 'data-label-en' : 'data-label-th', function (el, v) { el.setAttribute('aria-label', v); });
    var title = doc.getAttribute(en ? 'data-title-en' : 'data-title-th');
    if (title) document.title = title;
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* private mode: session-only is fine */ }
    window.dispatchEvent(new CustomEvent('clics:langchange'));
  }

  var stored = 'th';
  try { stored = localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'th'; } catch (e) { /* ignore */ }
  applyLang(stored);

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.lang-switch [data-set-lang]') : null;
    if (!btn) return;
    e.preventDefault();
    applyLang(btn.getAttribute('data-set-lang'));
    // Deliberately NOT scrolling or re-anchoring: the two copies are the same document in two
    // languages, so the reader's position is still the right position.
  });
})();
