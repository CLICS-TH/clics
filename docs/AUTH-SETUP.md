# Auth & Signup Setup (email OTP · Google · license verify · invites)

The secure-signup overhaul has **dashboard/infra prerequisites that are not code**. Email and Google flows silently fail for real users until these land. Do this once per environment.

## 1. Supabase dashboard (the hard gate)

| Setting | Where | Why |
|---|---|---|
| **Custom SMTP provider** (SendGrid/SES/Mailgun…) | Auth → Settings → SMTP | The built-in mailer only delivers to project-team addresses — real physicians/auditors get no OTP/reset email without this. |
| **`{{ .Token }}` in BOTH "Confirm signup" AND "Magic Link" templates** | Auth → Email Templates | This template edit (not a code argument) makes the email a **6-digit OTP** instead of a link. The new-signup path (admin-created, unconfirmed account) sends the **"Confirm signup"** template — editing only "Magic Link" is not enough. (Template editing unlocks only after custom SMTP is configured.) |
| **Confirm signup / Reset Password templates** | Auth → Email Templates | Branded copy + correct token/link. |
| **Google provider** + Client ID/Secret | Auth → Providers → Google | Required for `signInWithOAuth({provider:'google'})`. Create the OAuth client in Google Cloud Console first. |
| **Redirect URL allow-list** | Auth → URL Configuration | Add both front-end origins + `…/auth/callback` + `…/reset` + `localhost`. |
| **Auth rate limits** (`otp`, `email`) | Auth → Rate Limits | Throttle OTP send + brute-force. Custom SMTP starts at 30 emails/hr — raise as needed. |
| **Anon (publishable) key** | Project → API | Copy into the front-end env (below). The **service-role key never goes to a browser**. |

## 2. Env vars

**backend** (`backend/.env`): `SUPABASE_ANON_KEY`, `SITE_URL`, `OAUTH_ENABLED`, `INVITE_EXPIRY_DAYS`, `IDENTITY_ENC_KEY`, and the license vars (`LICENSE_VERIFIER_ADAPTER`, `LICENSE_VERIFIER_URL`, scrape tuning). See `backend/.env.example`.

**audit-dashboard** (Vercel): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (+ existing `NEXT_PUBLIC_API_URL`).

**physician-ui**: `window.CLICS_SUPABASE_URL` / `window.CLICS_SUPABASE_ANON_KEY` in `public/js/config.js` (public values).

## 3. License verification

- Default `LICENSE_VERIFIER_ADAPTER=stub` (deterministic, no network) — safe everywhere, used for all non-prod testing.
- Set `LICENSE_VERIFIER_ADAPTER=tmc_scrape` + `LICENSE_VERIFIER_URL` only after the scraper microservice (`license-verifier/`) is deployed and reviewed.
- **Gate:** physicians (C) activate even when `license_status='unverified'` (A/B review); auditors (D) need `verified`/`manual_verified` — an admin can override via the users page when the scraper is down.
- The scraper sends name+license to TMC's own site only (sanctioned scoped egress); evidence is stored **encrypted**; it is never routed through RIMPL/cloud.

## 4. Run the schema migration

`db/migration-license-invites.sql` in the Supabase SQL editor as **two queries** (RUN 1 STRUCTURE, then RUN 2 RLS).
