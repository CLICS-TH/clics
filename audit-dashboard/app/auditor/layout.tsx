import { NavBar } from '@/components/NavBar';

// Shared chrome for every auditor page (and its loading state).
export default function AuditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <NavBar />
      {children}
    </>
  );
}
