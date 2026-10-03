'use client';
// Route-level error boundary for the admin/superadmin tree — recoverable card + retry instead of
// Next's default crash screen.
import { StateMessage } from '@/components/ui/state-message';

export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <StateMessage kind="error" center onRetry={reset} title="เกิดข้อผิดพลาด / Something went wrong.">
        ไม่สามารถแสดงหน้านี้ได้ ลองอีกครั้ง / This page could not be displayed. Try again.
      </StateMessage>
    </div>
  );
}
