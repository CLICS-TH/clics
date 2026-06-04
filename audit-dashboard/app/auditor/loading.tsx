import { NavBarSkeleton, TableSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <>
      <NavBarSkeleton />
      <div className="mx-auto w-full max-w-3xl space-y-6 p-8">
        <div className="h-7 w-56 animate-pulse rounded bg-muted" />
        <TableSkeleton rows={5} cols={3} />
      </div>
    </>
  );
}
