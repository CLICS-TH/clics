import { NavBar } from '@/components/NavBar';

// Same chrome as every other section (mirrors app/auditor/layout.tsx). NavBar renders null until
// auth resolves and stays null for a signed-out reader — the manual page carries its own back link
// for exactly that case.
export default function ManualLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <NavBar />
      {children}
    </>
  );
}
