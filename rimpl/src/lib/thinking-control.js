'use strict';

// How a request's optional `thinking` flag becomes request-body fields on an OpenAI-compatible server
// — the ONE definition, used by the production transport (services/providers/local-factory.js) and by
// the probe/quality harness (scripts/probe/lib.mjs), so an audit arm that asks for "deep" sends the
// server exactly what rimpl would.
//
// PACKAGE-FREE ON PURPOSE, like lib/think-markup.js: no require() at all. The harness CI job has no
// `npm install`, and local-factory.js pulls in provider-settings.js, which validates env at load.
//
// `thinking` is true/false or { enabled, budget? }; anything else means "the caller did not ask", and is
// the ONLY case in which a request is byte-identical to one sent before the field existed. How it is
// sent depends on the SERVER:
//   none (default — send nothing, ever)
//   chat_template_kwargs  (vLLM / SGLang: { chat_template_kwargs: { enable_thinking } })
//   ollama                (Ollama: { think })
// `budget` is accepted for the caller's interface, but none of these has a portable field for it, so it
// is not sent; the reply's max_tokens is the only bound (reasoning tokens count against it).
const THINKING_STYLES = ['none', 'chat_template_kwargs', 'ollama'];

/** true / false when the caller asked for thinking on / off, null when it did not ask. */
function thinkingEnabled(thinking) {
  if (typeof thinking === 'boolean') return thinking;
  if (thinking && typeof thinking === 'object' && typeof thinking.enabled === 'boolean') return thinking.enabled;
  return null;
}

/** A raw <PREFIX>THINKING_STYLE value as a known style; unset is 'none', an unknown value is null. */
function parseThinkingStyle(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'none';
  return THINKING_STYLES.includes(s) ? s : null;
}

/** The body fields that carry `thinkingOn` (true/false) under `style`; {} for 'none' or a null ask. */
function thinkingFields(style, thinkingOn) {
  if (thinkingOn !== true && thinkingOn !== false) return {};
  if (style === 'chat_template_kwargs') return { chat_template_kwargs: { enable_thinking: thinkingOn } };
  if (style === 'ollama') return { think: thinkingOn };
  return {};
}

module.exports = { THINKING_STYLES, thinkingEnabled, parseThinkingStyle, thinkingFields };
