// The booth feedback form (spec 2026-11-24, ADR 0015): seven required answers and an optional comment, sent with no tag,
// no play id and no time to POST /booth/feedback. A slider the visitor has not touched sends nothing and blocks Send,
// so the starting value is never counted as an answer. The comment is de-identified by rimpl before it is stored; when
// that fails the backend stores nothing and the page offers a retry or a send without it.
import { FEEDBACK_COPY as C, LOOKS, fill } from './booth-copy.js';
import { el, bi, setLook, currentLook } from './booth-dom.js';
import { createBoothApi } from './booth-api.js';
import { MOODS, moodFace, scaleFace } from './booth-faces.js';
import { parseFeedbackFragment } from './booth-feedback-link.js';

const FORM = 'fb-1';
const SENT_KEY = 'clics.booth.feedback.sent';
const COMMENT_MAX = 1000;
const GET_MS = 8000;
const POST_MS = 20000;
const THUMB = 30;

const ROLES = ['physician', 'resident', 'student', 'other'];
const FELT_LIKE = [['exam', 'clipboardCheck'], ['real_patient', 'stethoscope'], ['ward_round', 'users'], ['game', 'gamepad'], ['textbook', 'bookOpen'], ['other', 'message']];
/** The sliders: low end, high end, and the unit their answer is read in. */
const SLIDERS = { easy: { min: 1, max: 5 }, real: { min: 1, max: 5 }, fair: { min: 1, max: 5 }, use: { min: 0, max: 10 } };
const REQUIRED = ['role', 'mood', 'felt_like', 'easy', 'real', 'fair', 'use'];

const api = createBoothApi(window.CLICS_API_URL);
const link = parseFeedbackFragment(location.hash);
setLook(link.look);

const root = document.getElementById('feedback');
/** The visitor's answers; a slider is absent until the visitor touches it. */
const answers = { felt_like: new Set() };

const icon = (name, size = 20) => {
  const span = el('span', { class: 'fb-ic', 'aria-hidden': 'true' });
  span.innerHTML = window.icon(name, size);
  return span;
};
const faceNode = (markup, cls) => {
  const span = el('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = markup;
  return span;
};
const primary = () => LOOKS[currentLook()].primary;

/** One question card: its numbered title (the section's name) and its body. */
function card(id, n, body, { hint = null, optional = false } = {}) {
  const q = C.questions[id];
  const title = el('h2', { class: n ? 'fb-q-title' : 'fb-q-title plain', id: `q-${id}` },
    n ? el('span', { class: 'fb-n' }, `${n}.`) : null, bi(q),
    optional ? bi(C.optional, 'fb-optional') : null);
  return el('section', { class: 'fb-q', dataset: { q: id }, 'aria-labelledby': `q-${id}` }, title, hint ? bi(hint, 'fb-hint') : null, body);
}

function chips(ids, copy, { multi, icons = null, id }) {
  const group = el('div', { class: 'fb-chips', role: 'group', 'aria-labelledby': `q-${id}` });
  for (const key of ids) {
    const chip = el('button', { type: 'button', class: 'fb-chip', 'aria-pressed': 'false', dataset: { value: key } },
      icons ? icon(icons[key]) : null, bi(copy[key]));
    chip.addEventListener('click', () => {
      if (multi) {
        if (answers[id].has(key)) answers[id].delete(key); else answers[id].add(key);
        chip.setAttribute('aria-pressed', String(answers[id].has(key)));
      } else {
        answers[id] = key;
        for (const c of group.children) c.setAttribute('aria-pressed', String(c === chip));
      }
      changed();
    });
    group.append(chip);
  }
  return group;
}

function moods() {
  const group = el('div', { class: 'fb-moods', role: 'group', 'aria-labelledby': 'q-mood' });
  for (const mood of MOODS) {
    const btn = el('button', { type: 'button', class: 'fb-mood', 'aria-pressed': 'false', dataset: { value: mood } },
      faceNode(moodFace(mood), 'fb-face'), bi(C.moods[mood]));
    btn.addEventListener('click', () => {
      answers.mood = mood;
      for (const b of group.children) b.setAttribute('aria-pressed', String(b === btn));
      changed();
    });
    group.append(btn);
  }
  return group;
}

/** A native range input, so the keyboard and a screen reader work as they do on any slider. Until the first touch or
 *  key it is idle (grey, "drag to answer", sends nothing); a face above the thumb follows the value. */
function slider(id) {
  const { min, max } = SLIDERS[id];
  const ten = max === 10;
  const input = el('input', { type: 'range', class: 'fb-range idle', min, max, step: 1, value: Math.round((min + max) / 2), 'aria-labelledby': `q-${id}` });
  const bubble = faceNode(scaleFace(0.5), 'fb-bubble idle');
  const readout = el('div', { class: 'fb-readout idle' }, bi(C.drag));
  input.setAttribute('aria-valuetext', C.unanswered[primary()]);
  const place = () => {
    const pct = (input.value - min) / (max - min);
    bubble.style.left = `calc(${pct * 100}% + ${(0.5 - pct) * THUMB}px)`;
    input.style.setProperty('--fill', input.classList.contains('idle') ? '0%' : `${pct * 100}%`);
  };
  const answer = () => {
    const v = Number(input.value);
    for (const e of [input, bubble, readout]) e.classList.remove('idle');
    const label = ten ? null : C.scale[v - 1];
    const text = ten ? { th: `${v} / 10`, en: `${v} / 10` } : { th: `${label.th} (${v}/5)`, en: `${label.en} (${v}/5)` };
    bubble.innerHTML = scaleFace((v - min) / (max - min));
    readout.replaceChildren(bi(text));
    input.setAttribute('aria-valuetext', ten ? `${v} จาก 10` : `${label[primary()]}, ${v} ${primary() === 'th' ? 'จาก' : 'of'} 5`);
    answers[id] = v;
    place();
    changed();
  };
  input.addEventListener('input', answer);
  // A tap on the thumb where it stands changes no value, so no input event: the click answers it. A scroll that starts on
  // the slider gives neither, so a swipe past it is not an answer. So do the keys that move a slider, at either end.
  input.addEventListener('click', answer);
  input.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) answer(); });
  place();
  const [lo, hi] = C.ends[id];
  return el('div', { class: 'fb-slider' },
    el('div', { class: 'fb-track' }, bubble, input),
    el('div', { class: 'fb-ends' }, bi(lo, 'fb-end'), bi(hi, 'fb-end fb-end-hi')),
    readout);
}

const header = el('header', { class: 'fb-top' }, el('h1', { class: 'fb-title' }, bi(C.title)), el('p', { class: 'fb-progress', dataset: { progress: '' } }));
const bar = el('div', { class: 'fb-bar', role: 'progressbar', 'aria-label': C.title[primary()], 'aria-valuemin': '0', 'aria-valuemax': String(REQUIRED.length) },
  el('i'));
const comment = el('textarea', { class: 'fb-comment', rows: '4', maxlength: String(COMMENT_MAX), 'aria-labelledby': 'q-comment', lang: primary() });
const submit = el('button', { type: 'button', class: 'booth-btn primary wide fb-submit', dataset: { submit: '' } }, el('span', { class: 'btn-label' }, bi(C.submit)));
submit.disabled = true;
const failed = el('p', { class: 'fb-notice', role: 'alert', hidden: '', dataset: { sendFailed: '' } }, bi(C.failed));
const retry = el('button', { type: 'button', class: 'booth-btn primary wide', dataset: { action: 'retry' } }, el('span', { class: 'btn-label' }, bi(C.retry)));
const without = el('button', { type: 'button', class: 'booth-btn secondary wide', dataset: { action: 'send-without' } }, el('span', { class: 'btn-label' }, bi(C.sendWithout)));
const commentFailed = el('div', { class: 'fb-notice-box', role: 'alert', hidden: '', dataset: { commentFailed: '' } }, bi(C.commentFailed, 'fb-notice'), retry, without);
const form = el('form', { class: 'fb-form', novalidate: '', dataset: { feedbackForm: '' } },
  card('role', 1, chips(ROLES, C.roles, { multi: false, id: 'role' })),
  card('mood', 2, moods()),
  card('felt_like', 3, chips(FELT_LIKE.map(([k]) => k), C.feltLike, { multi: true, id: 'felt_like', icons: Object.fromEntries(FELT_LIKE) }), { hint: C.pickAny }),
  card('easy', 4, slider('easy')), card('real', 5, slider('real')), card('fair', 6, slider('fair')), card('use', 7, slider('use')),
  card('comment', null, comment, { optional: true }),
  el('p', { class: 'fb-privacy' }, icon('lock', 20), bi(C.privacy)),
  failed, commentFailed, submit);
form.addEventListener('submit', (e) => e.preventDefault());

const thanks = el('section', { class: 'fb-state fb-thanks', hidden: '', dataset: { thanks: '' } },
  faceNode(moodFace('excited'), 'fb-face fb-face-big'), el('h1', { class: 'fb-state-title' }, bi(C.thanks)), bi(C.thanksLine, 'fb-state-line'));
const closed = el('section', { class: 'fb-state fb-closed', hidden: '', dataset: { closed: '' } },
  icon('clock', 40), el('h1', { class: 'fb-state-title' }, bi(C.closed)));
root.append(header, bar, form, thanks, closed);

const answered = () => REQUIRED.filter((k) => (k === 'felt_like' ? answers.felt_like.size > 0 : answers[k] !== undefined));

let busy = false;
function changed() {
  const n = answered().length;
  header.querySelector('[data-progress]').replaceChildren(bi(fill(C.progress, { n })));
  bar.firstElementChild.style.transform = `scaleX(${n / REQUIRED.length})`;
  bar.setAttribute('aria-valuenow', String(n));
  for (const q of form.querySelectorAll('.fb-q')) q.classList.toggle('done', REQUIRED.includes(q.dataset.q) && answered().includes(q.dataset.q));
  submit.disabled = busy || n < REQUIRED.length;
}

/** Shows one of the page's states and hides the others: the form, the thanks, or the closed notice. */
function show(state) {
  header.hidden = bar.hidden = state !== 'form';
  form.hidden = state !== 'form';
  thanks.hidden = state !== 'thanks';
  closed.hidden = state !== 'closed';
}

/** The body the backend takes (FeedbackSchema, strict): no field beyond these, so none can name a play or a person. */
function body(withComment) {
  const text = comment.value.trim();
  return {
    form: FORM,
    ...(link.caseId ? { case_id: link.caseId } : {}),
    answers: {
      role: answers.role, mood: answers.mood,
      felt_like: FELT_LIKE.map(([k]) => k).filter((k) => answers.felt_like.has(k)),
      easy: answers.easy, real: answers.real, fair: answers.fair, use: answers.use,
    },
    ...(withComment && text ? { comment: text } : {}),
  };
}

async function send(withComment = true) {
  if (busy || answered().length < REQUIRED.length) return;
  busy = true;
  submit.disabled = true;
  submit.firstElementChild.replaceChildren(bi(C.busy));
  failed.hidden = commentFailed.hidden = true;
  submit.hidden = false;
  for (const b of [retry, without]) b.disabled = true;
  try {
    await api.post('/booth/feedback', body(withComment), { timeoutMs: POST_MS });
    try { sessionStorage.setItem(SENT_KEY, '1'); } catch { /* a private tab may refuse; the page still says thanks */ }
    show('thanks');
  } catch (e) {
    if (e?.reason === 'closed' || e?.status === 403) show('closed');
    else if (e?.reason === 'comment_unavailable') { commentFailed.hidden = false; submit.hidden = true; }
    else { failed.hidden = false; }
  } finally {
    busy = false;
    for (const b of [retry, without]) b.disabled = false;
    submit.firstElementChild.replaceChildren(bi(C.submit));
    changed();
  }
}

submit.addEventListener('click', () => send(true));
retry.addEventListener('click', () => send(true));
without.addEventListener('click', () => { comment.value = ''; send(false); });

changed();
let sent = false;
try { sent = sessionStorage.getItem(SENT_KEY) === '1'; } catch { /* no storage: ask again */ }
if (sent) {
  show('thanks');
} else {
  show('form');
  // The booth's open state, from the feedback route's own budget (not /booth/status, the kiosk's). When it cannot be
  // read the form stays: a send tells the truth.
  api.get('/booth/feedback', { timeoutMs: GET_MS }).then((r) => { if (r?.open === false) show('closed'); }).catch(() => {});
}
