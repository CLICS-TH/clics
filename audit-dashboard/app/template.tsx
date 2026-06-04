// Remounts per navigation (fresh key) → content fades in on every route change.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-in fade-in duration-300 motion-reduce:animate-none">{children}</div>;
}
