import { NavBar } from '@/components/NavBar';

// Shared chrome for every admin page (and its loading state) — the NavBar lives
// here instead of being repeated in each page.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <NavBar />
      {children}
    </>
  );
}
