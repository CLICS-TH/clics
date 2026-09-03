// The auditor manual page.
//
// What is worth asserting here is not "it renders" — it is the handful of decisions that are easy to
// break silently and impossible to notice in review:
//   - a quoted UI label stays verbatim, because a reader matches it against the screen;
//   - a warning is identifiable without colour, for greyscale print and colour-blind readers;
//   - the language choice comes from the DOM attribute (the house useSyncExternalStore pattern),
//     survives a reload, and updates `lang` so a screen reader changes voice;
//   - the toggle only appears once an English translation actually exists;
//   - there is always a way back, because NavBar renders nothing until auth resolves.
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import ManualPage from '@/app/manual/page';
import { langSnapshot, serverLangSnapshot, setLang, subscribeLang } from '@/lib/manual-lang';
import type { ManualContent } from '@/lib/manual-types';

// The content module is mocked behind a GETTER so a test can swap the payload without
// jest.resetModules(). Resetting modules and re-importing the page loads a second copy of React,
// which then fails every hook call with "invalid hook call" — a confusing failure that has nothing
// to do with the thing under test.
const REAL: ManualContent = jest.requireActual('@/lib/manual-content').AUDITOR_MANUAL;
let CONTENT: ManualContent = REAL;
jest.mock('@/lib/manual-content', () => ({ get AUDITOR_MANUAL() { return CONTENT; } }));

const AUDITOR_MANUAL = REAL;

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...p}>{children}</a>,
}));

const root = () => document.documentElement;

beforeEach(() => {
  CONTENT = REAL;
  root().removeAttribute('data-manual-lang');
  root().setAttribute('lang', 'th');
  localStorage.clear();
});

describe('content fidelity', () => {
  it('renders every section from the generated content, in order', () => {
    render(<ManualPage />);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toHaveLength(AUDITOR_MANUAL.th.length);
    AUDITOR_MANUAL.th.forEach((s, i) => expect(headings[i]).toContain(s.title));
  });

  it('gives each section an id so the contents list can reach it', () => {
    const { container } = render(<ManualPage />);
    for (const s of AUDITOR_MANUAL.th) expect(container.querySelector(`#${CSS.escape(s.id)}`)).toBeTruthy();
  });

  it('keeps a quoted UI label verbatim', () => {
    // The house rule: a chip is what is on screen, character for character. Trimming or
    // re-spacing it would break the one thing the reader uses it for.
    render(<ManualPage />);
    expect(screen.getAllByText('ส่งคะแนน / Submit score').length).toBeGreaterThan(0);
  });

  it('marks a warning with a word, not only a colour', () => {
    // A greyscale print and a colour-blind reader both need the kind stated.
    render(<ManualPage />);
    expect(screen.getAllByText('ข้อควรระวัง').length).toBeGreaterThan(0);
  });

  it('renders a step list as numbered, ordered items', () => {
    const { container } = render(<ManualPage />);
    const ol = container.querySelector('ol');
    expect(ol).toBeTruthy();
    expect(within(ol as HTMLElement).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('renders the rubric table with its header row', () => {
    render(<ManualPage />);
    const t = screen.getByRole('table');
    expect(within(t).getAllByRole('columnheader').length).toBe(3);
  });
});

describe('language', () => {
  it('shows Thai by default', () => {
    render(<ManualPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('คู่มือผู้ตรวจประเมิน');
  });

  it('reads the choice from the DOM attribute the pre-hydration script sets', () => {
    // The attribute is the single source of truth — set before paint in app/layout.tsx so a reader
    // who chose English never watches the Thai copy paint and swap.
    root().setAttribute('data-manual-lang', 'en');
    render(<ManualPage />);
    // With no English translation present the page still falls back to Thai content rather than
    // rendering nothing, which is the honest behaviour while the translation is outstanding.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      AUDITOR_MANUAL.en ? 'Auditor manual' : 'คู่มือผู้ตรวจประเมิน');
  });

  it('hides the toggle until an English translation exists', () => {
    render(<ManualPage />);
    const group = screen.queryByRole('group', { name: /เลือกภาษา/ });
    if (AUDITOR_MANUAL.en) expect(group).toBeTruthy();
    else expect(group).toBeNull();
  });
});

describe('language toggle, once a translation exists', () => {
  // Driven off a stub so the behaviour is covered before auditor.en.md lands — otherwise the
  // switching logic ships untested and is first exercised by a reader.
  const withEn: ManualContent = {
    th: [{ id: 'a', title: 'หัวข้อไทย', blocks: [{ t: 'p', spans: [{ t: 'text', v: 'เนื้อหาไทย' }] }] }],
    en: [{ id: 'a', title: 'English heading', blocks: [{ t: 'p', spans: [{ t: 'text', v: 'English body' }] }] }],
  };

  beforeEach(() => { CONTENT = withEn; });

  it('switches the rendered copy, the html lang and the stored choice', async () => {
    render(<ManualPage />);
    expect(screen.getByText('เนื้อหาไทย')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    // Awaited because the DOM attribute is the source of truth and MutationObserver delivers on a
    // microtask — the same one-tick lag ThemeProvider has. Asserting synchronously would be
    // asserting a state the real page never has either.
    await waitFor(() => expect(screen.getByText('English body')).toBeInTheDocument());
    expect(screen.queryByText('เนื้อหาไทย')).toBeNull();
    expect(root().getAttribute('data-manual-lang')).toBe('en');
    // Drives font fallback and how a screen reader pronounces the page.
    expect(root().getAttribute('lang')).toBe('en');
    expect(localStorage.getItem('clics_manual_lang')).toBe('en');
  });

  it('switches back, clearing the attribute rather than setting it to "th"', async () => {
    render(<ManualPage />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => expect(screen.getByText('English body')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'ไทย' }));

    await waitFor(() => expect(screen.getByText('เนื้อหาไทย')).toBeInTheDocument());
    expect(root().hasAttribute('data-manual-lang')).toBe(false);
    expect(root().getAttribute('lang')).toBe('th');
    expect(localStorage.getItem('clics_manual_lang')).toBe('th');
  });

  it('reports the current language to assistive tech', async () => {
    render(<ManualPage />);
    expect(screen.getByRole('button', { name: 'ไทย' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: 'ไทย' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('survives a storage write being refused', async () => {
    // Private browsing throws on setItem. The language must still switch — losing the preference is
    // acceptable, losing the click is not.
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    render(<ManualPage />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => expect(screen.getByText('English body')).toBeInTheDocument());
    spy.mockRestore();
  });
});

describe('getting out', () => {
  it('offers a way back that does not depend on the nav', () => {
    // NavBar returns null until auth resolves, and stays null when signed out — so the page's own
    // link is the only guaranteed exit.
    render(<ManualPage />);
    expect(screen.getByRole('link', { name: /กลับไปที่คิว/ })).toHaveAttribute('href', '/auditor/queue');
  });

  it('gives the contents list an accessible name', () => {
    render(<ManualPage />);
    expect(screen.getByRole('navigation', { name: /สารบัญ|Contents/ })).toBeInTheDocument();
  });
});

describe('block kinds the auditor manual does not currently use', () => {
  // The renderer handles every block the parser can emit, but the auditor content only exercises
  // some of them. Covering the rest here means a figure or a lead paragraph is not first rendered
  // in production, the day someone adds one to the markdown.
  it('renders a figure, with and without a caption', () => {
    CONTENT = {
      th: [{
        id: 'a', title: 'ก', blocks: [
          { t: 'figure', src: '/img/manual/login.png', alt: 'หน้าเข้าสู่ระบบ', caption: 'คำบรรยายภาพ' },
          { t: 'figure', src: '/img/manual/x.png', alt: 'ไม่มีคำบรรยาย', caption: null },
        ],
      }],
    };
    render(<ManualPage />);
    // alt text, not a decorative image: a reader who cannot see it still learns what it showed.
    expect(screen.getByAltText('หน้าเข้าสู่ระบบ')).toHaveAttribute('src', '/img/manual/login.png');
    expect(screen.getByText('คำบรรยายภาพ')).toBeInTheDocument();
    expect(screen.getByAltText('ไม่มีคำบรรยาย')).toBeInTheDocument();
  });

  it('renders a lead paragraph, a sub-heading, a bullet list and a neutral chip', () => {
    CONTENT = {
      th: [{
        id: 'a', title: 'ก', blocks: [
          { t: 'lead', spans: [{ t: 'text', v: 'ย่อหน้านำ' }] },
          { t: 'h3', text: 'หัวข้อย่อย' },
          { t: 'ul', items: [[{ t: 'b', v: 'ตัวหนา' }], [{ t: 'chip-neutral', v: 'ยกเลิก / Cancel' }]] },
          { t: 'callout', kind: 'note', head: null, spans: [{ t: 'text', v: 'ไม่มีหัวเรื่อง' }] },
          { t: 'callout', kind: 'tip', head: 'หัวเรื่อง', spans: [{ t: 'text', v: 'เนื้อหา' }] },
        ],
      }],
    };
    render(<ManualPage />);
    expect(screen.getByText('ย่อหน้านำ')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'หัวข้อย่อย' })).toBeInTheDocument();
    expect(screen.getByText('ตัวหนา')).toBeInTheDocument();
    expect(screen.getByText('ยกเลิก / Cancel')).toBeInTheDocument();
    expect(screen.getByText('ไม่มีหัวเรื่อง')).toBeInTheDocument();
    expect(screen.getByText('หัวเรื่อง')).toBeInTheDocument();
  });
});

describe('the language store', () => {
  // Unit-tested directly rather than through the page: serverLangSnapshot is only ever reached
  // during SSR, and driving react-dom/server from jsdom needs a MessageChannel polyfill that leaves
  // an open handle and hangs the run. A plain function can simply be called.
  it('renders Thai on the server, because the server has no attribute and no storage', () => {
    expect(serverLangSnapshot()).toBe('th');
  });

  it('treats an absent or unrecognised attribute as Thai', () => {
    root().removeAttribute('data-manual-lang');
    expect(langSnapshot()).toBe('th');
    root().setAttribute('data-manual-lang', 'fr');
    expect(langSnapshot()).toBe('th');
    root().setAttribute('data-manual-lang', 'en');
    expect(langSnapshot()).toBe('en');
  });

  it('notifies a subscriber when the attribute changes, and stops after unsubscribe', async () => {
    const seen = jest.fn();
    const stop = subscribeLang(seen);
    setLang('en');
    await waitFor(() => expect(seen).toHaveBeenCalled());
    stop();
    const before = seen.mock.calls.length;
    setLang('th');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.mock.calls.length).toBe(before);
  });

  it('still switches when storage refuses the write', () => {
    // Private browsing throws on setItem. Losing the preference is acceptable; losing the switch
    // is not, so the attribute must still land.
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    setLang('en');
    expect(root().getAttribute('data-manual-lang')).toBe('en');
    spy.mockRestore();
  });

  it('ignores changes to other attributes', async () => {
    const seen = jest.fn();
    const stop = subscribeLang(seen);
    root().setAttribute('data-unrelated', '1');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).not.toHaveBeenCalled();
    stop();
    root().removeAttribute('data-unrelated');
  });
});
