"use client";

// Rubric-anchored PIS-7 scorer (#11 — protect ICC at the source). Replaces the 0–5 slider whose only
// labels were the endpoints: every level is a tappable chip carrying the shared scale anchor, and a
// descriptor panel shows the domain criterion + the selected level — so every rater scores against the
// SAME definition the AI uses. An unset domain stays visibly "to score" (no silent 0 default).
import { PIS7_RUBRIC, PIS7_SCALE, PIS7_EVIDENCE_NOTE, PIS7_PRINCIPLE, COMMENT_EXPECTED_LEVELS } from "@/lib/pis7-rubric";
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
      {/* The governing principle, stated once where it cannot be missed. It is the difference
          between rating an episode and rating a physician. */}
      <p className="rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
        {PIS7_PRINCIPLE.th}
        <span className="mt-1 block">{PIS7_PRINCIPLE.en}</span>
      </p>
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
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" role="radiogroup" aria-label={`${d.en} (0–5)`}>
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
              <span>{PIS7_SCALE[0].shortTh} · {PIS7_SCALE[0].shortEn}</span>
              <span>{PIS7_SCALE[5].shortTh} · {PIS7_SCALE[5].shortEn}</span>
            </div>
            <div className="mt-3 rounded-md bg-muted/60 p-3 text-xs leading-relaxed">
              {/* The CREC-approved 0→3→5 anchors for THIS domain, always visible — a rater choosing
                  a 4 needs to see what a 3 and a 5 look like, not only what they picked. */}
              <div className="mb-2 grid gap-1 @min-[520px]:grid-cols-3">
                {([0, 3, 5] as const).map((lv, i) => (
                  <p key={lv} className={cn("rounded px-1.5 py-1", val === lv ? "bg-background text-foreground" : "text-muted-foreground")}>
                    <strong className="tabular-nums">{lv}</strong> {d.anchors.en[i]}
                  </p>
                ))}
              </div>
              <p className="text-foreground">{d.criterion}</p>
              <p className="mt-1 text-muted-foreground">{d.floor}</p>
              {picked && anchor && (
                <p className="mt-2 border-l-2 border-coral-active pl-2 text-foreground">
                  <strong>{anchor.level} · {anchor.shortEn}</strong> — {anchor.en}
                  {anchor.level >= 4 ? ` ${PIS7_EVIDENCE_NOTE}` : ""}
                </p>
              )}
              {/* "Comment ควรบันทึกเมื่อคะแนน extreme, borderline หรือ anchor ไม่ชัด" — the approved
                  document asks for a comment at the extremes. Prompted, never enforced: a rater
                  blocked from submitting will write "n/a" and the record is worse than silence. */}
              {picked && COMMENT_EXPECTED_LEVELS.includes(val) && (
                <p className="mt-2 text-coral-active">
                  ควรบันทึกเหตุผลสำหรับคะแนนนี้ / A comment is expected at this level.
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
