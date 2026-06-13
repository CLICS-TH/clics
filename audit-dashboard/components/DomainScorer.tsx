"use client";

// Rubric-anchored PIS-7 scorer (#11 — protect ICC at the source). Replaces the 0–5 slider whose only
// labels were the endpoints: every level is a tappable chip carrying the shared scale anchor, and a
// descriptor panel shows the domain criterion + the selected level — so every rater scores against the
// SAME definition the AI uses. An unset domain stays visibly "to score" (no silent 0 default).
import { PIS7_RUBRIC, PIS7_SCALE, PIS7_EVIDENCE_NOTE } from "@/lib/pis7-rubric";
import { WEIGHTS } from "@/lib/labels";
import { BiLabel } from "@/components/BiLabel";
import { cn } from "@/lib/utils";

interface Props {
  scores: Record<string, number | null>;
  onChange: (key: string, value: number) => void;
  disabled?: boolean;
}

export function DomainScorer({ scores, onChange, disabled }: Props) {
  return (
    <div className="space-y-5">
      {PIS7_RUBRIC.map((d) => {
        const val = scores[d.key];
        const picked = typeof val === "number";
        const anchor = picked ? PIS7_SCALE[val] : null;
        return (
          <div key={d.key} className={cn("rounded-lg border p-4", !picked && !disabled && "border-dashed")}>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <BiLabel th={d.th} en={d.en} className="text-sm font-medium" />
              <span className="shrink-0 text-xs text-muted-foreground">
                {Math.round(WEIGHTS[d.key] * 100)}%
                {picked ? <> · <strong className="text-foreground tabular-nums">{val}/5</strong></> : <> · <span className="text-coral-active">ยังไม่ให้คะแนน</span></>}
              </span>
            </div>
            <div className="grid grid-cols-6 gap-1.5" role="radiogroup" aria-label={`${d.en} (0–5)`}>
              {PIS7_SCALE.map((s) => (
                <button
                  key={s.level}
                  type="button"
                  role="radio"
                  aria-checked={val === s.level}
                  aria-label={`${s.level} — ${s.en}`}
                  disabled={disabled}
                  onClick={() => onChange(d.key, s.level)}
                  className={cn(
                    "rounded-md border py-2 text-sm font-semibold tabular-nums transition-colors disabled:opacity-60",
                    val === s.level
                      ? "border-coral-active bg-coral-active text-white"
                      : "border-border bg-background hover:bg-muted"
                  )}
                >
                  {s.level}
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex justify-between px-0.5 text-[11px] text-muted-foreground">
              <span>{PIS7_SCALE[0].th} · {PIS7_SCALE[0].en}</span>
              <span>{PIS7_SCALE[5].th} · {PIS7_SCALE[5].en}</span>
            </div>
            <div className="mt-3 rounded-md bg-muted/60 p-3 text-xs leading-relaxed">
              <p className="text-foreground">{d.criterion}</p>
              <p className="mt-1 text-muted-foreground">{d.floor}</p>
              {picked && anchor && (
                <p className="mt-2 border-l-2 border-coral-active pl-2 text-foreground">
                  <strong>{anchor.level} · {anchor.en}</strong>
                  {anchor.level >= 4 ? ` — ${PIS7_EVIDENCE_NOTE}` : ""}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
