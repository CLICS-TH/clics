"use client";

// Themed toast + confirm dialog — replaces the browser's raw confirm()/alert() (which can't be
// themed or translated). Imperative API from anywhere: `toast(msg, type)` and
// `await confirmDialog({...})`. A single <Overlays/> is mounted in the root layout.
import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  React.useEffect(() => {
    if (!top) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); closeConfirm(top, false); }
      else if (e.key === "Enter") { e.preventDefault(); closeConfirm(top, true); }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [top]);

  return (
    <>
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
        {s.toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex max-w-[90vw] items-center gap-2 rounded-full px-4 py-2.5 text-sm shadow-lg",
              t.type === "error" ? "bg-destructive text-white" : "bg-foreground text-background"
            )}
          >
            {t.type === "success" && <Check className="size-4" />}
            {t.msg}
          </div>
        ))}
      </div>

      {top && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-5"
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) closeConfirm(top, false); }}
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-7 shadow-2xl">
            {top.title && <h2 className="font-heading mb-2 text-2xl text-foreground">{top.title}</h2>}
            {top.body && <div className="mb-6 text-sm leading-relaxed text-muted-foreground">{top.body}</div>}
            <div className="flex justify-end gap-2.5">
              <Button variant="ghost" onClick={() => closeConfirm(top, false)}>
                {top.cancelLabel || "ยกเลิก / Cancel"}
              </Button>
              <Button variant={top.danger ? "destructive" : "default"} onClick={() => closeConfirm(top, true)}>
                {top.confirmLabel || "ยืนยัน / Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
