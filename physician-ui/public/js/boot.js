// boot.js — injects the dark/light + desktop/mobile toggle controls and persists state.
// The pre-paint inline snippet in each <head> already applied data-theme / data-view
// before first paint (no FOUC); this script wires the interactive buttons.
(function () {
  var d = document.documentElement;

  function currentTheme() { return d.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
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

  function toggleTheme() {
    if (currentTheme() === 'dark') { d.removeAttribute('data-theme'); store('clics_theme', 'light'); }
    else { d.setAttribute('data-theme', 'dark'); store('clics_theme', 'dark'); }
    updateLabels();
    window.dispatchEvent(new CustomEvent('clics:themechange'));
  }

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
      var dark = currentTheme() === 'dark';
      themeBtn.innerHTML = tglSvg(dark ? 'sun' : 'moon') + '<span class="toggle-label">' + (dark ? 'สว่าง' : 'มืด') + '</span>';
      // Thai first, English after, and the visible word (สว่าง / มืด) is inside the name (WCAG 2.5.3 Label in Name).
      themeBtn.setAttribute('aria-label', dark ? 'เปลี่ยนเป็นโหมดสว่าง / Switch to light mode' : 'เปลี่ยนเป็นโหมดมืด / Switch to dark mode');
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
    themeBtn = makeBtn(); themeBtn.addEventListener('click', toggleTheme);
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
