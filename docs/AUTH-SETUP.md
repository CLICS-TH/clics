# Auth & Onboarding Setup (Google · invites · OTP emails)

Onboarding is **Google self-service for physicians (auto-active) + A/B invite links for physicians and auditors (an invite activates the user immediately on accept)**. Public email-OTP self-signup and the License No./TMC gate were **retired 2026-06-09** (see §3); email+password **login** remains for superadmin/admin, admin-provisioned, and password-invite accounts. The live flows have **dashboard/infra prerequisites that are not code** — invite/reset emails and Google sign-in silently fail for real users until these land. Do this once per environment.

## 1. Supabase dashboard (the hard gate)

| Setting | Where | Why |
|---|---|---|
| **Custom SMTP provider** (SendGrid/SES/Mailgun…) | Auth → Settings → SMTP | The built-in mailer only delivers to project-team addresses — real physicians/auditors get no OTP/reset email without this. |
| **`{{ .Token }}` in BOTH "Confirm signup" AND "Magic Link" templates** | Auth → Email Templates | This template edit (not a code argument) makes the email a **6-digit OTP** instead of a link. The invite password path (admin-created, unconfirmed account) sends the **"Confirm signup"** template — editing only "Magic Link" is not enough. (Template editing unlocks only after custom SMTP is configured.) |
| **Confirm signup / Reset Password templates** | Auth → Email Templates | Branded copy + correct token/link. |
| **Google provider** + Client ID/Secret | Auth → Providers → Google | Required for `signInWithOAuth({provider:'google'})`. Create the OAuth client in Google Cloud Console first. For the in-page mode below, the same client ID must be listed among the provider's client IDs and **Skip nonce checks must stay off**. |
| **Redirect URL allow-list** | Auth → URL Configuration | Add both front-end origins + `…/auth/callback` + `…/reset` + `localhost`. |
| **Auth rate limits** (`otp`, `email`) | Auth → Rate Limits | Throttle OTP send + brute-force. Custom SMTP starts at 30 emails/hr — raise as needed. |
| **Anon (publishable) key** | Project → API | Copy into the front-end env (below). The **service-role key never goes to a browser**. |

## 1b. Google sign-in mode (in-page vs redirect, ADR 0007)

The Portal asks Google itself through Google Identity Services (GIS), so Google's chooser names `physician-ui.vercel.app` instead of the Supabase project domain. `physician-ui/public/js/config.js` holds the switch:

| Config | Meaning |
|---|---|
| `CLICS_GOOGLE_SIGNIN = { login, invite, link }` | Per flow, `'gis'` (default) or `'redirect'` (the old Supabase redirect). Only `login` is wired today; invite and Link Google follow. |
| `CLICS_GOOGLE_ORIGINS` | Allow-list of page origins where `gis` runs: `https://physician-ui.vercel.app`, `http://localhost:3000`. Any other origin (Vercel previews) uses the redirect. Must match the OAuth client's **Authorized JavaScript origins** exactly (no wildcards). |
| `CLICS_GOOGLE_CLIENT_ID` | Public OAuth client ID of the Supabase Google provider. **Empty keeps every flow on the redirect**, so `gis` goes live only when this is filled (console ticket #282). |

How it runs: pressing "Continue with Google" loads Google's script (never on page load), swaps in Google's own button (popup, no One Tap), trades the credential with `signInWithIdToken` and a fresh hashed nonce, writes the same flow marker the redirect writes, and goes to `/auth/callback#access_token=…`. The Callback page finishes both modes. **Rollback:** set the flow to `'redirect'` and redeploy.

## 2. Env vars

**backend** (`backend/.env`): `SUPABASE_ANON_KEY`, `SITE_URL`, `OAUTH_ENABLED`, `INVITE_EXPIRY_DAYS`, `IDENTITY_ENC_KEY`. See `backend/.env.example`. (The license vars — `LICENSE_VERIFIER_ADAPTER`, `LICENSE_VERIFIER_URL`, scrape tuning — are **dormant**; leave them unset, see §3.)

**audit-dashboard** (Vercel): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (+ existing `NEXT_PUBLIC_API_URL`).

### Invite emails (backend mailer)

The backend sends invite accept-links itself (not via Supabase Auth) using `backend/src/lib/mailer.js`. In prod it sends through the **Resend HTTPS API**: set `RESEND_API_KEY` and `MAIL_FROM`. Railway's egress drops outbound SMTP, so SMTP (`SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, see `backend/.env.example`) is only a fallback for hosts that allow it; when both are set, `RESEND_API_KEY` wins. It is **fail-soft**: enabled only when `MAIL_FROM` and one of `RESEND_API_KEY` / `SMTP_HOST` are set; left unset, `POST /admin/invites` still succeeds and returns `accept_url` + `email_sent:false`, so admins copy the link manually. The same caveat as §1 applies — until a sending domain is verified at Resend, its sandbox delivers only to the account owner's address, and everyone else gets the copy-link fallback.

**physician-ui**: `window.CLICS_SUPABASE_URL` / `window.CLICS_SUPABASE_ANON_KEY` in `public/js/config.js` (public values).

## 3. License verification — RETIRED (2026-06-09, kept dormant)

License No. + TMC verification no longer gate any account: a Google sign-in auto-activates a physician, and an **A/B invite activates the invitee — auditors too — immediately on accept** (the invite *is* the vetting). There is no `pending_license_review` state and no manual verify-license endpoint anymore. For reversibility the `license_*` columns, the `license_verifications` table, and the `license-verifier/` microservice are **kept dormant** (no longer written, not deployed); only the enforcing DB trigger is removed — `db/migration-drop-license-gate.sql` drops `enforce_auditor_license` and nothing else.

## 4. Run the schema migrations

`db/migration-license-invites.sql` in the Supabase SQL editor as **two queries** (RUN 1 STRUCTURE, then RUN 2 RLS) — still required: it creates the `invites` table. Then `db/migration-drop-license-gate.sql` (single run) to drop the retired license-gate trigger.
