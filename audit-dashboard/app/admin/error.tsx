'use client';
// Route-level error boundary for the admin/superadmin tree — recoverable card + retry instead of
// Next's default crash screen.
export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <div className="border rounded-xl p-6 text-center space-y-3">
        <p className="font-medium">เกิดข้อผิดพลาด / Something went wrong.</p>
        <p className="text-sm text-muted-foreground">ไม่สามารถแสดงหน้านี้ได้ / This page could not be displayed.</p>
        <button className="text-sm text-link underline" onClick={reset}>ลองใหม่ / Retry</button>
      </div>
    </div>
  );
}
