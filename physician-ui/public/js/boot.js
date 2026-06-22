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

  // view cycles auto -> desktop -> mobile -> auto
  function cycleView() {
    var order = ['auto', 'desktop', 'mobile'];
    var next = order[(order.indexOf(currentView()) + 1) % order.length];
    if (next === 'auto') { d.removeAttribute('data-view'); store('clics_view', null); }
    else { d.setAttribute('data-view', next); store('clics_view', next); }
    applyMobile(); // forced view changed → re-evaluate the mobile-layout attribute
    updateLabels();
  }

  var themeBtn, viewBtn;
  function updateLabels() {
    if (themeBtn) {
      var dark = currentTheme() === 'dark';
      themeBtn.textContent = dark ? '☀️ สว่าง' : '🌙 มืด';
      themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    }
    if (viewBtn) {
      var v = currentView();
      viewBtn.textContent = v === 'mobile' ? '📱 Mobile' : v === 'desktop' ? '💻 Desktop' : '🖥 Auto';
      viewBtn.setAttribute('aria-label', 'Switch layout (current: ' + v + ')');
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
