import { TableSkeleton } from '@/components/Skeleton';

// Renders inside AuditorLayout (which provides the NavBar).
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-8">
      <div className="h-7 w-56 animate-pulse rounded bg-muted" />
      <TableSkeleton rows={5} cols={3} />
    </div>
  );
}
