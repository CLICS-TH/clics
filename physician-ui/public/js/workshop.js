/* The Calibration Workshop page (workshop.html): mounts the scroll engine (js/scrollcraft.js, loaded before this
   file), then adds what the engine does not draw.
   - The language switch: one language at a time, Thai by default, held for this visit only (nothing is stored).
   - The calibration figure, the page's peak: as the reader scrolls the pinned chapter, three physicians' scattered
     PIS-7 shapes and the grey band between them collapse onto one shared shape, and the cohort's four steps light in
     turn. It reads the engine's --sc-p off the chapter. Under reduced motion the figure jumps between four still
     states, one per step, instead of moving.
   - The seven-domain radar: a tap on d1-d7 shows that domain's one line.
   - The folio: the title of the chapter on screen, in the margin of a wide screen.
   The figures are illustrations: the scores below are drawn shapes, not data. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- language -----------------------------------------------------------------------------------------------
  var langButtons = document.querySelectorAll('[data-set-lang]');
  var engine = null;
  function setLang(lang) {
    root.lang = lang;
    langButtons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.setLang === lang)); });
    // The other language sets different line counts, so every chapter's top and height move: measure them again.
    if (engine) engine.layout();
  }
  langButtons.forEach(function (b) { b.addEventListener('click', function () { setLang(b.dataset.setLang); }); });

  if (window.ScrollCraft) engine = window.ScrollCraft.mount(document.body);

  // ---- the calibration figure ---------------------------------------------------------------------------------
  // d1..d7 on a 0-5 scale. Three readings far apart, and the shared reading they settle on.
  var SHARED = [4, 3, 3.5, 2.5, 3, 3, 3.5];
  var READINGS = [
    [4.6, 1.6, 4.4, 1.2, 4.2, 1.8, 2.4],
    [2.4, 4.4, 2.0, 3.8, 1.6, 4.4, 4.6],
    [3.2, 2.2, 4.8, 3.4, 4.6, 2.2, 1.6],
  ];
  var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  var smooth = function (x) { x = clamp01(x); return x * x * (3 - 2 * x); };
  function points(values) {
    return values.map(function (v, i) {
      var a = (-90 + i * 360 / 7) * Math.PI / 180;
      return (Math.cos(a) * v * 20).toFixed(1) + ',' + (Math.sin(a) * v * 20).toFixed(1);
    }).join(' ');
  }

  var cal = document.querySelector('.ch-cal');
  var fig = cal && cal.querySelector('.cal');
  if (fig) {
    var raters = fig.querySelectorAll('.rater');
    var band = fig.querySelector('.band');
    var shared = fig.querySelector('.shared');
    var steps = cal.querySelectorAll('.cal-steps li');
    var lastP = -1;

    // Step 1 alone, 2 compare (the band darkens), 3 talk it through (the shapes move), 4 one shared reading.
    var stepOf = function (p) { return p < 0.2 ? 0 : p < 0.4 ? 1 : p < 0.72 ? 2 : 3; };
    var draw = function (p) {
      var step = stepOf(p);
      var t = reduce ? [0, 0, 0.5, 1][step] : smooth((p - 0.4) / 0.32);
      var s = reduce ? (step === 3 ? 1 : 0) : smooth((p - 0.62) / 0.14);
      var now = READINGS.map(function (r) { return r.map(function (v, i) { return v + (SHARED[i] - v) * t; }); });
      now.forEach(function (values, k) { raters[k].setAttribute('points', points(values)); });
      var hi = SHARED.map(function (_, i) { return Math.max(now[0][i], now[1][i], now[2][i]); });
      var lo = SHARED.map(function (_, i) { return Math.min(now[0][i], now[1][i], now[2][i]); });
      band.setAttribute('d', 'M' + points(hi).replace(/ /g, ' L') + ' Z M' + points(lo).replace(/ /g, ' L') + ' Z');
      shared.style.opacity = s.toFixed(3);
      raters.forEach(function (r) { r.style.opacity = (1 - 0.55 * s).toFixed(3); });
      fig.dataset.step = String(step);
      steps.forEach(function (li, i) {
        li.classList.toggle('done', i < step);
        if (i === step) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      });
    };
    var read = function () { return parseFloat(cal.style.getPropertyValue('--sc-p')) || 0; };
    draw(0);

    // Redraw only while the chapter is near the screen, and only when the engine's progress moved.
    var frame = 0;
    var tick = function () {
      var p = read();
      if (Math.abs(p - lastP) > 0.0004) { lastP = p; draw(p); }
      frame = requestAnimationFrame(tick);
    };
    new IntersectionObserver(function (entries) {
      var on = entries[0].isIntersecting;
      if (on && !frame) frame = requestAnimationFrame(tick);
      if (!on && frame) { cancelAnimationFrame(frame); frame = 0; draw(read()); }
    }, { rootMargin: '50% 0px' }).observe(cal);
  }

  // ---- the seven domains --------------------------------------------------------------------------------------
  var dom = document.querySelector('.ch-dom');
  if (dom) {
    var buttons = dom.querySelectorAll('.ax');
    var cards = dom.querySelectorAll('.dom-card');
    var marks = dom.querySelectorAll('[data-wedge], [data-spoke]');
    var say = dom.querySelector('[data-dom-say]');
    var pick = function (key, announce) {
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.dom === key)); });
      cards.forEach(function (c) { c.classList.toggle('on', c.dataset.dom === key); });
      marks.forEach(function (m) { m.classList.toggle('on', (m.dataset.wedge || m.dataset.spoke) === key); });
      // The card shown changes by visibility, which a screen reader may not count as new text: say it in a live line.
      var card = dom.querySelector('.dom-card.on');
      if (announce && say && card) say.textContent = card.innerText.replace(/\s+/g, ' ').trim();
    };
    buttons.forEach(function (b) { b.addEventListener('click', function () { pick(b.dataset.dom, true); }); });
    pick('d1');
  }

  // ---- folio ----------------------------------------------------------------------------------------------------
  var folio = document.querySelector('[data-folio]');
  if (folio) {
    var th = folio.querySelector('[lang="th"]');
    var en = folio.querySelector('[lang="en"]');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        th.textContent = e.target.dataset.folioTh;
        en.textContent = e.target.dataset.folioEn;
      });
    }, { rootMargin: '-50% 0px -50% 0px' });
    document.querySelectorAll('[data-folio-th]').forEach(function (s) { io.observe(s); });
  }
})();
