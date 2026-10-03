import * as React from "react"
import { Bot } from "lucide-react"

import { cn } from "@/lib/utils"
import { AI_LABEL } from "@/lib/ai-label"

// "An AI wrote this." Slate-blue --ai-* surface, an explicit text label (colour alone is never the
// only signal) and a labelled group so a screen reader hears the source before the content.
//
// Colour law across the dashboard: coral = the human auditor, slate-blue = the AI, violet = the peer
// cohort. Nothing a person wrote goes in here, and nothing an AI wrote stays outside it.
//
// DISPLAY ONLY. Whether an AI score or reply may be shown at all is enforced by the server (blind
// scoring, the calibration reveal lock); this component never decides that.
function AiOutput({
  label = AI_LABEL.chip,
  variant = "block",
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  /** Visible source label. Defaults to the shared AI_LABEL.chip. */
  label?: string
  /** block = a card-sized region; bubble = one chat message. */
  variant?: "block" | "bubble"
  children: React.ReactNode
}) {
  const labelId = React.useId()
  return (
    <div
      data-slot="ai-output"
      data-variant={variant}
      role="group"
      aria-labelledby={labelId}
      className={cn(
        "border border-ai-border bg-ai-bg text-ai-text",
        variant === "block" ? "rounded-xl p-5" : "rounded-lg px-3 py-2",
        className
      )}
      {...props}
    >
      <p id={labelId} className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
        <Bot className="size-3.5 shrink-0" aria-hidden="true" />
        {label}
      </p>
      {children}
    </div>
  )
}

export { AiOutput }
