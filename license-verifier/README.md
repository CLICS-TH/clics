# CLICS license-verifier

Dedicated microservice that verifies a Thai physician's medical license against
**The Medical Council of Thailand**'s public check site
(`https://checkmd.tmc.or.th/En/v3`) by driving a headless Chromium browser
(Playwright) and parsing the rendered results table.

It is the **real source** behind the CLICS backend's `tmc_scrape` adapter. The
backend calls this service over internal HTTP — it never scrapes directly, and
this service is never reachable from the RIMPL/cloud layer. Running Chromium
here keeps the heavy, fragile browser stack **off the API host**.

> ⚠️ **Best-effort / legally grey.** Scraping `checkmd.tmc.or.th` depends on a
> third party's markup and access policy. It **can and will break** when their
> HTML changes, when a captcha/recaptcha appears, or if they block automated
> traffic. This service is intentionally conservative: **any** uncertainty
> (captcha, missing selector, redirect off the expected host, timeout, launch
> error) returns `status: 'unavailable'` — it **never** silently reports
> `not_found`. The backend treats `unavailable` as "fall back to admin manual
> verification", protected by an in-process cache + single-flight + circuit
> breaker. Confirm the legal/ToS position with the pilot's Thai medical body
> before enabling this in production.

---

## Contract

### `POST /verify`

Guarded by a shared secret: the request **must** carry
`x-internal-token: <INTERNAL_TOKEN>` (same value as the backend's
`INTERNAL_TOKEN`). Missing/wrong token -> `401`.

Request body:

```json
{
  "license_number": "12345",        // optional on the TMC form; sent if present
  "full_name_th": "สมชาย ใจดี",      // either TH or EN name is required
  "full_name_en": "Somchai Jaidee"
}
```

Response (always HTTP 200 once authorized):

```json
{ "status": "verified" | "name_mismatch" | "not_found" | "unavailable",
  "evidence": { /* diagnostic detail: queried fields, matched rows, or reason */ } }
```

Status meaning:

| status         | meaning                                                                 |
|----------------|-------------------------------------------------------------------------|
| `verified`     | A returned record's name matches the supplied name (normalized).        |
| `name_mismatch`| Records were returned but **none** match the supplied name.             |
| `not_found`    | The site **explicitly** reported no matching record.                    |
| `unavailable`  | We could not get a definitive answer — captcha, markup change, redirect, timeout, or launch error. **Not** a negative result. |

Name matching normalizes both sides: NFC, lowercase, strip honorifics
(Thai `นพ./พญ./นาย/นางสาว/…` and English `Dr/Mr/Ms/Prof/MD/…`), drop
punctuation, collapse whitespace, and compare order-independently (the official
record may render surname-first or carry an extra middle name).

### `GET /health`

Unauthenticated liveness probe -> `{ "status": "ok" }`.

---

## Environment

| Var               | Default | Purpose                                                            |
|-------------------|---------|--------------------------------------------------------------------|
| `PORT`            | `3004`  | HTTP listen port.                                                  |
| `INTERNAL_TOKEN`  | *(unset)* | Shared secret for `/verify`. **If unset, `/verify` rejects everything (fail-closed).** Must equal the backend's `INTERNAL_TOKEN`. |
| `TMC_URL`         | `https://checkmd.tmc.or.th/En/v3` | Target page (override only for testing). |
| `SCRAPE_REQUEST_TIMEOUT_MS` | `25000` | Per-request hard deadline for the whole scrape.        |
| `SCRAPE_NAV_TIMEOUT_MS`     | `15000` | Navigation/action timeout.                             |
| `SCRAPE_RESULT_WAIT_MS`     | `12000` | Max wait for the results region to render.             |

---

## Run locally

```bash
npm install                 # also downloads Chromium for Playwright
INTERNAL_TOKEN=dev-secret npm start
# -> [license-verifier] listening on :3004

curl -s localhost:3004/health
# {"status":"ok"}

curl -s -X POST localhost:3004/verify \
  -H 'content-type: application/json' \
  -H 'x-internal-token: dev-secret' \
  -d '{"full_name_en":"Somchai Jaidee","license_number":"12345"}'
```

If `npm install` did not fetch the browser, run `npx playwright install chromium`.

## Run with Docker

The image is based on `mcr.microsoft.com/playwright` (Chromium + system deps
baked in), so no browser download at runtime.

```bash
docker build -t clics-license-verifier .
docker run --rm -p 3004:3004 -e INTERNAL_TOKEN=dev-secret clics-license-verifier
```

---

## Deploy on Railway

This service ships a `Dockerfile`, so Railway builds it directly (no Nixpacks).

1. **New service -> Deploy from repo**, root = this `license-verifier/`
   directory. Railway detects the `Dockerfile`.
2. **Variables:** set `INTERNAL_TOKEN` (a long random secret) — the **same**
   value configured on the backend service. `PORT` is provided by Railway; the
   service reads it automatically.
3. Railway exposes the service on its private network. Point the backend's
   `LICENSE_VERIFIER_URL` at this service's **internal** URL
   (e.g. `http://license-verifier.railway.internal:3004`) so the scrape traffic
   never leaves the private network.
4. **Health check path:** `/health`.

> Deploy command note (matches the CLICS deploy convention):
> `railway up . --path-as-root --ci` from this directory if deploying via CLI —
> plain `railway up` builds but never promotes.

---

## Switching the backend on/off (HOLD-FOR-REVIEW)

This service is **created but not enabled**. The backend stays on the stub until
explicitly flipped:

- Stub (default, no scraping):
  `LICENSE_VERIFIER_ADAPTER=stub`
- Real scraper:
  `LICENSE_VERIFIER_ADAPTER=tmc_scrape`
  plus `LICENSE_VERIFIER_URL=<this service>` and a matching `INTERNAL_TOKEN`.

Because the backend wraps this service in a **circuit breaker** and falls back to
**admin manual verification** on `unavailable`, a broken/blocked scraper degrades
gracefully — it can never block physician provisioning. Flip to `tmc_scrape`
only after confirming the legal position and watching `unavailable` rates in a
staging run.
