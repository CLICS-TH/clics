'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { PageIntro } from '@/components/PageIntro';
import { Skeleton } from '@/components/Skeleton';
import { useIsMobile } from '@/components/ViewportProvider';

// Tier-4 ethics committee: read-only audit trail (access/scoring/provisioning events). No transcripts.
type Ev = {
  id: string; created_at: string; actor_role?: string | null; action: string;
  target_type?: string | null; target_id?: string | null;
};
type LogResp = { events: Ev[]; total: number };

export default function EthicsPage() {
  const router = useRouter();
  const mobile = useIsMobile();
  const [log, setLog] = useState<LogResp | null>(null);
  useEffect(() => {
    const role = getUser()?.role;
    if (role !== 'ethics' && role !== 'superadmin') { router.push('/home'); return; }
    apiFetch<LogResp>('/oversight/audit-log').then(setLog).catch(() => setLog({ events: [], total: 0 }));
  }, [router]);

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-10 space-y-6">
      <PageIntro
        eyebrow="Ethics · Audit trail"
        title="บันทึกการตรวจสอบ"
        subtitle="Access, scoring, and provisioning events — for the ethics committee. No transcripts."
      />
      {!log ? <Skeleton className="h-64 w-full" /> : log.events.length === 0 ? (
        <div className="text-muted-foreground">ยังไม่มีเหตุการณ์ / No events recorded yet.</div>
      ) : mobile ? (
        /* Phone: stacked cards (the 4-col table would force horizontal scroll). */
        <div className="space-y-3">
          {log.events.map((e) => (
            <div key={e.id} className="rounded-xl border border-border p-4 space-y-1">
              <p className="font-mono text-sm break-all">{e.action}</p>
              <p className="text-xs tabular-nums text-muted-foreground">{new Date(e.created_at).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">
                {e.actor_role ?? '—'}{e.target_type ? ` · ${e.target_type}:${e.target_id ?? ''}` : ''}
              </p>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{log.events.length} / {log.total} เหตุการณ์</p>
        </div>
      ) : (
        <div className="border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-left">
              <tr>
                <th className="p-3 font-medium">เวลา / Time</th>
                <th className="p-3 font-medium">บทบาท / Role</th>
                <th className="p-3 font-medium">การกระทำ / Action</th>
                <th className="p-3 font-medium">เป้าหมาย / Target</th>
              </tr>
            </thead>
            <tbody>
              {log.events.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="p-3 tabular-nums text-muted-foreground whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="p-3">{e.actor_role ?? '—'}</td>
                  <td className="p-3 font-mono">{e.action}</td>
                  <td className="p-3 text-muted-foreground">{e.target_type ? `${e.target_type}:${e.target_id ?? ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="p-3 text-xs text-muted-foreground">{log.events.length} / {log.total} เหตุการณ์</p>
        </div>
      )}
    </div>
  );
}
