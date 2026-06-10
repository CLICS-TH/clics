# Deploy the Stage-2 build to production

Run **after** [VALIDATE-SCALETEST.md](VALIDATE-SCALETEST.md) is green. Ships: Google + invite
onboarding (License/TMC retired), multi-council, 80K-scale, broadened PII de-identification,
structured patient intake, reconcile sweep.

## 1. Merge + migrations
1. Merge PR #3 to `master`; `git checkout master && git pull` (deploys run from the local tree).
2. Prod Supabase SQL editor, **in this order** (1–2 are two-query RUN 1 then RUN 2; 3–4 single-run;
   all idempotent):
   1. `db/migration-license-invites.sql` (verify the three zero-null SELECTs first)
   2. `db/migration-scale.sql`
   3. `db/migration-drop-license-gate.sql` ← **must land with (or before) the backend deploy** —
      the old trigger 500s auditor invite-accepts under the new model
   4. `db/migration-patient-intake.sql`
3. Spot-check: `invites` / `license_verifications` / `ple_patient_refs` exist; `next_pseudonym()`
   returns a value; `enforce_auditor_license_trg` is GONE.

## 2. Prod Supabase dashboard (per docs/AUTH-SETUP.md)
- **Custom SMTP with a VERIFIED sending domain** (sandbox only mails your own address — invitees and
  forgot-password need real delivery) + `{{ .Token }}` in BOTH "Confirm signup" and "Magic Link".
- **Google provider** with a **prod** OAuth client → redirect `https://<prod-ref>.supabase.co/auth/v1/callback`.
- **Redirect URLs**: both prod front-end origins + `/auth/callback` + `/reset`.
- **Auth rate limits**: raise `otp`/`email` (~60/hr); plan staggered onboarding (50–100 concurrent
  logins trip GoTrue — docs/LOADTEST-2026-06.md).

## 3. Env vars
- **Backend (Railway)**: `SUPABASE_ANON_KEY` ← **required, fails closed in prod without it**;
  `OAUTH_ENABLED=true`; `SITE_URL=<prod physician-ui>`; `INVITE_EXPIRY_DAYS=7`; optional
  `RECONCILE_INTERVAL_MS` (default 6h sweep). Leave `LICENSE_VERIFIER_ADAPTER` unset (retired/dormant).
- **audit-dashboard (Vercel)**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  (+ existing `NEXT_PUBLIC_API_URL`).
- **physician-ui**: fill `public/js/config.js` `CLICS_SUPABASE_URL` + `CLICS_SUPABASE_ANON_KEY`
  (public values; commit), confirm `CLICS_API_URL`/`CLICS_DASHBOARD_URL` still match prod.

## 4. Deploy + smoke
```bash
cd backend         && railway up . --path-as-root --service backend --ci
cd ../rimpl        && railway up . --path-as-root --service rimpl   --ci
cd ../audit-dashboard && vercel --prod --yes
cd ../physician-ui    && vercel --prod --yes
curl https://<backend>/health        # {"status":"ok"}
```
Smoke (mirror VALIDATE-SCALETEST steps 4–6 against prod, gently): all 4 role logins · one Google
sign-in · one invite create→accept (physician AND auditor → active) · one PLE with the patient-
identifier field · `/admin/ples` load-more + X-Total-Count.

## 5. Before real participants (org gates — team-only)
IRB/ethics approval + final TH/EN consent text deployed · clear demo cohort (`db/reset-demo.js`,
deliberate — test history is currently kept on purpose) + change superadmin password + rotate
`ANTHROPIC_API_KEY` · data region/DPA/retention sign-off · participant comms (staggered logins,
"identifiers in the private field, not the narrative") · **CME credit stays OFF until ICC ≥ 0.75**
(see `scripts/calibration/`).
