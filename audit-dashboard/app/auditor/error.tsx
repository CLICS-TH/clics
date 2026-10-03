'use client';
// Route-level error boundary: a thrown render/fetch error here shows a recoverable card with a retry
// instead of Next's default crash screen (there was no error boundary anywhere in the tree).
import { StateMessage } from '@/components/ui/state-message';

export default function AuditorError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="max-w-2xl mx-auto p-6 md:p-10">
      <StateMessage kind="error" center onRetry={reset} title="เกิดข้อผิดพลาด / Something went wrong.">
        ไม่สามารถแสดงหน้านี้ได้ ลองอีกครั้ง / This page could not be displayed. Try again.
      </StateMessage>
    </div>
  );
}
