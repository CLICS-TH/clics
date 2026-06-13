"use client";

// Physician-grade transcript renderer (#8): the auditor scores the high-stakes read, so it deserves
// the same rich markdown the physician saw — not a stripped whitespace-pre-wrap bubble. react-markdown
// builds a React tree (no dangerouslySetInnerHTML / no raw HTML), so AI output stays XSS-safe.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
  return (
    <div
      className="text-sm leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0
        [&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:font-sans [&_h1]:text-base [&_h1]:font-bold
        [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:font-sans [&_h2]:text-[15px] [&_h2]:font-bold
        [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-sans [&_h3]:text-sm [&_h3]:font-semibold
        [&_p]:my-2.5 [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5
        [&_li]:my-1.5 [&_li]:marker:text-primary [&_strong]:font-bold [&_strong]:text-foreground
        [&_hr]:my-4 [&_hr]:border-border [&_a]:text-primary [&_a]:underline
        [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground
        [&_code]:rounded [&_code]:border [&_code]:border-border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]
        [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px]
        [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-bold
        [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-2 [&_td]:align-top"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
