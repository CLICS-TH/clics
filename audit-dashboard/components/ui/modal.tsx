"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { useDialog } from "@/components/ui/use-dialog"

// A modal form panel with the keyboard behaviour a bare `<div role="dialog">` lacks: focus moves in,
// Tab is trapped, Escape closes, focus returns to the opener, and the dialog has an accessible name.
// For yes/no confirmations use confirmDialog() from Overlays instead; this is for panels that hold
// their own controls (e.g. the auditor consent form).
//
// The backdrop does NOT close it: a consent form is a deliberate act, not something to dismiss with a
// stray click. Escape and the panel's own Cancel button are the exits.
function Modal({
  title,
  onClose,
  children,
  className,
}: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  className?: string
}) {
  const panel = React.useRef<HTMLDivElement>(null)
  const titleId = React.useId()
  useDialog(panel, { onEscape: onClose })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "max-h-[90dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl border bg-background p-6",
          className
        )}
      >
        <h2 id={titleId} className="font-heading text-xl">
          {title}
        </h2>
        {children}
      </div>
    </div>
  )
}

export { Modal }
