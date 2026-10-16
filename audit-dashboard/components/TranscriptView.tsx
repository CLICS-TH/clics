"use client";
import { memo } from "react";
import { Paperclip, HelpCircle } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { AiOutput } from "@/components/ui/ai-output";

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
    // CONFIDENTIALITY GUARD. Both the approved assessment form and the calibration plan state that
    // raters may not screenshot, download, copy or forward transcript content, and every rater
    // acknowledges that in writing before scoring. Nothing enforced it.
    //
    // Scoped to the transcript, deliberately not to the page: the rater must still be able to select
    // and copy their own comment text, and a page-wide guard would take that with it. This stops the
    // casual route — select-and-copy, right-click-save, drag-out. It cannot stop a determined person
    // with a phone camera, and is not meant to; it is the difference between an accidental breach of
    // an undertaking someone signed and a deliberate one.
    <div
      className="max-h-[72dvh] space-y-3 overflow-y-auto rounded-lg bg-secondary p-4 select-none"
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      data-no-copy="transcript"
    >
      {messages.map((m, i) => {
        const isReflection = m.role === "reflection";
        const isPhysician = m.role === "physician" || isReflection;
        // Strip artifact fences (keep the body); assistant content also carries a trailing "❓ …"
        // Socratic line — strip that too, it's shown separately.
        const body = isPhysician
          ? stripArtifactFences(m.content)
          : stripArtifactFences(m.content).replace(/\n❓[^\n]*$/, "").trim();
        const extras = (
          <>
            {m.refs?.length ? (
              // On the physician's solid-coral bubble muted-foreground is 1.08:1; plain white is 5.06:1.
              <p className={`mt-2 flex items-center gap-1.5 text-xs ${isPhysician ? "text-white" : "text-muted-foreground"}`}>
                <Paperclip className="size-3.5 shrink-0" />
                {m.refs.map((r) => r.source ?? r.title).join(" · ")}
              </p>
            ) : null}
            {m.socratic_question && (
              // text-coral-on-tint, not text-link: link is 4.24:1 on the AI surface, this is 6.08:1.
              <p className={`mt-2 flex items-start gap-1.5 text-sm italic ${isPhysician ? "text-white" : "text-coral-on-tint"}`}>
                <HelpCircle className="mt-1 size-4 shrink-0" />
                {m.socratic_question}
              </p>
            )}
          </>
        );
        // The person's own turns stay solid coral (human = coral). Everything the AI wrote is an
        // AiOutput: slate-blue surface plus an explicit "AI" label, so the two voices are never told
        // apart by colour alone.
        return isPhysician ? (
          <div key={i} className="ml-auto max-w-[85%] rounded-xl bg-coral-active p-3 text-sm text-white">
            {isReflection ? (
              <p className="mb-1 text-xs font-semibold text-white">
                การสะท้อนคิดของแพทย์ / Physician reflection
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm">{body}</p>
            {extras}
          </div>
        ) : (
          <AiOutput key={i} variant="bubble" className="max-w-[92%] rounded-xl p-4">
            <Markdown>{body}</Markdown>
            {extras}
          </AiOutput>
        );
      })}
    </div>
  );
});
