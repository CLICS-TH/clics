"use client"

import * as React from "react"

// Keyboard behaviour every modal dialog needs and a bare `<div role="dialog">` does not give you:
//   * focus moves INTO the dialog on open (to [data-autofocus] if present, else the first control),
//   * Tab / Shift+Tab are trapped inside it,
//   * Escape closes it,
//   * on close, focus returns to whatever opened it.
// `aria-modal="true"` only tells assistive tech the rest of the page is inert; it moves nothing.
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden],[aria-hidden='true']")
  )
}

export function useDialog(
  ref: React.RefObject<HTMLElement | null>,
  opts: {
    onEscape?: () => void
    /** Runs for every other keydown while the dialog is open (e.g. an Enter policy). */
    onKey?: (e: KeyboardEvent) => void
  }
) {
  const onEscape = React.useEffectEvent(() => opts.onEscape?.())
  const onKey = React.useEffectEvent((e: KeyboardEvent) => opts.onKey?.(e))

  React.useEffect(() => {
    const root = ref.current
    if (!root) return
    // Captured BEFORE focus moves, so closing can put the person back where they were.
    const opener = document.activeElement as HTMLElement | null
    const start = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root)[0] ?? root
    start.focus()

    function handle(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        onEscape()
        return
      }
      if (e.key === "Tab") {
        const items = focusables(root!)
        if (items.length === 0) {
          e.preventDefault()
          root!.focus()
          return
        }
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (!active || !root!.contains(active)) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && (active === first || active === root)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
        return
      }
      onKey(e)
    }
    document.addEventListener("keydown", handle, true)
    return () => {
      document.removeEventListener("keydown", handle, true)
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus()
    }
  }, [ref])
}
