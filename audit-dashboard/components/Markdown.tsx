"use client";

// Physician-grade transcript renderer (#8): the auditor scores the high-stakes read, so it deserves
// the same rich markdown the physician saw — not a stripped whitespace-pre-wrap bubble. react-markdown
// builds a React tree (no dangerouslySetInnerHTML; raw HTML in the source is shown as text), so AI
// output stays XSS-safe.
//
// Three rules on top of that, because this renders text an AI wrote:
//   * Images are never rendered or fetched. react-markdown renders `![x](url)` as a real <img> (and
//     React preloads it), so a reply could make the auditor's browser fetch an arbitrary remote URL.
//     Verified, not assumed. The ALT text is kept as plain text so the words are not silently lost.
//   * Headings are shifted so the highest level inside a reply is h3: a reply must never outrank the
//     page's own h1/h2 in the outline a screen reader navigates by.
//   * Tables and code blocks scroll inside a focusable, labelled group — a keyboard user cannot scroll
//     an overflow box that cannot take focus. role=group, not region: a long reply would otherwise add
//     a landmark per table (matches the physician portal).
// Link behaviour is deliberately unchanged.
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Visual style per ORIGINAL level (what the author meant), applied to the SHIFTED element.
const H1 = "mt-5 mb-2 font-sans text-base font-semibold";
const H2 = "mt-4 mb-1.5 font-sans text-[15px] font-semibold";
const H3 = "mt-3 mb-1 font-sans text-sm font-semibold";

// react-markdown passes the hast `node` to every override; spreading it onto a DOM element would emit
// a `node="[object Object]"` attribute, so drop it.
function clean<T extends { node?: unknown }>(p: T): Omit<T, "node"> {
  const rest = { ...p };
  delete rest.node;
  return rest;
}

// h1->h3, h2->h4, h3->h5, h4..h6->h6.
const COMPONENTS: Components = {
  h1: (p) => <h3 className={H1} {...clean(p)} />,
  h2: (p) => <h4 className={H2} {...clean(p)} />,
  h3: (p) => <h5 className={H3} {...clean(p)} />,
  h4: (p) => <h6 className={H3} {...clean(p)} />,
  h5: (p) => <h6 className={H3} {...clean(p)} />,
  h6: (p) => <h6 className={H3} {...clean(p)} />,
  table: (p) => (
    <div
      role="group"
      tabIndex={0}
      aria-label="ตาราง / Table"
      className="my-3 max-w-full overflow-x-auto"
    >
      <table
        className="w-full border-collapse text-[13px] [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-2 [&_td]:align-top"
        {...clean(p)}
      />
    </div>
  ),
  // The src is never used: no <img>, no preload, no request. Only the alt survives, as text.
  img: ({ alt }) => (alt ? <span data-md-img-alt="">{alt}</span> : null),
  pre: (p) => (
    <pre role="group" tabIndex={0} aria-label="โค้ด / Code" {...clean(p)} />
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div
      className="text-sm leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0
        [&_p]:my-2.5 [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5
        [&_li]:my-1.5 [&_li]:marker:text-primary [&_strong]:font-semibold [&_strong]:text-foreground
        [&_hr]:my-4 [&_hr]:border-border [&_a]:text-coral-on-tint [&_a]:underline
        [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground
        [&_code]:rounded [&_code]:border [&_code]:border-border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]
        [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-3
        [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
