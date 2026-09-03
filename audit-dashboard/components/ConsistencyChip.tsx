// Repeat-scoring metadata for one AI evaluation: "scored 2× · first-of-agreeing-pair".
//
// RIMPL MAY attach `provenance.consistency` to an evaluation in future (absent today). When it is
// there, this chip says how many evaluator calls produced the score and which rule picked it; when it
// is not, the chip renders NOTHING — no placeholder, no "1×", because a single call is not a
// consistency method and pretending otherwise would misdescribe the older scores.
//
// DISPLAY ONLY. The values are never read anywhere else: not by the radar, not by pis7Conclusion, not
// by any ICC figure. The score the auditor is comparing against is the same score with or without
// this chip beside it.
import { BiLabel } from '@/components/BiLabel';
import type { EvaluationProvenance } from '@/lib/types';

export function ConsistencyChip({ provenance }: { provenance?: EvaluationProvenance | null }) {
  const c = provenance?.consistency;
  if (!c || typeof c !== 'object') return null;
  const calls = Number(c.calls);
  if (!Number.isInteger(calls) || calls < 1) return null;
  const rule = typeof c.rule === 'string' && c.rule.trim() ? c.rule.trim() : null;
  const en = rule ? `scored ${calls}× · ${rule}` : `scored ${calls}×`;
  const delta = Number.isFinite(Number(c.max_delta)) && c.max_delta != null ? ` · max Δ ${c.max_delta}` : '';
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground tabular-nums"
      title={`ให้คะแนนซ้ำเพื่อความสอดคล้อง${delta} — แสดงเท่านั้น ไม่ใช้คำนวณ / Repeat-scored for consistency${delta} — display only, not used in any calculation`}
    >
      <BiLabel th={`ให้คะแนน ${calls} ครั้ง`} en={en} />
    </span>
  );
}
