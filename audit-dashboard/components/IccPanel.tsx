import { Badge } from '@/components/ui/badge';

interface Props { icc: number | null; lower: number | null; upper: number | null; n: number; interpretation: string; }
export function IccPanel({ icc, lower, upper, n, interpretation }: Props) {
  // Degenerate (icc null = identical scores / insufficient variance): show a neutral value, never
  // crash on null.toFixed and never render it as "Below target".
  if (icc == null) {
    return (
      <div className="border rounded-xl p-5">
        <h2 className="font-semibold mb-3">ICC(2,1) — AI vs Expert Auditor</h2>
        <p className="text-3xl sm:text-4xl font-bold text-muted-foreground">—</p>
        <p className="text-sm text-muted-foreground mt-1">{interpretation} · n = {n}</p>
        <p className="text-xs text-muted-foreground mt-2">เป้าหมาย: ICC ≥ 0.75 (lower bound)</p>
      </div>
    );
  }
  const color = icc >= 0.75 ? 'text-[var(--ok)]' : 'text-destructive';
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-3">ICC(2,1) — AI vs Expert Auditor</h2>
      <p className={`text-3xl sm:text-4xl font-bold ${color}`}>{icc.toFixed(3)}</p>
      <p className="text-sm text-muted-foreground mt-1">95% CI: [{lower?.toFixed(3) ?? '—'}, {upper?.toFixed(3) ?? '—'}] · n = {n}</p>
      <Badge
        variant={icc >= 0.95 ? 'ok' : icc >= 0.85 ? 'secondary' : icc >= 0.75 ? 'notice' : 'error'}
        className="mt-2 h-auto px-3 py-1 font-semibold">{interpretation}</Badge>
      <p className="text-xs text-muted-foreground mt-2">เป้าหมาย: ICC ≥ 0.75 (lower bound)</p>
    </div>
  );
}
