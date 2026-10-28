// Signed-in forward, shared by the Landing page (/) and the Login page (/login). Loads after
// config.js, which supplies CLICS_DASHBOARD_URL.
//
// A stored admin/auditor/superadmin token goes to the audit-dashboard Handoff, not /dashboard,
// whose physician guard would bounce it back here and read as "logged in but thrown out".
// Forwards use replace() so Back from the destination skips this page instead of bouncing
// forward again (#176).
(function () {
  'use strict';

  // An OAuth return is being carried to /auth/callback by the head rescue's pending replace();
  // forwarding now would win that race and eat the sign-in. A plain anchor (/#faq) is not one.
  function isOAuthReturn(loc) {
    return loc.hash.indexOf('access_token') !== -1 || loc.hash.indexOf('error_description') !== -1
      || loc.search.indexOf('code=') !== -1;
  }

  function jwtExp(t) {
    try { var p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); var pad = p.length % 4; if (pad) p += '===='.slice(pad); return JSON.parse(atob(p)).exp; }
    catch (e) { return null; }
  }

  // -> { go: null } stay | { discard: true } drop the stored session and stay | { go: url, handoff }
  function decide(token, user, nowMs, lastHandoff, dashboardUrl) {
    if (!token) return { go: null };
    // An EXPIRED / unparseable token must be discarded, never forwarded: a dead staff token sent to
    // the dashboard (which 401s and bounces back here) looped forever, because localStorage is
    // per-origin so our copy was never cleared.
    var exp = jwtExp(token);
    if (!exp || exp <= Math.floor(nowMs / 1000)) return { discard: true, go: null };
    // Handed off <6s ago and already back: the dashboard rejected the token (revoked / wrong
    // signature). Discard it rather than ping-pong forever.
    if (lastHandoff && nowMs - lastHandoff < 6000) return { discard: true, go: null };
    // A missing user still goes to /dashboard; guardRole heals the state there.
    if (!user || user.role === 'physician') return { go: '/dashboard' };
    return { go: dashboardUrl + '/login?token=' + encodeURIComponent(token), handoff: true };
  }

  if (isOAuthReturn(location)) return;
  var token = null, user = null, last = 0;
  try {
    token = localStorage.getItem('clics_token');
    user = JSON.parse(localStorage.getItem('clics_user') || 'null');
    last = parseInt(sessionStorage.getItem('clics_handoff') || '0', 10);
  } catch (e) {}

  var d = decide(token, user, Date.now(), last, window.CLICS_DASHBOARD_URL || 'http://localhost:3002');
  if (d.discard) {
    try { localStorage.removeItem('clics_token'); localStorage.removeItem('clics_user'); sessionStorage.removeItem('clics_handoff'); } catch (e) {}
  }
  if (!d.go) return;
  if (d.handoff) { try { sessionStorage.setItem('clics_handoff', String(Date.now())); } catch (e) {} }
  // The Landing page hides its body under this attribute, so a signed-in visitor never sees it flash.
  document.documentElement.setAttribute('data-forwarding', '');
  location.replace(d.go);
})();
