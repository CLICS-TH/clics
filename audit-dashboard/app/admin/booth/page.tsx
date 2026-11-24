'use client';
// Booth Mode (superadmin): the event's switch, window and case pool (BoothCard, moved here from the overview), the
// leaderboard of every scored play, and the internal JSON export of every play (ADR 0014).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiDownload } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { boothExportFilename } from '@/lib/booth';
import { PageIntro } from '@/components/PageIntro';
import { BoothCard } from '@/components/BoothCard';
import { BoothLeaderboard } from '@/components/BoothLeaderboard';
import { toast } from '@/components/Overlays';

// The server answers with the file (Content-Disposition attachment) and writes an audit-log row for it.
const EXPORT_PATH = '/admin/booth/export.json';

function ExportButton({ eventCode }: { eventCode: string | null }) {
  const [exporting, setExporting] = useState(false);
  async function exportJson() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await apiDownload(EXPORT_PATH, boothExportFilename(eventCode));
      if (res.error) toast(res.error, 'error');
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="flex flex-col items-start gap-1.5">
      {/* bg-coral-active, the button-fill token: white on bright --primary measures 3.28:1. */}
      <button
        type="button"
        onClick={exportJson}
        aria-disabled={exporting || undefined}
        className="whitespace-nowrap rounded-md bg-coral-active px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity aria-disabled:cursor-wait aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100"
      >
        {exporting ? 'กำลังส่งออก… / Exporting…' : 'Export ข้อมูลบูท (JSON)'}
      </button>
      <p className="text-xs text-muted-foreground">ใช้ภายในเท่านั้น / Internal use only</p>
    </div>
  );
}

export default function BoothPage() {
  const router = useRouter();
  const [eventCode, setEventCode] = useState<string | null>(null);

  useEffect(() => {
    if (getUser()?.role !== 'superadmin') router.push('/home');
  }, [router]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-12 p-6 md:p-10">
      <PageIntro
        eyebrow="Superadmin · Booth Mode"
        title="โหมดบูธ / Booth Mode"
        subtitle="เปิดปิดบูธ ตั้งเวลา เลือกเคส และดูกระดานคะแนนของทุกการเล่น / Switch the booth, set its window and cases, and follow every scored play."
        action={<ExportButton eventCode={eventCode} />}
      />
      <BoothCard />
      <BoothLeaderboard onLoad={(s) => setEventCode(s.event_code)} />
    </div>
  );
}
