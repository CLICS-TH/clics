# Validate the Stage-2 build on `clics-scaletest` (pre-prod runbook)

Validates the 2026-06-09/10 work — **Google + invite onboarding (License/TMC retired)**, broadened
PII de-identification, and **structured patient intake** — on the kept test Supabase before any prod
deploy. Earlier sessions already applied `migration-councils/license-invites/scale.sql` there and
configured SMTP + the `{{ .Token }}` OTP templates; the Google Cloud OAuth client was deleted and
must be recreated.

Grab from the scaletest dashboard → Settings → API: the **project URL**, **anon key**, and
**service-role key**.

## 1. Run the 2 new migrations (SQL editor; both single-run, idempotent)
1. `db/migration-drop-license-gate.sql` — **required before testing auditor invites** (the old
   `enforce_auditor_license` trigger would 500 an auditor accept under the new no-license model).
2. `db/migration-patient-intake.sql` — creates `cle_patient_refs`.

## 2. Supabase dashboard
- **Auth → Providers → Google**: create a NEW Google Cloud OAuth client; redirect URI
  `https://<scaletest-ref>.supabase.co/auth/v1/callback`; paste ID/secret; enable.
- **Auth → URL Configuration → Redirect URLs**: add `http://localhost:3000`,
  `http://localhost:3000/auth/callback`, `http://localhost:3000/reset`.
- SMTP + `{{ .Token }}` in BOTH "Confirm signup" and "Magic Link" templates: already configured —
  verify still present (invite password-OTP + forgot-password depend on it).

## 3. Start the backend against scaletest
```bash
cd backend
SUPABASE_URL=https://<scaletest-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
SUPABASE_ANON_KEY=<anon-key> \
OAUTH_ENABLED=true \
IDENTITY_ENC_KEY=$(openssl rand -base64 32) \
ALLOWED_ORIGINS=http://localhost:3000 \
RIMPL_URL=http://localhost:3003 \
npm start          # :3001 — fail-closed env check only applies with NODE_ENV=production
```
If superadmin login later fails, seed the demo accounts once:
`SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node db/seed-users.js`

## 4. Automated auth E2E (no RIMPL needed)
```bash
cd backend
E2E_BASE=http://localhost:3001 \
SUPABASE_URL=https://<scaletest-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
E2E_SUPER_EMAIL=superadmin@clics.th E2E_SUPER_PW=<superadmin-pw> \
E2E_COUNCIL=DENT \
node ../scripts/e2e/new-auth-e2e.js --confirm
```
`E2E_COUNCIL=DENT` because the 80K seed filled TMC's physician pool. Expect green on: retired
`/auth/signup/email` → 404 · councils list · forgot-password 200 · Google gate · admin-provision →
P-NNN · invite lifecycle (create/view/duplicate-409/revoke-404) · **invite physician AND auditor →
201 active on accept** (the headline new behavior).

## 5. Frontend click-through
```bash
# physician-ui/public/js/config.js → CLICS_SUPABASE_URL + CLICS_SUPABASE_ANON_KEY = scaletest,
#                                    CLICS_API_URL = http://localhost:3001
cd physician-ui && npm run dev          # :3000
cd rimpl && PORT=3003 npm start         # only needed for CLE chat turns
```
Verify at `localhost:3000`: **Google sign-in** (first-time → council prompt → active) · **invite
accept** via password+OTP and via Google · **no License No. field anywhere** · `cle-new` shows the
**"ตัวระบุผู้ป่วย / Patient identifier (private)"** field · a chat turn streams (RIMPL up).

## 6. Verify the structured-intake isolation
Create a CLE with a name in the patient-identifier field and a name-free chief complaint, then:
```sql
select cle_id, physician_id, patient_ref from cle_patient_refs order by created_at desc limit 3;
```
The identifier must be ONLY here — never a column on `cles`, never inside `messages`
(`backend/tests/patient-intake.test.js` pins this structurally).

**Green on 4–6 = the Stage-2 onboarding + real-PII model is validated on a real DB.** Prod deploy is
then a repeat of the migrations + deploy: see [DEPLOY-STAGE2.md](DEPLOY-STAGE2.md).
