# E2E Runbook — manual auth proof

The flows below **cannot be tested headlessly** — they need a real inbox and a
browser-driven Google handshake. The live proofs are: **Google sign-in (§3),
invite accept via password+OTP and via Google (§4), and forgot/reset (§2)**.
(Email-OTP self-signup and the TMC scraper are retired — §1/§5 are kept as
stubs.) Run this **after** the Supabase + env config in
[`AUTH-SETUP.md`](AUTH-SETUP.md) is done. This doc does not repeat that
checklist — it assumes it.

Conventions used below:

```bash
BASE=http://localhost:3001                       # or the deployed backend:
# BASE=https://backend-production-c12e4.up.railway.app
EMAIL=you+ple1@yourdomain.test                   # an inbox YOU can read
```

Get a council id for the Google flow (public, no auth):

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
| 1 | **Custom SMTP** (Auth → Settings → SMTP) | 2, 4 | OTP/reset email never arrives for non-team addresses |
| 2 | **`{{ .Token }}` in Confirm-signup + Magic-Link templates** (Auth → Email Templates) | 4 | Email is a magic *link*, not the **6-digit code** the API expects |
| 3 | **Google provider** + Client ID/Secret (Auth → Providers) | 3, 4-google | `signInWithOAuth` fails / no Google button |
| 4 | **Redirect URL allow-list** (Auth → URL Configuration): FE origins + `…/auth/callback` + `…/reset` + `localhost` | 2, 3 | Google/reset redirect rejected by Supabase |
| 5 | **Anon (publishable) key** in the FE env (`physician-ui` config.js / `audit-dashboard` Vercel) | 2-reset, 3, 4 | Browser OAuth + reset-page token exchange fail; service-role key must **never** be in a browser |
| 6 | `OAUTH_ENABLED=true` in `backend/.env` | 3, 4-google | `/auth/oauth/google/complete` and google-method accept **404** by design |
| 7 | Run `db/migration-license-invites.sql` (RUN 1 then RUN 2), `db/migration-scale.sql`, **and** `db/migration-drop-license-gate.sql` in the Supabase SQL editor | 4 | `invites` missing → invite create/accept 500s; without the drop-gate migration the retired `enforce_auditor_license` trigger still blocks auditor accepts |

Quick liveness before starting:

```bash
curl -s "$BASE/auth/councils" >/dev/null && echo "backend up"
```

---

## 1. Email-OTP physician self-signup — RETIRED (2026-06-09)

Public email-OTP self-signup was removed together with the License No./TMC
gate: the `/auth/signup/*` routes are gone. Physicians self-serve via
**Google (§3)** or an **A/B invite (§4)**; email+password **login**
(`POST /auth/login`) remains for superadmin/admin, admin-provisioned, and
password-invite accounts. The flow's DB pieces stay dormant for reversibility —
see `db/migration-drop-license-gate.sql`.

---

## 2. Forgot password → reset

**2a. Request a reset.** **Always** `200` (never leaks whether the account
exists). Use an account that exists — e.g. the password-invite physician
from §4.

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

Expected first time (HTTP **201**) — Google verifies the **email**; the
physician is active immediately:

```json
{ "access_token":"…",
  "user": { "id":"<uuid>", "role":"physician", "status":"active", … } }
```

The identity is read from the **server-validated** token (never the request
body) and the OAuth identity is encrypted into the on-prem vault. A returning
Google user gets `200` with their existing profile. If `OAUTH_ENABLED` is unset
this route returns `404 {"error":"Social sign-in is not available."}` (PREREQ 6).

---

## 4. Invite a physician + an auditor (superadmin) → accept

Invites are the **only** self-serve path that creates an auditor (role D).
Accepting an invite **activates the user immediately — auditors too**: the A/B
invite *is* the vetting. (The License No./TMC gate was retired 2026-06-09 — no
`pending_license_review`, no manual verify-license; the old enforcing trigger
is dropped by `db/migration-drop-license-gate.sql`.)

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
user and emails a code; the second verifies it.

```bash
# step 1 — sets password, sends the 6-digit code
curl -s -X POST "$BASE/auth/invite/$TOK/accept" -H 'content-type: application/json' \
  -d '{"method":"password","password":"Pilot12345","full_name_th":"สมหญิง ตรวจสอบ","full_name_en":"Somying Tructsob"}'
# -> 202 {"status":"otp_sent","email":"…"}

# step 2 — verify the emailed code; provisions in the invited role
curl -s -X POST "$BASE/auth/invite/$TOK/accept" -H 'content-type: application/json' \
  -d '{"method":"password","full_name_th":"สมหญิง ตรวจสอบ","full_name_en":"Somying Tructsob","otp":"<code>"}'
```

Expected on step 2 — HTTP **201** for **both** roles (the invite is the vetting):

- `{"status":"active","access_token":"…","user":{…,"role":"physician"|"auditor","status":"active"}}`
- re-accepting a used invite → `409 {"error":"This invite has already been used."}`

**4d-google. Accept with Google** (needs PREREQ 6; the Google **email must
match the invited email**). The browser does the OAuth handshake (as in §3) then
posts:

```bash
curl -s -X POST "$BASE/auth/invite/$TOK/accept" -H 'content-type: application/json' \
  -d '{"method":"google","access_token":"<supabase session token>"}'
# email mismatch -> 403 ; OAUTH disabled -> 404
```

Same `201` active response as above — auditors too.

**4e. Confirm the auditor is active.** Logging in as the just-accepted auditor
succeeds immediately:

```bash
curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d '{"email":"you+aud@yourdomain.test","password":"Pilot12345"}'
# -> 200 { "access_token":"…", "user":{…,"role":"auditor","status":"active"} }
```

---

## 5. TMC scraper — RETIRED (2026-06-09, kept dormant)

License No. + TMC verification no longer gate any account, so the
`license-verifier/` microservice is not part of any flow. The code is **kept
dormant** for reversibility — do not deploy it and leave
`LICENSE_VERIFIER_ADAPTER` / `LICENSE_VERIFIER_URL` unset. The historical
live-run findings (no captcha, ~14-15s/lookup, fail-to-`unavailable`) are
preserved in [`E2E-AUDIT-REPORT.md`](E2E-AUDIT-REPORT.md).
