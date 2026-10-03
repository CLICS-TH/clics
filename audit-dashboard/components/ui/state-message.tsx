import * as React from "react"
import { CircleAlert, Info, Lock } from "lucide-react"

import { cn } from "@/lib/utils"

// One component for the states a screen can be in besides "showing data". Each kind carries the ARIA
// role a screen reader needs, because a plain <p> announces nothing: a rater whose queue failed to
// load heard silence, and "no items" was indistinguishable from "still loading".
//
//   loading  role=status  muted line, never an empty gap
//   empty    role=status  muted line saying what is missing and (ideally) why
//   error    role=alert   interrupts: says what failed and offers Retry when a retry can help
//   locked   role=status  WITHHELD is not EMPTY — says what is hidden, why, and who opens it
//   notice   role=status  standing information (tinted)
//
// `locked` is display only. The server decides what is withheld (calibration reveal lock); the client
// renders the flag it was sent and never works around it.
export type StateKind = "loading" | "empty" | "error" | "locked" | "notice"

const ROLE: Record<StateKind, "status" | "alert"> = {
  loading: "status",
  empty: "status",
  error: "alert",
  locked: "status",
  notice: "status",
}

const TONE: Record<StateKind, string> = {
  loading: "text-muted-foreground",
  empty: "text-muted-foreground",
  error: "rounded-xl border border-error-text/30 bg-error-bg p-4 text-error-text",
  locked: "rounded-xl border border-border bg-secondary p-5 text-foreground",
  notice: "rounded-xl border border-notice-text/30 bg-notice-bg p-4 text-notice-text",
}

const ICON = { error: CircleAlert, locked: Lock, notice: Info } as const

export const RETRY_LABEL = "ลองใหม่ / Retry"

function StateMessage({
  kind,
  title,
  children,
  onRetry,
  retryLabel = RETRY_LABEL,
  heading,
  center = false,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  kind: StateKind
  /** The one-line statement of the state. Bilingual string, Thai first. */
  title: React.ReactNode
  /** Optional detail: why, and what the reader can do. */
  children?: React.ReactNode
  /** Renders a Retry button (error kind) wired to this handler. */
  onRetry?: () => void
  retryLabel?: string
  /** Render the title as a heading (e.g. "h2" for a locked panel) instead of a paragraph. */
  heading?: "h2" | "h3"
  center?: boolean
}) {
  const Icon = kind in ICON ? ICON[kind as keyof typeof ICON] : null
  const Title = heading ?? "p"
  return (
    <div
      data-slot="state-message"
      data-kind={kind}
      role={ROLE[kind]}
      className={cn(
        TONE[kind],
        kind === "loading" || kind === "empty" ? "py-10" : "",
        center && "text-center",
        className
      )}
      {...props}
    >
      <Title
        className={cn(
          "flex gap-2 leading-snug",
          center && "justify-center",
          heading ? "font-heading text-xl" : "font-medium",
          kind === "loading" || kind === "empty" ? "font-normal" : ""
        )}
      >
        {Icon && <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
        <span>{title}</span>
      </Title>
      {children && <div className="mt-2 text-sm leading-relaxed">{children}</div>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "mt-3 text-sm font-medium underline underline-offset-2",
            kind === "error" ? "text-error-text" : "text-link"
          )}
        >
          {retryLabel}
        </button>
      )}
    </div>
  )
}

export { StateMessage }
