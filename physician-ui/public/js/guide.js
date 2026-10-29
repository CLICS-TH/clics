// /manual — the logged-out nav. The language toggle is js/lang.js.
//
// This is the only page in the portal that a signed-out person can usefully read (it carries
// `data-public`, so the boot snippet does not bounce them to /). That is deliberate: the section a
// stuck reader needs most is "how to sign in", and putting it behind sign-in would be a joke. The
// consequence handled below is that the nav — copied from the five signed-in pages — otherwise
// offers Logout to someone who was never logged in.
(function () {
  'use strict';

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
    logout.addEventListener('click', function (e) {
      e.preventDefault();
      window.clicsSignOut();
    });
  }
})();
