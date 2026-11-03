// Google sign-in for the Portal (ADR 0008). One entry point, clicsGoogleSignIn(), wires a page's
// "Continue with Google" button for one flow. Two modes:
//   gis      → the press loads Google's script (never before it), swaps in Google's own button, trades
//              the credential with signInWithIdToken + a hashed nonce, then hands the session to the
//              Callback page in the URL hash, the shape the Supabase redirect lands.
//   redirect → today's signInWithOAuth redirect through Supabase.
// The Callback page finishes both modes, so signup/invite/link branches and the token rule live there.
//
// The flow marker (signup | invite | link) is per tab. localStorage is shared by every tab of the origin, so a
// second tab's press would overwrite and consume this tab's marker. gis therefore keeps the marker in this tab's
// sessionStorage, tagged with a per-press id that also rides the Callback hash (`flow=`). The redirect cannot
// carry anything through Google, so it writes the same marker to sessionStorage (this tab's copy, which survives
// the round trip) and, as the fallback for a browser that drops it, to the shared localStorage key.
(function () {
  var GSI_SRC = 'https://accounts.google.com/gsi/client';
  var scriptPromise = null;

  function configured(flow) {
    var modes = window.CLICS_GOOGLE_SIGNIN || {};
    var origins = window.CLICS_GOOGLE_ORIGINS || [];
    return modes[flow] === 'gis' && !!window.CLICS_GOOGLE_CLIENT_ID && origins.indexOf(location.origin) !== -1
      && !!(window.crypto && crypto.subtle) && canKeepFlowInTab();
  }

  // gis keeps the flow marker in this tab's sessionStorage; where that is blocked, the redirect still has its fallback.
  function canKeepFlowInTab() {
    try { sessionStorage.setItem('clics_flow_probe', '1'); sessionStorage.removeItem('clics_flow_probe'); return true; } catch (e) { return false; }
  }

  function loadGsi() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = GSI_SRC; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { scriptPromise = null; reject(new Error('gsi load failed')); };
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function hex(bytes) {
    return Array.prototype.map.call(new Uint8Array(bytes), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function newNonce() {
    var raw = hex(crypto.getRandomValues(new Uint8Array(32)));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)).then(function (d) {
      return { raw: raw, hashed: hex(d) };
    });
  }

  function newFlowId() { return hex(crypto.getRandomValues(new Uint8Array(16))); }

  function dropSupabaseKeys() {
    try { for (var k of Object.keys(localStorage)) if (k.indexOf('sb-') === 0) localStorage.removeItem(k); } catch (e) {}
  }

  // opts: { flow: 'login'|'invite'|'link', marker: object stored for the Callback page,
  //         onError(message) shows a message on the page }
  window.clicsGoogleSignIn = function (button, opts) {
    var slot = null;
    var width = 320;
    var linking = opts.flow === 'link'; // already signed in: the sign-in wording would misdirect

    function fail(message) {
      dropSupabaseKeys();
      opts.onError(message);
    }

    function startRedirect() {
      var raw = JSON.stringify(opts.marker);
      try { sessionStorage.setItem('clics_oauth_flow', raw); } catch (e) {}
      localStorage.setItem('clics_oauth_flow', raw);
      var redirectTo = location.origin + '/auth/callback';
      window.sbClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo } }).then(function (r) {
        if (r.error) opts.onError(r.error.message || 'ไม่สามารถเริ่ม Google ได้ / Could not start Google sign-in.');
      });
    }

    function onCredential(nonce, response) {
      if (!response || !response.credential) {
        fail('Google ไม่ได้ส่งบัญชีกลับมา กรุณากดปุ่ม Google อีกครั้ง / Google did not return an account. Please press the Google button again.');
        return renderGoogleButton();
      }
      window.sbClient.auth.signInWithIdToken({ provider: 'google', token: response.credential, nonce: nonce.raw }).then(function (r) {
        var session = r.data && r.data.session;
        if (r.error || !session) {
          fail(linking ? 'เชื่อมบัญชี Google ไม่สำเร็จ กรุณาลองใหม่ / Could not link your Google account. Please try again.'
            : 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ กรุณาลองใหม่ / Google sign-in failed. Please try again.');
          return renderGoogleButton();
        }
        var flowId = newFlowId();
        try {
          sessionStorage.setItem('clics_oauth_flow', JSON.stringify(Object.assign({}, opts.marker, { id: flowId })));
        } catch (e) {
          // No marker the Callback page can trust means no hand-off: it would otherwise run the wrong flow.
          fail(linking ? 'เชื่อมบัญชี Google ไม่สำเร็จ กรุณาลองใหม่ / Could not link your Google account. Please try again.'
            : 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ กรุณาลองใหม่ / Google sign-in failed. Please try again.');
          return renderGoogleButton();
        }
        var hash = new URLSearchParams({
          access_token: session.access_token, refresh_token: session.refresh_token,
          expires_in: String(session.expires_in || 3600), token_type: session.token_type || 'bearer',
          flow: flowId,
        });
        location.replace('/auth/callback#' + hash.toString());
      });
    }

    // Every render takes a fresh nonce: Google gets its SHA-256, Supabase gets the raw value.
    function renderGoogleButton() {
      return newNonce().then(function (nonce) {
        google.accounts.id.initialize({
          client_id: window.CLICS_GOOGLE_CLIENT_ID,
          callback: function (response) { onCredential(nonce, response); },
          nonce: nonce.hashed,
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: false,
        });
        slot.textContent = '';
        google.accounts.id.renderButton(slot, {
          type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular',
          width: width,
          locale: document.documentElement.lang === 'en' ? 'en' : 'th',
        });
      });
    }

    function startGis() {
      // Measure before hiding: a hidden button measures 0. Google's width is a minimum, so stay within the box.
      width = Math.min(400, Math.max(200, Math.round(button.getBoundingClientRect().width) || 320));
      button.disabled = true;
      loadGsi().then(function () {
        slot = document.createElement('div');
        slot.className = 'google-gis-slot';
        slot.style.display = 'flex'; slot.style.justifyContent = 'center';
        slot.tabIndex = -1;
        slot.setAttribute('role', 'group');
        slot.setAttribute('aria-label', 'กดปุ่ม Google เพื่อดำเนินการต่อ / Press the Google button to continue');
        button.parentNode.insertBefore(slot, button);
        button.style.display = 'none';
        return renderGoogleButton().then(function () { slot.focus(); });
      }).catch(function () {
        if (slot) { slot.remove(); slot = null; }
        button.style.display = ''; button.disabled = false;
        fail(linking ? 'โหลดปุ่ม Google ไม่สำเร็จ กรุณาลองใหม่ / Could not load the Google button. Please try again.'
          : 'โหลดปุ่ม Google ไม่สำเร็จ ลองใหม่หรือใช้อีเมลและรหัสผ่าน / Could not load the Google button. Try again or use email and password.');
      });
    }

    button.addEventListener('click', function () {
      if (configured(opts.flow)) startGis(); else startRedirect();
    });
  };
})();
