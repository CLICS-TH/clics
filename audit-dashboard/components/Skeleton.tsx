// Presentational skeletons (no hooks) — safe to use inside server `loading.tsx`.
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex gap-4 border-b border-border bg-secondary px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => <Skeleton key={i} className="h-4 flex-1" />)}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-t border-border px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => <Skeleton key={c} className="h-4 flex-1" />)}
        </div>
      ))}
    </div>
  );
}

export function CardGridSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {Array.from({ length: cards }).map((_, i) => <Skeleton key={i} className="h-24" />)}
    </div>
  );
}

export function NavBarSkeleton() {
  return (
    <nav className="flex h-14 items-center gap-4 border-b border-border bg-background px-6">
      <Skeleton className="h-5 w-16" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-20" />
    </nav>
  );
}
