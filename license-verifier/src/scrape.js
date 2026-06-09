// scrape.js — best-effort Playwright scrape of The Medical Council of Thailand's
// PUBLIC license-check site (https://checkmd.tmc.or.th/En/v3).
//
// Contract (returned to src/index.js, then forwarded verbatim to the backend):
//   { status: 'verified' | 'name_mismatch' | 'not_found' | 'unavailable', evidence }
//
// Design rules baked in here:
//   * NEVER report 'not_found' when we are merely uncertain. A captcha, a missing
//     expected selector, a redirect, a timeout, or any launch/navigation error
//     ALL collapse to 'unavailable' so the backend (circuit-breaker + admin
//     manual-verify) can react correctly instead of falsely failing a real doctor.
//   * The browser is ALWAYS closed in `finally`, even on throw.
//   * A per-request deadline bounds the whole scrape; on overrun -> 'unavailable'.
//
// This file is intentionally defensive about selectors: the upstream markup is
// not under our control and can change without notice. Every locator has
// fallbacks, and "expected element absent" is treated as 'unavailable', not a
// negative result.

const { chromium } = require('playwright');

const TARGET_URL = process.env.TMC_URL || 'https://checkmd.tmc.or.th/En/v3';
const NAV_TIMEOUT_MS = parseInt(process.env.SCRAPE_NAV_TIMEOUT_MS || '15000', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.SCRAPE_REQUEST_TIMEOUT_MS || '25000', 10);
const RESULT_WAIT_MS = parseInt(process.env.SCRAPE_RESULT_WAIT_MS || '12000', 10);

const THAI_HONORIFICS = [
  'นพ.', 'พญ.', 'นาย', 'นาง', 'นางสาว', 'น.ส.', 'ด.ช.', 'ด.ญ.',
  'ศ.', 'รศ.', 'ผศ.', 'ดร.', 'พ.', 'พล.',
];
const EN_HONORIFICS = [
  'dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'assoc', 'asst',
  'md', 'm.d', 'professor', 'doctor',
];

// ---- name normalization ------------------------------------------------------
// Normalize for robust comparison across the scraped page and the supplied name:
//   NFC -> lowercase -> strip leading honorifics -> drop punctuation/dots ->
//   collapse whitespace -> trim.
function normalizeName(raw) {
  if (!raw) return '';
  let s = String(raw).normalize('NFC').trim();

  // Strip honorifics token-by-token from the front (handles "Dr. ", "นพ. ", etc.).
  // Repeat because some names stack honorifics ("Assoc. Prof. Dr.").
  let changed = true;
  while (changed) {
    changed = false;
    const lower = s.toLowerCase();
    for (const h of THAI_HONORIFICS) {
      if (s.startsWith(h)) { s = s.slice(h.length).trim(); changed = true; }
    }
    for (const h of EN_HONORIFICS) {
      // honorific as a leading word, optionally followed by a dot
      const re = new RegExp('^' + h.replace(/\./g, '\\.') + '\\.?\\s+', 'i');
      if (re.test(lower)) {
        s = s.replace(re, '').trim();
        changed = true;
      }
    }
  }

  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[.,;:_'"`()\-–—]/g, ' ') // punctuation/dashes -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// Compare two normalized names allowing for order-independence (the site may
// render "Surname Name" or "Name Surname"). We treat the supplied full name and
// the scraped full name as bags of tokens and require one to cover the other.
function namesMatch(suppliedFull, scrapedFull) {
  const a = normalizeName(suppliedFull);
  const b = normalizeName(scrapedFull);
  if (!a || !b) return false;
  if (a === b) return true;

  const at = new Set(a.split(' ').filter(Boolean));
  const bt = new Set(b.split(' ').filter(Boolean));
  if (at.size === 0 || bt.size === 0) return false;

  // Order-independent match. Accept if either name's tokens are fully contained
  // in the other (covers word-order differences and one side carrying an extra
  // middle name / honorific remnant), OR the two share a strong majority of
  // tokens (>= 60% of the smaller token set).
  const aCoversB = [...at].every((t) => bt.has(t));
  const bCoversA = [...bt].every((t) => at.has(t));
  if (aCoversB || bCoversA) return true;
  return _sharedRatio(at, bt) >= 0.6;
}

function _sharedRatio(setA, setB) {
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  const denom = Math.min(setA.size, setB.size) || 1;
  return shared / denom;
}

// ---- name splitting ----------------------------------------------------------
// The form wants Name* + Surname*. Prefer the English full name; fall back to
// Thai. First token -> Name, the remainder -> Surname (common Thai-record shape).
function splitName({ full_name_en, full_name_th }) {
  const source = (full_name_en && full_name_en.trim()) || (full_name_th && full_name_th.trim()) || '';
  // Strip honorifics before splitting so they don't land in the Name field.
  const cleaned = _stripHonorificsKeepCase(source);
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { name: '', surname: '' };
  if (parts.length === 1) return { name: parts[0], surname: '' };
  return { name: parts[0], surname: parts.slice(1).join(' ') };
}

function _stripHonorificsKeepCase(raw) {
  let s = String(raw).normalize('NFC').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of THAI_HONORIFICS) {
      if (s.startsWith(h)) { s = s.slice(h.length).trim(); changed = true; }
    }
    for (const h of EN_HONORIFICS) {
      const re = new RegExp('^' + h.replace(/\./g, '\\.') + '\\.?\\s+', 'i');
      if (re.test(s)) { s = s.replace(re, '').trim(); changed = true; }
    }
  }
  return s;
}

// ---- DOM helpers (resilient, fallback-laden) ---------------------------------
// Try a list of locator strategies; return the first that resolves to a visible
// element, else null. Each strategy is wrapped so a bad selector can't throw.
async function firstVisible(page, strategies) {
  for (const make of strategies) {
    try {
      const loc = make();
      const count = await loc.count();
      if (count > 0) {
        const el = loc.first();
        if (await el.isVisible().catch(() => false)) return el;
      }
    } catch (_) { /* try next strategy */ }
  }
  return null;
}

// Detect a captcha / recaptcha / "robot" challenge. Presence => 'unavailable'.
async function hasCaptcha(page) {
  const selectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'div.g-recaptcha',
    '#g-recaptcha',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    'iframe[title*="captcha" i]',
  ];
  for (const sel of selectors) {
    try {
      if (await page.locator(sel).count() > 0) return true;
    } catch (_) { /* ignore */ }
  }
  // Text-based heuristic for interstitial challenge pages.
  try {
    const bodyText = (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) || '';
    if (/are you (a )?human|verify you are not a robot|i'?m not a robot|recaptcha/i.test(bodyText)) {
      return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

// Locate the Name / Surname / License inputs via several strategies so a markup
// tweak (renamed id, reordered fields) does not silently break us.
async function findNameInput(page) {
  return firstVisible(page, [
    () => page.getByLabel(/^name\s*\*?$/i),
    () => page.locator('input[placeholder*="name" i]:not([placeholder*="surname" i])'),
    () => page.locator('input[name*="name" i]:not([name*="surname" i]):not([name*="last" i])'),
    () => page.locator('input[id*="name" i]:not([id*="surname" i]):not([id*="last" i])'),
    () => page.locator('input[name="FirstName"], input[id="FirstName"]'),
  ]);
}

async function findSurnameInput(page) {
  return firstVisible(page, [
    () => page.getByLabel(/^surname\s*\*?$/i),
    () => page.getByLabel(/last\s*name/i),
    () => page.locator('input[placeholder*="surname" i], input[placeholder*="last name" i]'),
    () => page.locator('input[name*="surname" i], input[name*="lastname" i], input[name*="last_name" i]'),
    () => page.locator('input[id*="surname" i], input[id*="lastname" i]'),
    () => page.locator('input[name="LastName"], input[id="LastName"]'),
  ]);
}

async function findLicenseInput(page) {
  return firstVisible(page, [
    () => page.getByLabel(/licen[sc]e\s*(number)?/i),
    () => page.locator('input[placeholder*="licen" i]'),
    () => page.locator('input[name*="licen" i], input[id*="licen" i]'),
    () => page.locator('input[name*="regno" i], input[id*="regno" i]'),
  ]);
}

async function findSubmit(page) {
  return firstVisible(page, [
    () => page.getByRole('button', { name: /search|verify|submit|ค้นหา/i }),
    () => page.locator('button[type="submit"]'),
    () => page.locator('input[type="submit"]'),
    () => page.locator('button:has-text("Search")'),
  ]);
}

// Wait for a results region (table or "no result" message) to appear after submit.
// Returns one of: { kind: 'table', rows } | { kind: 'empty' } | { kind: 'none' }
async function waitForResults(page, deadline) {
  const remaining = Math.max(1000, Math.min(RESULT_WAIT_MS, deadline - Date.now()));

  // Race: a results table OR an explicit "not found / no data" message.
  const tableSel = 'table tbody tr, table.result tr, .result-table tr, [class*="result" i] table tr';
  const emptyRe = /no\s*(data|result|record)|not\s*found|ไม่พบ|ไม่มีข้อมูล/i;

  let sawTable = false;
  try {
    await page.waitForSelector(tableSel, { timeout: remaining, state: 'attached' });
    sawTable = true;
  } catch (_) {
    sawTable = false;
  }

  // Even if no table, check for an explicit empty-result message.
  let bodyText = '';
  try {
    bodyText = (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) || '';
  } catch (_) { bodyText = ''; }

  if (sawTable) {
    const rows = await extractRows(page).catch(() => []);
    if (rows.length > 0) return { kind: 'table', rows };
    // Table present but empty body — treat as empty result if message confirms.
    if (emptyRe.test(bodyText)) return { kind: 'empty' };
    return { kind: 'table', rows };
  }

  if (emptyRe.test(bodyText)) return { kind: 'empty' };
  return { kind: 'none' };
}

// Pull plausible result rows into arrays of cell text.
async function extractRows(page) {
  const rowSelectors = [
    'table tbody tr',
    'table tr',
    '.result-table tr',
    '[class*="result" i] table tr',
  ];
  for (const sel of rowSelectors) {
    try {
      const rows = await page.locator(sel).evaluateAll((trs) =>
        trs
          .map((tr) => Array.from(tr.querySelectorAll('td,th')).map((c) => (c.textContent || '').trim()))
          .filter((cells) => cells.length > 0 && cells.some((c) => c.length > 0))
      );
      // Drop a pure-header row (all cells look like labels, no data-ish content).
      const dataRows = rows.filter((cells) => cells.join(' ').trim().length > 0);
      if (dataRows.length > 0) return dataRows;
    } catch (_) { /* try next selector */ }
  }
  return [];
}

// ---- main entry --------------------------------------------------------------
async function scrapeLicense({ license_number, full_name_th, full_name_en }) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const { name, surname } = splitName({ full_name_en, full_name_th });
  const suppliedFull = (full_name_en && full_name_en.trim()) || (full_name_th && full_name_th.trim()) || `${name} ${surname}`.trim();
  const lic = String(license_number || '').trim();

  // Guard: without at least a name we cannot meaningfully query.
  if (!name && !surname) {
    return { status: 'unavailable', evidence: { reason: 'missing_name', adapter: 'tmc_scrape' } };
  }

  let browser = null;
  try {
    // Launch is the most failure-prone step (missing Chromium, sandbox, OOM):
    // any throw here is caught by the outer try and reported 'unavailable'.
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // Navigate.
    const resp = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    if (!resp || !resp.ok()) {
      return { status: 'unavailable', evidence: { reason: 'bad_navigation', http: resp ? resp.status() : null } };
    }

    // Redirect away from the expected host/path => upstream changed => unavailable.
    const landed = page.url();
    if (!/checkmd\.tmc\.or\.th/i.test(landed)) {
      return { status: 'unavailable', evidence: { reason: 'unexpected_redirect', url: landed } };
    }

    // Captcha / robot challenge => cannot proceed => unavailable (never not_found).
    if (await hasCaptcha(page)) {
      return { status: 'unavailable', evidence: { reason: 'captcha_detected', url: landed } };
    }

    // Locate the form fields. Missing required inputs => markup changed => unavailable.
    const nameInput = await findNameInput(page);
    const surnameInput = await findSurnameInput(page);
    if (!nameInput || !surnameInput) {
      return {
        status: 'unavailable',
        evidence: { reason: 'form_fields_missing', nameFound: !!nameInput, surnameFound: !!surnameInput },
      };
    }

    await nameInput.fill(name).catch(() => {});
    await surnameInput.fill(surname).catch(() => {});

    // License is optional on the form; fill if we have one and the field exists.
    if (lic) {
      const licInput = await findLicenseInput(page);
      if (licInput) await licInput.fill(lic).catch(() => {});
    }

    const submit = await findSubmit(page);
    if (!submit) {
      return { status: 'unavailable', evidence: { reason: 'submit_missing' } };
    }

    // Submit and wait for navigation/AJAX to settle, then for results to render.
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: Math.max(1000, deadline - Date.now()) }).catch(() => {}),
      submit.click({ timeout: NAV_TIMEOUT_MS }).catch(() => {}),
    ]);

    // A captcha can appear AFTER submit too.
    if (await hasCaptcha(page)) {
      return { status: 'unavailable', evidence: { reason: 'captcha_after_submit', url: page.url() } };
    }

    if (Date.now() > deadline) {
      return { status: 'unavailable', evidence: { reason: 'deadline_exceeded_pre_results' } };
    }

    const results = await waitForResults(page, deadline);

    if (results.kind === 'none') {
      // We never saw a results table NOR an explicit empty message: we cannot
      // tell apart "no record" from "page broke". Be safe: unavailable.
      return { status: 'unavailable', evidence: { reason: 'no_results_region', url: page.url() } };
    }

    if (results.kind === 'empty') {
      // Site explicitly told us there is no matching record.
      return {
        status: 'not_found',
        evidence: { adapter: 'tmc_scrape', queried: { name, surname, license: lic || null }, message: 'no_record' },
      };
    }

    // kind === 'table' — evaluate rows for a name match.
    const rows = results.rows || [];
    if (rows.length === 0) {
      return { status: 'unavailable', evidence: { reason: 'empty_table', url: page.url() } };
    }

    let anyMatch = false;
    const matchedRows = [];
    for (const cells of rows) {
      const rowText = cells.join(' ');
      if (namesMatch(suppliedFull, rowText)) {
        anyMatch = true;
        matchedRows.push(cells);
      }
    }

    if (anyMatch) {
      return {
        status: 'verified',
        evidence: {
          adapter: 'tmc_scrape',
          queried: { name, surname, license: lic || null },
          matched_rows: matchedRows.slice(0, 3),
          row_count: rows.length,
        },
      };
    }

    // Records were returned (e.g. a license-number hit) but NONE match the name.
    return {
      status: 'name_mismatch',
      evidence: {
        adapter: 'tmc_scrape',
        queried: { name, surname, license: lic || null },
        sample_rows: rows.slice(0, 3),
        row_count: rows.length,
      },
    };
  } catch (err) {
    // Timeouts, navigation errors, launch failures — all are non-definitive.
    return {
      status: 'unavailable',
      evidence: { reason: 'scrape_exception', message: err && err.message ? err.message : String(err) },
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) { /* swallow close errors */ }
    }
  }
}

module.exports = { scrapeLicense, normalizeName, namesMatch, splitName };
