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
 * DERIVATION against the widths it was calibrated at, so a future change to either constant — or a
 * roster that outgrows the model — fails here with the number rather than in production.
 *
 * Measured with Playwright against the built app, both label languages rendered, the widest identity
 * block: each persona's row is forced inline and the narrowest viewport from which it FITS at every
 * wider width is found (fits = no control wraps, nothing overflows the row or the page). That
 * measurement is committed and repeatable:
 *
 *     cd audit-dashboard && npm run build && npx next start -p 3002
 *     npm run test:nav-width              # 6 personas × 11 widths + both sides of every threshold
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
 *
 * Measured with the text-sm body floor in place (nav text 15.36px below 1280, 16.52px at 1280) and
 * the row's controls whitespace-nowrap. Short rosters go inline below 1280 — the 1-link rows from
 * 947 and the 2-link auditor row from 1137 — so the 100% root is calibrated as carefully as the
 * desktop steps. The dual-role row is 3: its two links plus Return to Physician, which NavBar counts
 * as a link. It fits from ~1195 on the 100% root but not at 1280–1326, where the 118% root grows
 * every rem, so its need is 1327; that row sets NAV_CHROME_PX.
 *
 * The earlier pairs here — [8, 2060], [13, 2976] and [1, 836] — were fitted on overflow alone, which
 * could not see a control WRAP instead of overflowing. Every one of them was too eager.
 */
const NEEDED: [links: number, fitsFromPx: number][] = [
  [1, 900],     // ethics — the longest single-link label
  [1, 855],     // analyst
  [2, 945],     // auditor
  [3, 1327],    // dual-role physician (2 links + Return to Physician)
  [9, 2348],    // admin
  [14, 3265],   // superadmin
];

/*
 * The other direction: a model that demanded far more than any row needs would hamburger the auditor
 * nav on an ordinary laptop for no reason. A 2-link row must stay ALLOWED inline at 1536.
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
    expect(NAV_CHROME_PX).toBe(757);
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
