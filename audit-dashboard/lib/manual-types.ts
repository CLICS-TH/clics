// The shape of lib/manual-content.ts, which is generated from docs/manuals/content/auditor.*.md.
//
// It mirrors the block AST in scripts/manuals/lib/parse.mjs. The two are hand-kept in sync, the same
// way lib/pis7-rubric.ts mirrors rimpl/src/lib/prompts.js — and, like that pair, a drift is caught
// rather than trusted: the generated file is typed as ManualContent, so a block the parser starts
// emitting that this union does not describe fails `tsc --noEmit`.

/** Inline run. `chip` is a UI label quoted verbatim from the product; `chip-neutral` is a secondary control. */
export type Span =
  | { t: 'text'; v: string }
  | { t: 'b'; v: string }
  | { t: 'chip'; v: string }
  | { t: 'chip-neutral'; v: string };

export type CalloutKind = 'note' | 'tip' | 'warn';

export type Block =
  | { t: 'h3'; text: string }
  | { t: 'p'; spans: Span[] }
  | { t: 'lead'; spans: Span[] }
  | { t: 'ul'; items: Span[][] }
  // Numbered: the order is instruction, not decoration, so it is a distinct type from `ul`.
  | { t: 'steps'; items: Span[][] }
  | { t: 'callout'; kind: CalloutKind; head: string | null; spans: Span[] }
  | { t: 'figure'; src: string; alt: string; caption: string | null }
  | { t: 'table'; head: string[]; rows: string[][] };

export type Section = { id: string; title: string; blocks: Block[] };

/** `en` is optional so the Thai manual can ship before its translation exists. */
export type ManualContent = { th: readonly Section[]; en?: readonly Section[] };

export type ManualLang = 'th' | 'en';
