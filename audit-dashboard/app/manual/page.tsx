'use client';
// The auditor manual, at /manual.
//
// WHY NOT /auditor/manual. NavBar's isActive special-cases
// `href === '/auditor/queue' && pathname.startsWith('/auditor/')` (NavBar.tsx:94-98), so a manual
// under /auditor/ would keep คิวประเมิน / Queue lit while the reader is here — wrong state,
// announced by colour alone. /manual needs no change to that shared logic, and gives both consoles
// the same path.
//
// WHY DATA, NOT MARKUP. lib/manual-content.ts is a block AST generated from
// docs/manuals/content/auditor.th.md. Rendering it as React keeps this side free of
// dangerouslySetInnerHTML, which components/Markdown.tsx exists specifically to avoid.
//
// NO AUTH GUARD, deliberately. Every other page here bounces a wrong role; the manual does not.
// It describes the product, holds no participant data, and the reader most likely to need it is one
// who cannot get where they were going. NavBar renders null until auth resolves (and stays null when
// signed out), so the cover carries its own way back rather than relying on chrome being there.
import { withBasePath } from '@/lib/base-path';
import { useCallback, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { AUDITOR_MANUAL } from '@/lib/manual-content';
import { langSnapshot, serverLangSnapshot, setLang, subscribeLang } from '@/lib/manual-lang';
import type { Block, ManualLang, Section, Span } from '@/lib/manual-types';


const CALLOUT = {
  note: { th: 'หมายเหตุ', en: 'Note', box: 'border-border bg-muted', label: 'text-muted-foreground' },
  tip: { th: 'เคล็ดลับ', en: 'Tip', box: 'border-ok/40 bg-ok/10', label: 'text-ok' },
  // A warning must not be a colour alone: the visible word carries the kind for a greyscale print
  // and for a colour-blind reader.
  warn: { th: 'ข้อควรระวัง', en: 'Careful', box: 'border-danger/40 bg-danger/10', label: 'text-danger' },
} as const;

function Spans({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.t === 'b') return <b key={i} className="font-semibold text-foreground">{s.v}</b>;
        if (s.t === 'chip' || s.t === 'chip-neutral') {
          // A quotation of what is on screen, not a control — so no hover, no shadow, nothing that
          // invites a click. text-coral-on-tint because --link fails on a tinted background
          // (4.20:1 on --muted); see globals.css.
          const tone = s.t === 'chip'
            ? 'bg-primary/12 text-coral-on-tint'
            : 'bg-muted text-foreground';
          return (
            <span key={i} dir="auto" data-role="chip"
              className={`inline-block rounded border border-border px-1.5 text-[0.8125em] font-medium leading-snug ${tone}`}>
              {s.v}
            </span>
          );
        }
        return <span key={i}>{s.v}</span>;
      })}
    </>
  );
}

function BlockView({ b, lang }: { b: Block; lang: ManualLang }) {
  switch (b.t) {
    case 'h3':
      // Sans, not the display serif: globals.css puts the serif floor at 24px/600, and a 17px serif
      // on this ground is the low-contrast case that rule exists to prevent.
      return <h3 data-role="h3" className="mt-7 mb-2 text-[1.0625em] font-semibold leading-snug text-foreground">{b.text}</h3>;
    case 'lead':
      return <p data-role="lead" className="mb-4 max-w-[62ch] text-[1.0625em] leading-relaxed text-foreground"><Spans spans={b.spans} /></p>;
    case 'p':
      return <p data-role="body" className="mb-3.5 max-w-[62ch] leading-relaxed"><Spans spans={b.spans} /></p>;
    case 'ul':
      return (
        <ul className="mb-4 max-w-[62ch] list-disc space-y-1.5 pl-5 marker:text-primary">
          {b.items.map((it, i) => <li key={i} data-role="bullet"><Spans spans={it} /></li>)}
        </ul>
      );
    case 'steps':
      // Numbered, on its own card, with a coral rail — a sequence you must follow has to look
      // different from a list you may skim.
      return (
        <ol className="mb-4 space-y-2">
          {b.items.map((it, i) => (
            <li key={i} data-role="step" className="flex max-w-[62ch] gap-3 rounded-lg border-l-[3px] border-primary bg-secondary p-3.5">
              <span data-role="stepnum" className="shrink-0 text-[0.8125em] font-bold tabular-nums text-coral-on-tint">{i + 1}</span>
              <span><Spans spans={it} /></span>
            </li>
          ))}
        </ol>
      );
    case 'callout': {
      const c = CALLOUT[b.kind];
      return (
        <div data-role="callout" className={`mb-4 max-w-[66ch] rounded-lg border-l-[3px] p-3.5 ${c.box}`}>
          {/* 12.5px and no letter-spacing: this label is Thai in the Thai copy, Thai has a 12px
              floor, and letter-spacing can push a vowel or tone mark off its base consonant. */}
          <span data-role="kind" className={`mb-1 block text-[0.78125em] font-bold leading-snug ${c.label}`}>{lang === 'en' ? c.en : c.th}</span>
          {b.head && <span className="mb-0.5 block font-semibold text-foreground">{b.head}</span>}
          <Spans spans={b.spans} />
        </div>
      );
    }
    case 'figure':
      return (
        <figure className="mb-5">
          <img src={withBasePath(b.src)} alt={b.alt} loading="lazy" className="w-full rounded-xl border border-border bg-muted" />
          {b.caption && <figcaption data-role="figcap" className="mt-1.5 text-[0.84375em] text-muted-foreground">{b.caption}</figcaption>}
        </figure>
      );
    case 'table':
      // Its own scroller — a three-column Thai table does not fit 320px, and the page body must
      // never scroll sideways. 0.96em, not the old 0.90625em: on the 16px body that was 14.5px, and the
      // cells are Thai rubric text a rater learns from, so they sit at the 15.33px body floor.
      return (
        <div className="mb-5 overflow-x-auto rounded-xl border border-border">
          <table data-role="table" className="w-full min-w-[33em] text-[0.96em]">
            <thead>
              <tr>{b.head.map((h, i) => (
                <th key={i} className="whitespace-nowrap border-b border-border bg-muted p-2.5 text-left font-semibold text-foreground">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => (
                  <td key={j} className="border-b border-border/60 p-2.5 align-top last:border-0">{c}</td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function SectionView({ s, n, lang }: { s: Section; n: number; lang: ManualLang }) {
  return (
    <section id={s.id} className="mb-11 scroll-mt-20">
      <h2 className="mb-2 flex items-baseline gap-3 border-b-2 border-primary pb-3 font-heading text-3xl font-semibold leading-tight tracking-tight text-foreground">
        <span data-role="h2num" className="shrink-0 font-sans text-[0.5em] font-bold tabular-nums text-coral-on-tint">{n}</span>
        {s.title}
      </h2>
      {s.blocks.map((b, i) => <BlockView key={i} b={b} lang={lang} />)}
    </section>
  );
}

export default function ManualPage() {
  const hasEn = Boolean(AUDITOR_MANUAL.en?.length);
  // getServerSnapshot is 'th', which keeps SSR and the first client render identical.
  const requested = useSyncExternalStore(subscribeLang, langSnapshot, serverLangSnapshot);
  // The EFFECTIVE language. A reader can arrive with data-manual-lang="en" set from the portal
  // before this manual has been translated; without this the heading would render in English over
  // Thai body copy. One value drives the whole page, so a partial translation cannot half-apply.
  const lang: ManualLang = requested === 'en' && hasEn ? 'en' : 'th';

  // No setState — setLang writes the attribute and the MutationObserver re-reads it.
  const choose = useCallback((l: ManualLang) => setLang(l), []);

  const sections = lang === 'en' && AUDITOR_MANUAL.en ? AUDITOR_MANUAL.en : AUDITOR_MANUAL.th;

  return (
    <div className="mx-auto max-w-[940px] p-6 md:p-10">
      <header className="mb-8 border-b border-border pb-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-link">คู่มือการใช้งาน · Manual</p>
        {/* text-4xl, not the text-3xl the sections use: at text-3xl the manual's own title
            measured exactly the same size as every section heading below it, so nothing marked
            it as the title. Both are rem, so both follow the root scale-up. */}
        <h1 className="mt-3 font-heading text-4xl font-semibold tracking-tight text-foreground">
          {lang === 'en' ? 'Auditor manual' : 'คู่มือผู้ตรวจประเมิน'}
        </h1>
        <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">
          {lang === 'en'
            ? 'Blind PIS-7 scoring, from your queue to the reveal — written for everyday use.'
            : 'ตั้งแต่คิวการประเมินจนถึงการเปิดเผยคะแนน AI — เขียนสำหรับผู้ใช้ทั่วไป ไม่ต้องมีพื้นฐานเทคนิค'}
        </p>

        {hasEn && (
          <div role="group" aria-label="เลือกภาษา / Choose language" className="mt-4 inline-flex gap-1.5">
            {(['th', 'en'] as const).map((l) => (
              <button key={l} type="button" onClick={() => choose(l)} aria-pressed={requested === l}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  requested === l
                    ? 'border-primary bg-primary/12 font-semibold text-link'
                    : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {l === 'th' ? 'ไทย' : 'English'}
              </button>
            ))}
          </div>
        )}

        {/* NavBar is null until auth resolves and stays null when signed out, so this is the only
            guaranteed way back. */}
        <p className="mt-4 text-sm">
          <Link href="/auditor/queue" className="text-link underline underline-offset-2">
            ← กลับไปที่คิว / Back to queue
          </Link>
        </p>
      </header>

      <nav aria-label={lang === 'en' ? 'Contents' : 'สารบัญ'}
        className="mb-9 rounded-xl border border-border bg-muted p-4">
        <ol className="grid gap-0.5 @min-[768px]:grid-cols-2 @min-[768px]:gap-x-5">
          {sections.map((s, i) => (
            <li key={s.id}>
              <a href={`#${s.id}`} data-role="toc"
                className="flex items-baseline gap-2.5 rounded px-2 py-2 text-[0.9375em] leading-snug hover:bg-secondary hover:text-foreground">
                <span data-role="tocnum" className="min-w-[1.5em] shrink-0 text-[0.8667em] font-bold tabular-nums text-coral-on-tint">{i + 1}</span>
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((s, i) => <SectionView key={s.id} s={s} n={i + 1} lang={lang} />)}
    </div>
  );
}
