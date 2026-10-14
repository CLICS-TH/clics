// Inline reasoning markup — the ONE definition of what a local model's reply may show and return.
//
// PACKAGE-FREE ON PURPOSE, like lib/composite.js: no require() at all. The production transport
// (services/providers/local-factory.js) re-exports these, and the probe/quality harness
// (scripts/probe/lib.mjs) imports this file directly — the harness CI job has no `npm install`, and
// local-factory.js pulls in provider-settings.js, which validates env at load. One definition, so a
// measurement judges exactly the text production would return.
//
// A reasoning model served WITHOUT a reasoning parser (vLLM / SGLang `--reasoning-parser`) returns
// its chain-of-thought INSIDE `content`, wrapped in <think>…</think>, instead of in the separate
// reasoning_content field (which the transport already drops). Left alone it would be shown to the
// physician, stored in the transcript, and fed to the evaluator as if the model had meant it. On a
// correctly configured server none of this ever matches, and a reply with no tag is returned
// byte-identical. The real fix is server-side: run the server with `--reasoning-parser`.
//
// PRE-OPENED BLOCKS. Some chat templates open the block INSIDE THE PROMPT (DeepSeek-R1, Qwen3
// Thinking-2507), so the reply is `…reasoning…</think>answer` with no opening tag. Nothing can tell
// that reasoning from an answer until the `</think>` arrives. `preopened: true` (the
// <PREFIX>THINK_PREOPENED=1 knob) declares the template does this: the reply STARTS inside a
// reasoning block, so nothing is returned or streamed until the first `</think>`.
const OPEN = '<think>';
const CLOSE = '</think>';
const HAS_THINK_MARKUP = /<\/?think>/i;
const CLOSE_RE = /<\/think>/i;

// An env flag. Lenient on purpose — a typo'd "true" must not quietly mean "show the reasoning".
function flagOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

// Does the text ever close a reasoning block? With `preopened`, a reply that never does was reasoning
// from the first byte to the last: there is no answer in it to return.
function closesThink(text) {
  return typeof text === 'string' && CLOSE_RE.test(text);
}

/**
 * The rule for every reply that is RETURNED (non-streamed, and the final text of a streamed one).
 *
 * preopened false (default):
 *   1. a closing tag with no opening tag before it: the template opened the block in the prompt, so
 *      everything up to and including that first </think> is reasoning;
 *   2. every complete <think>…</think> block (and the whitespace after it) is removed;
 *   3. any other stray </think> token is removed;
 *   4. a <think> that is never closed (cut off mid-thought) drops everything after it.
 * preopened true: the reply starts inside a block — everything up to and including the first
 *   </think> (and the whitespace after it) is reasoning, then rules 2–4 apply. No </think> at all
 *   returns '' (the caller decides what an all-reasoning reply means; the transport makes it an error).
 */
function stripThink(text, { preopened = false } = {}) {
  if (typeof text !== 'string') return text;
  let out = text;
  if (preopened) {
    const close = out.search(CLOSE_RE);
    if (close === -1) return '';
    out = out.slice(close + CLOSE.length).replace(/^\s+/, '');
  } else {
    if (!HAS_THINK_MARKUP.test(out)) return out;
    const firstClose = out.search(CLOSE_RE);
    const firstOpen = out.search(/<think>/i);
    if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
      out = out.slice(firstClose + CLOSE.length).replace(/^\s+/, '');
    }
  }
  if (!HAS_THINK_MARKUP.test(out)) return out;
  out = out.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  out = out.replace(/<\/think>\s*/gi, '');
  const open = out.search(/<think>/i);
  return open === -1 ? out : out.slice(0, open);
}

/**
 * The streaming twin of stripThink: decides, piece by piece, what may be SHOWN. Text inside a block
 * is never emitted; a possible partial tag at the end of a piece ("…<thi") is held until the next
 * piece shows whether it is one, so the decision is never made on half a tag.
 *
 * What is withheld, exactly:
 *   * a <think>…</think> block the model writes itself — always;
 *   * with `preopened`, everything before the first </think> — always (nothing is shown until it);
 *   * WITHOUT `preopened`, a pre-opened block's reasoning is withheld only while it is still in the
 *     piece that carries the </think>. Pieces already emitted before that tag looked like an answer
 *     and cannot be recalled: that is the one case the stream shows reasoning, `sawOrphanLeak()`
 *     reports it, and the cure is `preopened` (or, properly, the server's --reasoning-parser).
 * Whenever nothing was leaked, the concatenation of what it emits equals stripThink(whole reply).
 *
 * `onThink()` fires when reasoning starts (each block opened; with `preopened`, the first piece).
 * `onOrphanClose({ leaked })` fires once, at the first closing tag that had no opening one.
 */
function createThinkFilter({ emit, onThink, onOrphanClose, preopened = false }) {
  let inside = !!preopened;
  let sawOpen = !!preopened;        // a pre-opened block counts as opened: its </think> is not an orphan
  let announcePreopen = !!preopened;
  let held = '';          // a possible partial tag withheld from the end of the previous piece
  let skipWs = false;     // drop whitespace right after a removed tag (stripThink's trailing \s*)
  let shownText = false;  // non-whitespace has already gone out
  let sawOrphanClose = false;
  let sawOrphanLeak = false;

  const show = (t) => {
    if (!t) return;
    if (/\S/.test(t)) shownText = true;
    emit(t);
  };

  // Length of the longest tail of `s` that is a proper prefix of one of `tags`.
  function partialTail(s, tags) {
    const lower = s.toLowerCase();
    let best = 0;
    for (const tag of tags) {
      for (let n = Math.min(tag.length - 1, lower.length); n > best; n--) {
        if (tag.startsWith(lower.slice(-n))) { best = n; break; }
      }
    }
    return best;
  }

  function push(piece) {
    if (announcePreopen && piece) { announcePreopen = false; onThink?.(); }
    let buf = held + piece;
    held = '';
    let out = '';
    while (buf) {
      if (inside) {
        const j = buf.toLowerCase().indexOf(CLOSE);
        if (j === -1) { held = buf.slice(buf.length - partialTail(buf, [CLOSE])); break; }
        inside = false;
        skipWs = true;
        buf = buf.slice(j + CLOSE.length);
        continue;
      }
      if (skipWs) {
        const ws = buf.match(/^\s*/)[0];
        buf = buf.slice(ws.length);
        if (!buf) break;
        skipWs = false;
      }
      const lower = buf.toLowerCase();
      const i = lower.indexOf(OPEN);
      const k = lower.indexOf(CLOSE);
      if (i !== -1 && (k === -1 || i < k)) {
        out += buf.slice(0, i);
        inside = true;
        sawOpen = true;
        onThink?.();
        buf = buf.slice(i + OPEN.length);
        continue;
      }
      if (k !== -1) {
        if (!sawOpen && !sawOrphanClose) {
          // Rule 1's orphan: everything before it was reasoning. What is still in THIS piece is
          // dropped; what earlier pieces already showed is the leak, and is only reported.
          sawOrphanClose = true;
          sawOrphanLeak = shownText;
          out = '';
          onOrphanClose?.({ leaked: sawOrphanLeak });
        } else {
          out += buf.slice(0, k);   // rule 3: a stray token after an opened block is just removed
        }
        skipWs = true;
        buf = buf.slice(k + CLOSE.length);
        continue;
      }
      const keep = partialTail(buf, [OPEN, CLOSE]);
      out += buf.slice(0, buf.length - keep);
      held = buf.slice(buf.length - keep);
      break;
    }
    show(out);
  }

  // The reply is complete: a withheld partial tag was just text after all, unless it sits inside an
  // unterminated block (rule 4, or a pre-opened block never closed), in which case it was reasoning
  // like everything around it. (Text is only ever withheld outside a block once skipWs has been
  // consumed, so there is no whitespace rule left to apply here.)
  function end() {
    const rest = held;
    held = '';
    if (!inside) show(rest);
  }

  return { push, end, sawOrphanClose: () => sawOrphanClose, sawOrphanLeak: () => sawOrphanLeak };
}

module.exports = { stripThink, createThinkFilter, closesThink, flagOn, OPEN, CLOSE };
