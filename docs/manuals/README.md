# CLICS user manuals (Thai)

Two plain-Thai, step-by-step end-user guides for the pilot, written for non-technical physicians.

| File | สำหรับใคร / Audience |
|------|---------------------|
| [`clics-user-guide-th.pdf`](clics-user-guide-th.pdf) | **Role C — แพทย์ผู้ใช้งาน / Physician (User).** The full journey in the physician portal: login → consent → create a CLE → chat with AI → end & submit → PIS-7 result → progress → payment. |
| [`clics-user-auditor-guide-th.pdf`](clics-user-auditor-guide-th.pdf) | **Special — ผู้ใช้ + ผู้ตรวจประเมิน / User + Auditor.** Self-contained: the physician flow **plus** switching into the audit dashboard and the auditor duties (blind PIS-7 scoring, AI reveal, ICC, peer calibration). |

## How it's built

Source (edit these), then regenerate:

```
source/
  style.css                         # shared A4 print stylesheet (Noto Sans/Serif Thai, WCAG-AA contrast)
  clics-user-guide-th.html          # Role C
  clics-user-auditor-guide-th.html  # Special
  img/{login,guest-composer}.png    # screenshots captured by the generator (public, login-free pages)
```

Regenerate both PDFs (and refresh the two screenshots from the live portal):

```bash
node scripts/manuals/generate.mjs
```

The generator (`scripts/manuals/generate.mjs`) uses the repo's existing **Playwright + Chromium**:
1. Captures two screenshots from the **public** prod portal — the login card (`/`) and the chat composer
   (`/guest-chat`, textarea pre-filled, **never sent** → no AI spend). Override the target with `PORTAL_BASE`.
2. Renders each `source/*.html` to PDF via headless Chromium `page.pdf()` (A4), waiting for the Noto Thai
   web fonts to finish loading (`document.fonts.ready`) so Thai never renders as tofu.

## Conventions

- **Bilingual UI labels** are quoted verbatim from the live product (chips like
  `จบและส่ง / End`) so a reader can match exactly what's on screen. The prose is Thai.
- **Visuals** are CSS/SVG mockups except the two real screenshots above (per the "hybrid" choice).
- **Accuracy:** the PIS-7 rubric, weights, routes, and button text mirror the source
  (`audit-dashboard/lib/pis7-rubric.ts`, `lib/labels.ts`, the physician-ui `public/*.html`,
  and the auditor pages). If those change, re-verify and regenerate.
- **No secrets:** the manuals never include demo credentials — real users onboard via Google or an invite.
