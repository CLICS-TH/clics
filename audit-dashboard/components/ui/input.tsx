import * as React from "react"

import { cn } from "@/lib/utils"

// Form controls on --field, the 3:1 border token. The bare `border` they used before resolved to
// --border (1.25:1 light), so the edge of a text box was effectively invisible: WCAG 1.4.11 asks 3:1
// for the boundary of a UI component. --border stays for decorative dividers.
//
// Border width is 1px in EVERY state (focus is drawn by the global :focus-visible outline, which is
// not part of the box), so the field never reflows or shifts its text when focused. Font size stays
// text-sm on fine pointers; the coarse-pointer floor in globals.css lifts it to 16px so iOS does not
// zoom on focus.
const FIELD =
  "w-full min-w-0 rounded-lg border border-field bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive"

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(FIELD, className)} {...props} />
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(FIELD, "leading-relaxed", className)} {...props} />
}

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="select" className={cn(FIELD, "pr-8", className)} {...props} />
}

// Native checkbox, accent in the button-fill coral so the checked box is white-on-5.06:1.
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn("size-4 shrink-0 accent-coral-active", className)}
      {...props}
    />
  )
}

export { Input, Textarea, Select, Checkbox }
