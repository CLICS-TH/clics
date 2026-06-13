interface Props { icc: number | null; lower: number | null; upper: number | null; n: number; interpretation: string; }
export function IccPanel({ icc, lower, upper, n, interpretation }: Props) {
  // Degenerate (icc null = identical scores / insufficient variance): show a neutral value, never
  // crash on null.toFixed and never render it as "Below target".
  if (icc == null) {
    return (
      <div className="border rounded-xl p-5">
        <h2 className="font-semibold mb-3">ICC(2,1) — AI vs Expert Auditor</h2>
        <p className="text-4xl font-bold text-muted-foreground">—</p>
        <p className="text-sm text-muted-foreground mt-1">{interpretation} · n = {n}</p>
        <p className="text-xs text-muted-foreground mt-2">เป้าหมาย: ICC ≥ 0.75 (lower bound)</p>
      </div>
    );
  }
  const color = icc >= 0.75 ? 'text-[var(--ok)]' : 'text-destructive';
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-3">ICC(2,1) — AI vs Expert Auditor</h2>
      <p className={`text-4xl font-bold ${color}`}>{icc.toFixed(3)}</p>
      <p className="text-sm text-muted-foreground mt-1">95% CI: [{lower?.toFixed(3) ?? '—'}, {upper?.toFixed(3) ?? '—'}] · n = {n}</p>
      <span className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-semibold ${
        icc >= 0.95 ? 'bg-[var(--chart-pass-bg)] text-[var(--chart-pass-text)]' :
        icc >= 0.85 ? 'bg-secondary text-foreground' :
        icc >= 0.75 ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' :
        'bg-destructive/10 text-destructive'
      }`}>{interpretation}</span>
      <p className="text-xs text-muted-foreground mt-2">เป้าหมาย: ICC ≥ 0.75 (lower bound)</p>
    </div>
  );
}
