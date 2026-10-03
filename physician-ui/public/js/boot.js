// boot.js — injects the theme (System / Light / Dark) + desktop/mobile toggle controls and persists state.
// The pre-paint inline snippet in each <head> already applied data-theme-pref / data-theme / data-view
// before first paint (no FOUC); this script wires the interactive buttons and keeps the theme live.
//
// THEME MODEL. Three preferences, stored under `clics_theme`: 'light' | 'dark' | (absent = System).
// `data-theme-pref` on <html> holds the preference; `data-theme="dark"` is the RESOLVED theme (absent =
// light) and is the only attribute the stylesheets and charts key off. System resolves through
// prefers-color-scheme and re-resolves live when the OS flips. Old stored 'light'/'dark' values keep
// working as explicit overrides.
(function () {
  var d = document.documentElement;

  function currentTheme() { return d.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function themePref() { var p = d.getAttribute('data-theme-pref'); return p === 'light' || p === 'dark' ? p : 'system'; }
  var darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var THEME_COLOR = { light: '#faf9f5', dark: '#181715' };   // = --canvas in each theme
  function currentView() { return d.getAttribute('data-view') || 'auto'; }

  function store(key, val) { try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch (e) {} }

  // `data-mobile` is the SINGLE source of truth for the mobile LAYOUT (main.css keys all mobile rules
  // off it). The pre-paint <head> snippet set it before first paint; here we keep it live so a real
  // viewport resize / device rotation — or flipping the desktop/mobile toggle — re-evaluates it.
  // Set when: forced mobile, OR (not forced desktop AND the real viewport is ≤767px).
  var mq = window.matchMedia('(max-width:767px)');
  function applyMobile() {
    var v = currentView();
    if (v === 'mobile' || (v !== 'desktop' && mq.matches)) d.setAttribute('data-mobile', '');
    else d.removeAttribute('data-mobile');
  }
  if (mq.addEventListener) mq.addEventListener('change', applyMobile);
  else if (mq.addListener) mq.addListener(applyMobile); // Safari < 14

  // Resolve the preference to a theme, apply it, and keep <meta name="theme-color"> in step: under
  // System the two media-variant metas keep following the OS on their own; under an override both are
  // pinned to the chosen canvas colour so the browser chrome never contradicts the page.
  function applyTheme() {
    var p = themePref();
    var dark = p === 'dark' || (p === 'system' && !!darkMq && darkMq.matches);
    if (dark) d.setAttribute('data-theme', 'dark'); else d.removeAttribute('data-theme');
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      var c = p !== 'system' ? THEME_COLOR[dark ? 'dark' : 'light']
        : ((m.getAttribute('media') || '').indexOf('dark') !== -1 ? THEME_COLOR.dark : THEME_COLOR.light);
      m.setAttribute('content', c);
    }
  }
  function themeChanged() {
    applyTheme();
    updateLabels();
    window.dispatchEvent(new CustomEvent('clics:themechange'));
  }
  // System -> Light -> Dark -> System
  function cycleTheme() {
    var order = ['system', 'light', 'dark'];
    var next = order[(order.indexOf(themePref()) + 1) % order.length];
    d.setAttribute('data-theme-pref', next);
    store('clics_theme', next === 'system' ? null : next);
    themeChanged();
  }
  // OS flipped while the reader is on System: follow it live (charts redraw via clics:themechange).
  function onOsTheme() { if (themePref() === 'system') themeChanged(); }
  if (darkMq) { if (darkMq.addEventListener) darkMq.addEventListener('change', onOsTheme); else if (darkMq.addListener) darkMq.addListener(onOsTheme); }

  // view cycles auto -> mobile -> desktop -> auto (matches the audit-dashboard toggle order)
  function cycleView() {
    var order = ['auto', 'mobile', 'desktop'];
    var next = order[(order.indexOf(currentView()) + 1) % order.length];
    if (next === 'auto') { d.removeAttribute('data-view'); store('clics_view', null); }
    else { d.setAttribute('data-view', next); store('clics_view', next); }
    applyMobile(); // forced view changed → re-evaluate the mobile-layout attribute
    updateLabels();
  }

  var themeBtn, viewBtn;

  // Lucide path data (ISC) — the SAME icons the auditor (audit-dashboard) uses (Sun/Moon, and
  // MonitorSmartphone/Monitor/Smartphone), so the theme + layout toggles look identical across both
  // apps. Inlined here because boot.js runs on every page but icons.js isn't loaded on all of them.
  var TGL_ICONS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sunMoon: '<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    monitorSmartphone: '<path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M10 19v-3.96 3.15"/><path d="M7 19h5"/><rect width="6" height="10" x="16" y="12" rx="2"/>'
  };
  function tglSvg(name) {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      TGL_ICONS[name] + '</svg>';
  }

  function updateLabels() {
    if (themeBtn) {
      // The button shows the CURRENT mode (a tri-state has no single "other" mode to name).
      var p = themePref(), dark = currentTheme() === 'dark';
      var th = p === 'system' ? 'ตามระบบ' : p === 'dark' ? 'มืด' : 'สว่าง';
      var en = p === 'system' ? 'System' : p === 'dark' ? 'Dark' : 'Light';
      themeBtn.innerHTML = tglSvg(p === 'system' ? 'sunMoon' : p === 'dark' ? 'moon' : 'sun') + '<span class="toggle-label">' + th + '</span>';
      // Accessible name states the current mode, Thai first, and contains the visible word (WCAG 2.5.3).
      // Under System it also says what the OS currently resolves to.
      themeBtn.setAttribute('aria-label',
        'ธีมสี: ' + th + (p === 'system' ? ' (ขณะนี้' + (dark ? 'มืด' : 'สว่าง') + ')' : '') +
        ' / Theme: ' + en + (p === 'system' ? ' (currently ' + (dark ? 'dark' : 'light') + ')' : '') +
        ' — กดเพื่อเปลี่ยน / press to change');
    }
    if (viewBtn) {
      var v = currentView();
      var name = v === 'mobile' ? 'smartphone' : v === 'desktop' ? 'monitor' : 'monitorSmartphone';
      var label = v === 'mobile' ? 'Mobile' : v === 'desktop' ? 'Desktop' : 'Auto';
      viewBtn.innerHTML = tglSvg(name) + '<span class="toggle-label">' + label + '</span>';
      viewBtn.setAttribute('aria-label', 'Layout view: ' + v);
    }
  }

  function makeBtn() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'toggle-btn';
    return b;
  }

  function mount() {
    themeBtn = makeBtn(); themeBtn.addEventListener('click', cycleTheme);
    viewBtn = makeBtn(); viewBtn.addEventListener('click', cycleView);
    updateLabels();

    var cluster = document.createElement('span');
    cluster.className = 'toggle-cluster';
    cluster.appendChild(viewBtn);
    cluster.appendChild(themeBtn);

    var nav = document.querySelector('nav');
    if (nav) {
      var rightDiv = nav.querySelector('div');
      if (rightDiv) rightDiv.appendChild(cluster);
      else nav.appendChild(cluster);
    } else {
      cluster.classList.add('toggle-cluster-float');
      document.body.appendChild(cluster);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
