# E2E Runbook — manual auth/signup proof

The flows below **cannot be tested headlessly** — they need a real inbox, a
browser-driven Google handshake, and (for the scraper) live Chromium reaching a
third-party site. Run this **after** the Supabase + env config in
[`AUTH-SETUP.md`](AUTH-SETUP.md) is done. This doc does not repeat that
checklist — it assumes it.

Conventions used below:

```bash
BASE=http://localhost:3001                       # or the deployed backend:
# BASE=https://backend-production-c12e4.up.railway.app
EMAIL=you+ple1@yourdomain.test                   # an inbox YOU can read
```

Get a council id for the signup flows (public, no auth):

```bash
curl -s "$BASE/auth/councils" | head
# -> [{"id":"<uuid>","code":"TMC","name_th":"…","name_en":"…"}, …]
COUNCIL=<paste a council uuid>
```

---

## 0. PREREQS (gate — do these once per environment)

Full detail in [`AUTH-SETUP.md`](AUTH-SETUP.md). These are the items each flow
below **depends on**; if a flow fails, re-check the matching row first.

| # | Prereq | Needed by | Symptom if missing |
|---|---|---|---|
| 1 | **Custom SMTP** (Auth → Settings → SMTP) | 2, 3, 5 | OTP/reset email never arrives for non-team addresses |
| 2 | **Magic Link template → `{{ .Token }}`** (Auth → Email Templates) | 2, 5 | Email is a magic *link*, not the **6-digit code** the API expects |
| 3 | **Google provider** + Client ID/Secret (Auth → Providers) | 4, 5-google | `signInWithOAuth` fails / no Google button |
| 4 | **Redirect URL allow-list** (Auth → URL Configuration): FE origins + `…/auth/callback` + `…/reset` + `localhost` | 3, 4 | Google/reset redirect rejected by Supabase |
| 5 | **Anon (publishable) key** in the FE env (`physician-ui` config.js / `audit-dashboard` Vercel) | 2-send, 4, 5 | Browser OTP send + OAuth fail; service-role key must **never** be in a browser |
| 6 | `OAUTH_ENABLED=true` in `backend/.env` | 4, 5-google | `/auth/oauth/google/complete` and google-method accept **404** by design |
| 7 | Run `db/migration-license-invites.sql` (RUN 1 then RUN 2) **and** `db/migration-scale.sql` in the Supabase SQL editor | 2, 5, 6 | `invites` / `license_verifications` / `license_status` missing; signup 500s |

Quick liveness before starting:

```bash
curl -s "$BASE/auth/councils" >/dev/null && echo "backend up"
```

---

## 1. Email-OTP physician signup → active physician

**1a. Request the code.** `201`/`202` body is identical whether or not the email
already exists (no enumeration). Password policy: ≥10 chars, ≥1 letter, ≥1 digit.

```bash
curl -s -X POST "$BASE/auth/signup/email" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Pilot12345\",\"council_id\":\"$COUNCIL\",\"full_name_th\":\"สมชาย ใจดี\",\"full_name_en\":\"Somchai Jaidee\",\"license_number\":\"12345\"}"
```

Expected (HTTP 202):

```json
{ "status": "otp_sent", "email": "you+ple1@yourdomain.test" }
```

**1b. Read the 6-digit code from the inbox** (depends on PREREQ 1 + 2). The
email body is the bare token, e.g. `481920`.

> No email? PREREQ 1 (SMTP) or 2 (`{{ .Token }}`). Resend (own limiter):
> `curl -s -X POST "$BASE/auth/signup/resend-otp" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}"`

**1c. Verify the code → license check (soft) → auto-provision physician.**

```bash
curl -s -X POST "$BASE/auth/signup/verify-otp" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"token\":\"481920\"}"
```

Expected (HTTP **201**):

```json
{
  "access_token": "eyJ…",
  "user": { "id": "<uuid>", "email": "you+ple1@yourdomain.test",
            "role": "physician", "status": "active",
            "pseudonym": "P-…", "license_status": "unverified" },
  "license_status": "unverified"
}
```

`license_status` reflects the verifier, **not** a gate — a physician is `active`
regardless (A/B review later). With the default `stub` adapter the result is
deterministic from the license number's last digit: `…1/3` → `name_mismatch`,
`…5/7/9` → `not_found`, anything else / `UNAVAIL` → `unverified`. Bad/expired
code → `400 {"error":"Invalid or expired code."}`. Re-verifying an
already-provisioned email is idempotent → `200` with the existing user.

---

## 2. Forgot password → reset

**2a. Request a reset.** **Always** `200` (never leaks whether the account
exists).

```bash
curl -s -X POST "$BASE/auth/forgot-password" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\"}"
# -> {"ok":true}
```

**2b. Open the reset link** from the inbox (depends on PREREQ 1; link target is
allow-listed via PREREQ 4 — it points at `…/reset`).

**2c. Set a new password** on the `/reset` page (the page exchanges the recovery
token client-side via the anon key and calls Supabase `updateUser`). Confirm by
logging in with the new password:

```bash
curl -s -X POST "$BASE/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"NewPilot12345\"}"
# -> 200 { "access_token":"…", "user":{…,"role":"physician"} }
```

---

## 3. Google login (physician) — UI steps

Needs PREREQ 3, 4, 5, 6. This is browser-driven; there is no headless curl path
(the access token only exists after a real Google consent screen).

1. Open the physician portal sign-in page; click **Continue with Google**. The
   FE calls `supabase.auth.signInWithOAuth({ provider: 'google' })`.
2. Complete the Google consent screen. Supabase redirects back to the
   allow-listed `…/auth/callback`; the FE now holds a Supabase **session**.
3. The FE posts the session to the backend with the chosen council:

   ```bash
   # (the browser does this; shown for reference / debugging)
   curl -s -X POST "$BASE/auth/oauth/google/complete" \
     -H 'content-type: application/json' \
     -d "{\"access_token\":\"<supabase session access_token>\",\"council_id\":\"$COUNCIL\"}"
   ```

Expected first time (HTTP **201**) — Google verifies the **email**, not the
license, so:

```json
{ "access_token":"…",
  "user": { "id":"<uuid>", "role":"physician", "status":"active", … },
  "license_status": "unverified" }
```

The identity is read from the **server-validated** token (never the request
body) and the OAuth identity is encrypted into the on-prem vault. A returning
Google user gets `200` with their existing profile. If `OAUTH_ENABLED` is unset
this route returns `404 {"error":"Social sign-in is not available."}` (PREREQ 6).

---

## 4. Invite a physician + an auditor (superadmin) → accept

Invites are the **only** path that creates an auditor (role D). Physician accept
is soft (active even if unverified); **auditor accept is hard** — stays
`pending_license_review` (deactivated) until a `verified`/`manual_verified`
license, enforced by a DB trigger from `migration-license-invites.sql`.

**4a. Get a superadmin/admin token** (admin routes require role `admin` or
`superadmin`):

```bash
SA=$(curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d '{"email":"superadmin@clics.local","password":"<superadmin password>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
echo "${SA:0:12}…"
```

**4b. Create the two invites.** Response includes a one-time **`accept_url`**
carrying the raw token (the DB stores only its sha256). Copy each `accept_url`.

```bash
# physician invite
curl -s -X POST "$BASE/admin/invites" -H "authorization: Bearer $SA" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"you+phys@yourdomain.test\",\"role\":\"physician\",\"council_id\":\"$COUNCIL\"}"

# auditor invite
curl -s -X POST "$BASE/admin/invites" -H "authorization: Bearer $SA" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"you+aud@yourdomain.test\",\"role\":\"auditor\",\"council_id\":\"$COUNCIL\"}"
```

Expected (HTTP **201** each):

```json
{ "id":"<uuid>", "email":"…", "role":"auditor", "status":"pending",
  "expires_at":"…",
  "accept_url":"http://localhost:3000/invite.html?token=<RAW_TOKEN>" }
```

`409` "A pending invite for this email and role already exists." → revoke first:
`curl -s -X DELETE "$BASE/admin/invites/<id>" -H "authorization: Bearer $SA"`.
Slot full → `409` from the slot check.

**4c. Inspect an invite** (extract the token from an `accept_url`):

```bash
TOK=<RAW_TOKEN from an accept_url>
curl -s "$BASE/auth/invite/$TOK"
# -> {"email":"…","role":"auditor","council":{"name_th":"…","name_en":"…"}}
# expired -> 410 ; unknown/used -> 404
```

**4d-password. Accept with a password (+OTP).** Two calls: the first creates the
user and emails a code; the second verifies it. **Auditors must send
`license_number`.**

```bash
# step 1 — sets password, sends the 6-digit code
curl -s -X POST "$BASE/auth/invite/$TOK/accept" -H 'content-type: application/json' \
  -d '{"method":"password","password":"Pilot12345","full_name_th":"สมหญิง ตรวจสอบ","full_name_en":"Somying Tructsob","license_number":"24680"}'
# -> 202 {"status":"otp_sent","email":"…"}

# step 2 — verify the emailed code; provisions in the invited role
curl -s -X POST "$BASE/auth/invite/$TOK/accept" -H 'content-type: application/json' \
  -d '{"method":"password","full_name_th":"สมหญิง ตรวจสอบ","full_name_en":"Somying Tructsob","license_number":"24680","otp":"<code>"}'
```

Expected on step 2:

- **physician invite** → HTTP **201**
  `{"status":"active","access_token":"…","user":{…,"role":"physician"},"license_status":"…"}`
- **auditor invite, license not yet `verified`** → HTTP **202**
  `{"status":"pending_license_review","user":{…,"role":"auditor"},"license_status":"not_found"|"name_mismatch"|"unverified"}`
  (the auditor row is `deactivated` — it cannot log in until 4f).

**4d-google. Accept with Google** (needs PREREQ 6; the Google **email must
match the invited email**). The browser does the OAuth handshake (as in §3) then
posts:

```bash
curl -s -X POST "$BASE/auth/invite/$TOK/accept" -H 'content-type: application/json' \
  -d '{"method":"google","access_token":"<supabase session token>","license_number":"24680"}'
# email mismatch -> 403 ; OAUTH disabled -> 404 ; auditor without license_number -> 400
```

Same `201` active / `202` pending_license_review split as above.

**4e. Confirm the auditor is blocked.** Logging in as the just-accepted auditor
should be refused while deactivated:

```bash
curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d '{"email":"you+aud@yourdomain.test","password":"Pilot12345"}'
# -> 403 {"error":"Account deactivated. Contact an administrator.","code":"deactivated"}
```

**4f. Activate the auditor (manual license override).** This is the valve for a
down scraper: marks `manual_verified` and flips the auditor to `active` (after a
slot check). Use the auditor's professional **id** (= their auth user id from
the accept response):

```bash
curl -s -X POST "$BASE/admin/users/<auditor_id>/verify-license" \
  -H "authorization: Bearer $SA"
# -> 200 {…,"role":"auditor","status":"active","license_status":"manual_verified"}
```

Now the auditor login from 4e succeeds (`200`).

---

## 5. TMC scraper — live, against the real Medical Council site

Standalone microservice in `license-verifier/`. It drives headless Chromium
against `https://checkmd.tmc.or.th/En/v3`. **Verified findings are recorded in
§5c** so you know what to expect before you run it.

**5a. Install + start** (Chromium download is required once):

```bash
cd license-verifier
npm install
npx playwright install chromium      # if npm install didn't fetch the browser
INTERNAL_TOKEN=dev-secret PORT=3004 node src/index.js
# -> [license-verifier] listening on :3004 (adapter target: TMC checkmd)
```

> If `INTERNAL_TOKEN` is unset the service logs a WARNING and **`/verify` rejects
> every request** (fail-closed).

**5b. Probe it** (from another shell):

```bash
curl -s localhost:3004/health
# -> {"status":"ok"}

# unauthorized (no / wrong token) -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3004/verify \
  -H 'content-type: application/json' -d '{"full_name_en":"x"}'
# -> 401

# a real lookup (synthetic name) — note: this hits the live TMC site, ~14-15s
curl -s -X POST localhost:3004/verify \
  -H 'content-type: application/json' \
  -H 'x-internal-token: dev-secret' \
  -d '{"full_name_en":"Somchai Jaidee","license_number":"12345"}'

# missing name -> immediate 'unavailable' (no network)
curl -s -X POST localhost:3004/verify \
  -H 'content-type: application/json' -H 'x-internal-token: dev-secret' \
  -d '{"license_number":"12345"}'
# -> {"status":"unavailable","evidence":{"reason":"missing_name","adapter":"tmc_scrape"}}
```

### 5c. VERIFIED FINDINGS (what the live run actually does)

- **Reaches `checkmd.tmc.or.th` with NO captcha.** The page loads on the
  expected host and no recaptcha/hcaptcha/"are you human" challenge appears
  before or after submit.
- **Fills + submits + parses end-to-end.** The Name/Surname/License inputs and
  the search button are located via the resilient selector strategies; the form
  submits and the results region is parsed.
- **A synthetic name returns `not_found` / `no_record`.** Querying a made-up
  name the site has no record for yields:
  ```json
  { "status":"not_found",
    "evidence":{"adapter":"tmc_scrape","queried":{"name":"Somchai","surname":"Jaidee","license":"12345"},"message":"no_record"} }
  ```
- **Missing-name validation works.** No `full_name_th`/`full_name_en` →
  `unavailable` with `reason:"missing_name"` immediately, no browser launch.
- **Latency ~14-15s per lookup** (Chromium launch + nav + networkidle + result
  wait). Budget for it; the backend wraps the adapter in a cache +
  single-flight + circuit breaker so this cost is paid rarely.
- **NOT yet confirmed: the `verified` / `name_mismatch` branch.** Proving a
  positive match (and the name-mismatch case) needs a **REAL licensed Thai
  physician name + license number** to query. Until someone runs that, treat
  those two branches as code-reviewed but not field-verified.
- **Everything uncertain collapses to `unavailable`** (captcha, missing
  selector, redirect off-host, timeout, launch error) — it **never** fabricates
  a `not_found`. The backend maps `unavailable` → `license_status:'unverified'`
  (fall back to admin manual verify), `not_found`/`name_mismatch` pass through.

### 5d. Wire the backend to the live scraper

Only after the legal/ToS position is confirmed and `unavailable` rates look
sane in staging. In `backend/.env`:

```bash
LICENSE_VERIFIER_ADAPTER=tmc_scrape
LICENSE_VERIFIER_URL=http://localhost:3004          # or the Railway internal URL
INTERNAL_TOKEN=dev-secret                            # MUST equal the verifier's INTERNAL_TOKEN
```

Restart the backend, then re-run §1c with a real name+license: the physician's
`license_status` now reflects the live TMC result instead of the stub. Default
stays `LICENSE_VERIFIER_ADAPTER=stub` everywhere until this flip is deliberate.
