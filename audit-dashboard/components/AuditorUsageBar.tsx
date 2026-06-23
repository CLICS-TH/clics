'use client';
// Compact meter for the auditor's SEPARATE AI budget pool (the discussion chat spends it). Mirrors the
// physician usage bar's philosophy: show %-used only, not raw $ — the figure reads as "spending" to a
// reviewer. Re-fetches /auth/me when `version` bumps (the chat box bumps it after each turn).
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { CHART } from '@/lib/chart-colors';

type MeUser = { auditor_usage_cost_usd?: number | null; auditor_usage_limit_effective_usd?: number | null };

export function AuditorUsageBar({ version = 0 }: { version?: number }) {
  const [u, setU] = useState<MeUser | null>(null);
  useEffect(() => {
    apiFetch<{ user?: MeUser }>('/auth/me').then(d => setU(d?.user ?? null)).catch(() => {});
  }, [version]);
  if (!u) return null;
  const limit = Number(u.auditor_usage_limit_effective_usd);
  if (!Number.isFinite(limit) || limit <= 0) return null; // nothing meaningful to show
  const used = Number(u.auditor_usage_cost_usd ?? 0);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const over = used >= limit;
  const color = over ? CHART.fail : pct >= 80 ? CHART.warn : CHART.pass;
  return (
    <div className="text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground">โควตา AI ของผู้ตรวจ / Your auditor AI allowance</span>
        <span className="tabular-nums font-medium" style={{ color }}>{over ? 'เต็ม / Full' : `ใช้ไป ${pct}%`}</span>
      </div>
      <div className="h-1.5 mt-1 rounded-full bg-muted overflow-hidden"><div className="h-full" style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}
