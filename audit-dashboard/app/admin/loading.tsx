import { NavBarSkeleton, TableSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <>
      <NavBarSkeleton />
      <div className="mx-auto w-full max-w-5xl space-y-6 p-8">
        <div className="h-7 w-64 animate-pulse rounded bg-muted" />
        <TableSkeleton rows={6} cols={4} />
      </div>
    </>
  );
}
