// /manual — the language toggle and the logged-out nav.
//
// This is the only page in the portal that a signed-out person can usefully read (it carries
// `data-public`, so the boot snippet does not bounce them to /). That is deliberate: the section a
// stuck reader needs most is "how to sign in", and putting it behind sign-in would be a joke. The
// consequence handled below is that the nav — copied from the five signed-in pages — otherwise
// offers Logout to someone who was never logged in.
(function () {
  'use strict';

  var doc = document.documentElement;
  var LANG_KEY = 'clics_manual_lang';

  // ---- language ------------------------------------------------------------------------------
  // The pre-paint snippet in <head> has already applied the stored choice; this only wires the
  // buttons and keeps them in sync. Both languages are in the DOM — see build.mjs for why.
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
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* private mode: session-only is fine */ }
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

  // ---- nav, for whoever is actually reading ---------------------------------------------------
  var links = document.getElementById('navLinks');
  var token = null;
  try { token = localStorage.getItem('clics_token'); } catch (e) { /* ignore */ }

  if (!token && links) {
    // Signed out: the console links would all bounce off the boot redirect, and Logout is
    // meaningless. Replace the row with the one action that works. Built with DOM methods rather
    // than innerHTML, matching login.html:226-232 — the CSP allows inline script, and the house
    // habit is to not hand strings to the parser.
    while (links.firstChild) links.removeChild(links.firstChild);
    var a = document.createElement('a');
    a.href = '/login';
    a.appendChild(document.createTextNode('เข้าสู่ระบบ'));
    var en = document.createElement('span');
    en.className = 'bi-en';
    en.appendChild(document.createTextNode('Sign in'));
    a.appendChild(en);
    links.appendChild(a);
    return;
  }

  var logout = document.getElementById('logoutBtn');
  if (logout) {
    logout.addEventListener('click', async function (e) {
      e.preventDefault();
      try { if (window.api && window.api.logout) await window.api.logout(); } catch (err) { /* sign out locally regardless */ }
      // Preserve display prefs across logout, mirroring dashboard.js:239-243 — signing out must not
      // reset a dark-mode reader to light. The manual language is a display pref too.
      var t = localStorage.getItem('clics_theme');
      var v = localStorage.getItem('clics_view');
      var l = localStorage.getItem(LANG_KEY);
      localStorage.clear();
      if (t) localStorage.setItem('clics_theme', t);
      if (v) localStorage.setItem('clics_view', v);
      if (l) localStorage.setItem(LANG_KEY, l);
      window.location.href = '/login';
    });
  }
})();
