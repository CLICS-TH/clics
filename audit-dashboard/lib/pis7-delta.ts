// Deterministic, free conclusion under the PIS-7 radar — narrates where the auditor's scores sit
// relative to the AI's, per domain. No AI call (the chat box handles open-ended discussion). Works
// for whole numbers (a single CLE) and means (the home aggregate). Bilingual TH / EN, one line.
import { PIS7_RUBRIC } from './pis7-rubric';

type ScoreMap = Record<string, unknown> | null | undefined;

// Signed, compact: integers show as "+2", means as "+1.3".
function fmt(n: number): string {
  const r = Math.round(n * 10) / 10;
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1);
  return r > 0 ? `+${s}` : s;
}

export function pis7Conclusion(ai: ScoreMap, human: ScoreMap): string {
  const deltas = PIS7_RUBRIC.map(d => ({
    th: d.th,
    en: d.en,
    diff: Number(human?.[d.key] ?? 0) - Number(ai?.[d.key] ?? 0),
  }));

  // "Agree" = within a quarter point (handles fractional means; exact for integer single-CLE).
  const diverging = deltas.filter(x => Math.abs(x.diff) >= 0.25);
  if (diverging.length === 0) {
    return 'คะแนนของคุณสอดคล้องกับ AI ในทุกหมวด PIS-7 / Your scores align with the AI across every PIS-7 domain.';
  }

  const above = [...deltas].filter(x => x.diff > 0).sort((a, b) => b.diff - a.diff)[0];
  const below = [...deltas].filter(x => x.diff < 0).sort((a, b) => a.diff - b.diff)[0];
  const closest = [...deltas].sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))[0];

  const th: string[] = [];
  const en: string[] = [];
  if (above) { th.push(`สูงกว่า AI มากสุดที่ "${above.th}" (${fmt(above.diff)})`); en.push(`highest above the AI on ${above.en} (${fmt(above.diff)})`); }
  if (below) { th.push(`ต่ำกว่าที่ "${below.th}" (${fmt(below.diff)})`); en.push(`lowest on ${below.en} (${fmt(below.diff)})`); }
  th.push(`ใกล้เคียงที่สุดที่ "${closest.th}"`);
  en.push(`closest agreement on ${closest.en}`);

  return `คุณ${th.join(' ')} / You scored ${en.join(', ')}.`;
}
