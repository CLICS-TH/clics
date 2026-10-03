"use client";

// Themed toast + confirm dialog — replaces the browser's raw confirm()/alert() (which can't be
// themed or translated). Imperative API from anywhere: `toast(msg, type)` and
// `await confirmDialog({...})`. A single <Overlays/> is mounted in the root layout.
import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDialog } from "@/components/ui/use-dialog";
import { cn } from "@/lib/utils";

type ToastType = "success" | "error" | "info";
type Toast = { id: number; msg: string; type: ToastType };
type Confirm = {
  id: number;
  title?: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
};

let state: { toasts: Toast[]; confirms: Confirm[] } = { toasts: [], confirms: [] };
let seq = 1;
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function set(next: typeof state) {
  state = next;
  emit();
}

export function toast(msg: string, type: ToastType = "info") {
  const t: Toast = { id: seq++, msg, type };
  set({ ...state, toasts: [...state.toasts, t] });
  setTimeout(() => set({ ...state, toasts: state.toasts.filter((x) => x.id !== t.id) }), type === "error" ? 4500 : 3000);
}

export function confirmDialog(opts: Omit<Confirm, "id" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    const c: Confirm = { ...opts, id: seq++, resolve };
    set({ ...state, confirms: [...state.confirms, c] });
  });
}

function closeConfirm(c: Confirm, val: boolean) {
  c.resolve(val);
  set({ ...state, confirms: state.confirms.filter((x) => x.id !== c.id) });
}

// One confirm dialog. Mounted per confirm (keyed by id) so the focus handling in useDialog opens and
// closes with it.
//
// Keyboard contract (a destructive confirm must not be one stray Enter away):
//   * focus starts on Cancel — the safe choice — not on the action,
//   * Tab is trapped inside, Escape cancels, focus returns to the opener,
//   * Enter activates the focused BUTTON, as the browser does natively: Enter on Cancel cancels, Enter
//     on OK confirms. It used to be a global shortcut that confirmed regardless of focus, so Enter on a
//     focused Cancel confirmed — including danger dialogs.
//   * Enter with focus on the dialog itself (not a button) confirms only a NON-danger dialog.
function ConfirmDialog({ c }: { c: Confirm }) {
  const panel = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const bodyId = React.useId();
  useDialog(panel, {
    onEscape: () => closeConfirm(c, false),
    onKey: (e) => {
      if (e.key !== "Enter") return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("button, a, input, textarea, select")) return; // native activation / typing
      e.preventDefault();
      if (!c.danger) closeConfirm(c, true);
    },
  });
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-5"
      onClick={(e) => { if (e.target === e.currentTarget) closeConfirm(c, false); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={c.title ? titleId : undefined}
        aria-label={c.title ? undefined : "ยืนยัน / Confirm"}
        aria-describedby={c.body ? bodyId : undefined}
        tabIndex={-1}
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-7 shadow-pop"
      >
        {c.title && <h2 id={titleId} className="font-heading mb-2 text-xl sm:text-2xl text-foreground">{c.title}</h2>}
        {c.body && <div id={bodyId} className="mb-6 text-sm leading-relaxed text-muted-foreground">{c.body}</div>}
        <div className="flex justify-end gap-2.5">
          <Button variant="ghost" data-autofocus onClick={() => closeConfirm(c, false)}>
            {c.cancelLabel || "ยกเลิก / Cancel"}
          </Button>
          <Button variant={c.danger ? "destructive" : "default"} onClick={() => closeConfirm(c, true)}>
            {c.confirmLabel || "ยืนยัน / Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Overlays() {
  const s = React.useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state
  );
  const top = s.confirms[s.confirms.length - 1];

  return (
    <>
      <div className="pointer-events-none fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
        {s.toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex max-w-[90vw] items-center gap-2 rounded-full px-4 py-2.5 text-sm shadow-pop",
              t.type === "error" ? "bg-destructive text-white" : "bg-foreground text-background"
            )}
          >
            {t.type === "success" && <Check className="size-4" />}
            {t.msg}
          </div>
        ))}
      </div>

      {top && <ConfirmDialog key={top.id} c={top} />}
    </>
  );
}
