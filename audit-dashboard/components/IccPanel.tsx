interface Props { icc: number; lower: number; upper: number; n: number; interpretation: string; }
export function IccPanel({ icc, lower, upper, n, interpretation }: Props) {
  const color = icc >= 0.75 ? 'text-green-600' : 'text-red-500';
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-3">ICC(2,1) — AI vs Expert Auditor</h2>
      <p className={`text-4xl font-bold ${color}`}>{icc.toFixed(3)}</p>
      <p className="text-sm text-slate-500 mt-1">95% CI: [{lower.toFixed(3)}, {upper.toFixed(3)}] · n = {n}</p>
      <span className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-semibold ${
        icc >= 0.95 ? 'bg-green-100 text-green-700' :
        icc >= 0.85 ? 'bg-blue-100 text-blue-700' :
        icc >= 0.75 ? 'bg-yellow-100 text-yellow-700' :
        'bg-red-100 text-red-700'
      }`}>{interpretation}</span>
      <p className="text-xs text-slate-400 mt-2">เป้าหมาย: ICC ≥ 0.75 (lower bound)</p>
    </div>
  );
}
