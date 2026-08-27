"use client";
import { memo } from "react";
import { Paperclip, HelpCircle } from "lucide-react";
import { Markdown } from "@/components/Markdown";

interface Message {
  role: string;
  content: string;
  refs?: { source: string; title?: string }[];
  socratic_question?: string;
}

// Strip clinical-artifact fences but KEEP the inner markdown, so the auditor reads the artifact body
// (DDx table / care plan) the physician saw — never the raw `:::artifact{...}` control syntax.
// Keep this regex in sync with rimpl/src/lib/transcript.js and physician-ui/public/js/artifacts.js.
const stripArtifactFences = (s: string) =>
  s.replace(/^:::artifact\{[^}\n]*\}[ \t]*\n?/gm, "").replace(/^:::[ \t]*$/gm, "");

// Physician-grade transcript (#8): the auditor scores the high-stakes read, so render the AI's
// markdown the same way the physician saw it — not a stripped plain-text bubble.
// memo: `messages` is stable after load, so the rater's chip taps / notes keystrokes (which re-render
// the parent) don't re-run the react-markdown pipeline over the whole transcript each time.
export const TranscriptView = memo(function TranscriptView({ messages }: { messages: Message[] }) {
  return (
    <div className="max-h-[72dvh] space-y-3 overflow-y-auto rounded-lg bg-secondary p-4">
      {messages.map((m, i) => {
        const isPhysician = m.role === "physician";
        // Strip artifact fences (keep the body); assistant content also carries a trailing "❓ …"
        // Socratic line — strip that too, it's shown separately.
        const body = isPhysician
          ? stripArtifactFences(m.content)
          : stripArtifactFences(m.content).replace(/\n❓[^\n]*$/, "").trim();
        return (
          <div
            key={i}
            className={
              isPhysician
                ? "ml-auto max-w-[85%] rounded-xl bg-coral-active p-3 text-sm text-white"
                : "max-w-[92%] rounded-xl border border-border bg-card p-4"
            }
          >
            {isPhysician ? <p className="whitespace-pre-wrap text-sm">{body}</p> : <Markdown>{body}</Markdown>}
            {m.refs?.length ? (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Paperclip className="size-3.5 shrink-0" />
                {m.refs.map((r) => r.source ?? r.title).join(" · ")}
              </p>
            ) : null}
            {m.socratic_question && (
              <p className="mt-2 flex items-start gap-1.5 text-xs italic text-link">
                <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
                {m.socratic_question}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
});
