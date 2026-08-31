/*
 * The nav threshold, pinned against the widths it was MEASURED at.
 *
 * WHY. The threshold used to be the constant `(max-width: 1535px)`, with a comment reading "8
 * bilingual links … needs ~1536px". That was true when written. The roster then grew to 9 links for
 * admin and 14 for superadmin and nothing re-derived the number, so above 1535px both roles painted
 * a row wider than the viewport and scrolled the whole page sideways on every real monitor. Nothing
 * in tsc, lint or the component tests can see a layout, so it went unnoticed until a Playwright
 * sweep measured it.
 *
 * The threshold is now derived from the link count, which stops the same drift. This file pins the
 * DERIVATION against the three widths it was calibrated at, so a future change to either constant —
 * or a roster that outgrows the model — fails here with the number rather than in production.
 *
 * Measured with Playwright against the built app, both label languages rendered, the widest identity
 * block, binary-searching the narrowest viewport at which `nav > div` reports no overflow. That
 * measurement is committed and repeatable:
 *
 *     cd audit-dashboard && npm run build && npx next start -p 3002
 *     npm run test:nav-width              # sweeps 5 roles × 13 widths, 320–3400px
 *     node scripts/responsive/nav-width-audit.mjs --calibrate   # re-derive after a roster change
 *
 * The sweep is what caught the original bug; this file is what makes it cheap to keep caught, since
 * jest cannot measure a layout and the portal's responsive smoke stops at 1280px.
 */
import { navRowWidthPx, NAV_CHROME_PX, NAV_PER_LINK_PX } from '../lib/client-store';
import { ADMIN_LINKS, SUPERADMIN_LINKS, AUDITOR_LINKS, ANALYST_LINKS, ETHICS_LINKS } from '../components/NavBar';

/*
 * [roster length, the narrowest viewport that actually fit that row].
 *
 * ROSTER length, not rendered-anchor count. The first fit of these constants counted every
 * `nav a[href^="/"]`, which includes the CLICS wordmark's link to /home — one too many per row, so
 * the model came out ~100px under and left a band where the row still went inline and overflowed.
 *
 * These are LOWER bounds: the row provably needed this much, so the model must demand at least it.
 */
const NEEDED: [links: number, fitsFromPx: number][] = [
  [8, 2060],
  [13, 2976],
];

/*
 * The binary search floor was 1536px, so a row that fit there has an unknown true need — only an
 * UPPER bound. Asserting `>= 1536` on it would be asserting something never measured; what was
 * measured is that a 2-link row must be ALLOWED inline at 1536, and a model that demanded more
 * would hamburger the auditor nav on a laptop for no reason.
 */
const FITS_AT_FLOOR: [links: number, floorPx: number][] = [[2, 1536]];

describe('the desktop nav collapses before its row can overflow', () => {
  it.each(NEEDED)('%i links: the model demands at least the measured %ipx', (links, fitsFrom) => {
    // The model must be CONSERVATIVE — never letting a row go inline below the width it needs.
    // Being too cautious costs a hamburger; being too eager costs a sideways-scrolling page.
    expect(navRowWidthPx(links)).toBeGreaterThanOrEqual(fitsFrom);
  });

  it.each(FITS_AT_FLOOR)('%i links: still allowed inline at the measured %ipx', (links, floor) => {
    expect(navRowWidthPx(links)).toBeLessThanOrEqual(floor);
  });

  it('is monotonic — one more link never lowers the bar', () => {
    for (let n = 0; n < 30; n++) expect(navRowWidthPx(n + 1)).toBeGreaterThan(navRowWidthPx(n));
  });

  it('the constants are the ones the measurements were fitted to', () => {
    // A silent edit to either constant would move every threshold at once.
    expect(NAV_CHROME_PX).toBe(620);
    expect(NAV_PER_LINK_PX).toBe(190);
  });

  /*
   * The shipped rosters, pinned by SIZE. Adding a link is fine — this test then fails, and the
   * author has to look at the new number and decide whether a row that wide should ever go inline.
   * That forced look is the whole point: the last roster growth had nobody to notice it.
   */
  it.each([
    ['auditor', AUDITOR_LINKS, 2],
    ['analyst', ANALYST_LINKS, 1],
    ['ethics', ETHICS_LINKS, 1],
    ['admin', ADMIN_LINKS, 9],
    ['superadmin', SUPERADMIN_LINKS, 14],
  ])('%s ships the pinned number of links', (_role, links, count) => {
    expect((links as unknown[]).length).toBe(count);
  });

  it('every roster entry has an absolute href and a label', () => {
    // `en` is deliberately OPTIONAL: BiLabel renders `th` alone when it is absent, which is right for
    // the entries whose label is already English or an acronym (PLEs, QA Queue, ICC). Asserting a
    // second language on those would force a redundant "PLEs PLEs".
    for (const roster of [AUDITOR_LINKS, ANALYST_LINKS, ETHICS_LINKS, ADMIN_LINKS, SUPERADMIN_LINKS]) {
      for (const l of roster) {
        expect(l.href.startsWith('/')).toBe(true);
        expect(l.th.length).toBeGreaterThan(0);
      }
    }
  });
});
