"use client";

// Rubric-anchored PIS-7 scorer (#11 — protect ICC at the source). Replaces the 0–5 slider whose only
// labels were the endpoints: every level is a tappable chip carrying the shared scale anchor, and a
// descriptor panel shows the domain criterion + the selected level — so every rater scores against the
// SAME definition the AI uses. An unset domain stays visibly "to score" (no silent 0 default).
import { PIS7_RUBRIC, PIS7_SCALE, PIS7_EVIDENCE_NOTE, PIS7_PRINCIPLE, COMMENT_EXPECTED_LEVELS } from "@/lib/pis7-rubric";
import { WEIGHTS } from "@/lib/labels";
import { BiLabel } from "@/components/BiLabel";
import { cn } from "@/lib/utils";

// How clear this domain's behavioural anchor was for THIS transcript. The approved assessment form
// asks it per domain, and the calibration workshop's stated output is a map of exactly this — where
// raters disagree and which anchors are ambiguous. The rubric may only be refined after the primary
// analysis, so if the judgement is not captured while it is being made it cannot be recovered later.
//
// MIRRORS backend/src/lib/schemas.js ANCHOR_CLARITY, which is also mirrored a THIRD time as the
// CHECK constraints in db/migration-auditor-assessment-form.sql. All three are checked against each
// other by __tests__/backend-mirrors.test.ts — a value that drifts here is accepted by the form and
// refused by the API, or accepted by the API and refused by the column.
export const ANCHOR_CLARITY = [
  { value: "clear", th: "ชัด", en: "Clear" },
  { value: "moderate", th: "ปานกลาง", en: "Moderate" },
  { value: "ambiguous", th: "ยาก/ก้ำกึ่ง", en: "Ambiguous" },
] as const;

const ANCHOR_VALUES = ANCHOR_CLARITY.map((a) => a.value);
const LEVELS = PIS7_SCALE.map((s) => s.level);

// Arrow-key navigation for a radiogroup, plus the roving tab stop that goes with it.
//
// A group announced as a radiogroup is operated with arrows, not Tab — that is what the role
// promises. Both groups below were Tab-and-Space only, so a screen-reader user who heard "radio
// group" pressed an arrow key and nothing happened. Applied to the score chips as well as the new
// anchor chips: the older group had the same gap, and fixing only the new one would be arbitrary.
function radioKeys<T>(values: readonly T[], current: T | null | undefined, pick: (v: T) => void) {
  return (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = values.findIndex((v) => v === current);
    // No selection yet: an arrow enters the group at the first option rather than doing nothing.
    const next = at < 0 ? 0 : (at + step + values.length) % values.length;
    pick(values[next]);
    // Focus follows the selection, or the visible ring stays on the option just left behind.
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
}

interface Props {
  scores: Record<string, number | null>;
  onChange: (key: string, value: number) => void;
  /** Per-domain anchor clarity, keyed `d1_anchor`…`d7_anchor`. */
  anchors?: Record<string, string | undefined>;
  onAnchorChange?: (key: string, value: string) => void;
  disabled?: boolean;
}

export function DomainScorer({ scores, onChange, anchors, onAnchorChange, disabled }: Props) {
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
            <div
              className="grid grid-cols-3 gap-1.5 sm:grid-cols-6"
              role="radiogroup"
              aria-label={`${d.en} (0–5)`}
              onKeyDown={radioKeys(LEVELS, picked ? val : null, (lv) => { if (!disabled) onChange(d.key, lv); })}
            >
              {PIS7_SCALE.map((s) => (
                <button
                  key={s.level}
                  type="button"
                  role="radio"
                  aria-checked={val === s.level}
                  aria-label={`${s.level} — ${s.en}`}
                  // Roving tab stop: ONE stop for the whole group, on the selection (or the first
                  // option when nothing is chosen). Six stops per domain — 42 on this page — is what
                  // made keyboard use impractical.
                  tabIndex={val === s.level || (!picked && s.level === 0) ? 0 : -1}
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
            {/* Never required. A missing judgement here is a missing judgement; making it mandatory
                would let a field that only informs later rubric work block an assessment entirely. */}
            {onAnchorChange && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">ความชัดเจนของ anchor / Anchor clarity</span>
                <div
                  className="flex flex-wrap gap-1.5"
                  role="radiogroup"
                  aria-label={`Anchor clarity for ${d.en}`}
                  onKeyDown={radioKeys(
                    ANCHOR_VALUES,
                    anchors?.[`${d.key}_anchor`] ?? null,
                    (v) => { if (!disabled) onAnchorChange(`${d.key}_anchor`, v); },
                  )}
                >
                  {ANCHOR_CLARITY.map((a) => {
                    const on = anchors?.[`${d.key}_anchor`] === a.value;
                    return (
                      <button
                        key={a.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={`${d.en} anchor ${a.en}`}
                        tabIndex={on || (!anchors?.[`${d.key}_anchor`] && a.value === ANCHOR_VALUES[0]) ? 0 : -1}
                        disabled={disabled}
                        onClick={() => onAnchorChange(`${d.key}_anchor`, a.value)}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-60",
                          on ? "border-coral-active bg-coral-active text-white" : "border-border bg-background hover:bg-muted"
                        )}
                      >
                        {a.th} · {a.en}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
