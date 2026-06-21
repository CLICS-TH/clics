# User Roles

| Role | Description | Backend role string |
|------|-------------|---------------------|
| **A — Superadmin** | Full system oversight (ICC calibration, user management, governance) | `superadmin` |
| **B — Admin** | Professional-body admin; manages the pilot cohort | `admin` |
| **C — Physician** | Completes CLEs, receives CPD credit | `physician` |
| **D — Expert Auditor** | Blind-reviews CLEs for ICC calibration | `auditor` |

All four are distinct roles enforced by `requireRole(...)` middleware in `backend/`. Superadmin is **not** an alias of admin — superadmin-only routes are `GET/POST/PATCH /admin/users`, `PATCH /admin/users/:id/status`, `GET/PATCH /admin/slots`, `GET /admin/icc`, `GET /admin/lpdp/:id`.

## Professional councils (สภาวิชาชีพ) & scoping

CLICS is organized by **professional council** (`councils` table — Medical/แพทยสภา, Pharmacy, Dental, Engineering, …; superadmin-seeded). Every physician/auditor/admin belongs to **exactly one** council (`professionals.council_id`); the **superadmin spans all** councils (`council_id = NULL`, enforced by the `prof_council_required` check).

- **Admin (B) is the "director" of one council** and sees only that council's C and D, CLEs, requests, ICC, and exports. Scoping is enforced in the **routes** (`scopeToCouncil`/`sameCouncil` in `admin.js`) — the backend uses the service-role key and bypasses RLS, so route filters are load-bearing; the council-scoped RLS policies are defense-in-depth for any future direct-JWT client.
- **Superadmin (A) sees every council** and a **per-council ICC breakdown** (`GET /admin/icc` returns `per_council`).
- Sessions denormalize `council_id` at creation (`cles.council_id`, `audit_scores.council_id`) so filtering/ICC never join `professionals` at 80K scale; this is set at write time and never re-synced on a council change.

### Specialty (the layer **under** council)

A council has **specialties** (`specialties` table, `council_id` FK; the 15 Royal Colleges seeded under the Medical Council — `db/migration-specialty.sql`). Every council-scoped user carries `professionals.specialty_id` plus a **position (ตำแหน่ง)** ladder `professionals.position` ∈ `extern/intern/resident/fellowship/staff/gp` (gp = General Practitioner). Sessions denormalize it as `cles.specialty_id` (same write-time pattern as `council_id`).

- **The admin/auditor pipeline is scoped by council × specialty.** `scopeBySpecialty` (`admin.js`) adds `.eq('specialty_id', …)` for an admin (skipped when the admin has none), so an admin sees only their own specialty's CLEs/members/auditors; **auditor assignment requires the same council AND the same specialty** (409 otherwise). Superadmin (no specialty) still spans all.
- **Required where it applies:** API-enforced (`checkSpecialty` in `lib/specialties.js`) for council-scoped roles **when the council has specialties** — non-medical test councils (PHARM/DENT/ENG) have none, so their users stay valid without one. A chosen specialty must belong to the chosen council.
- **Picked at onboarding/provisioning:** Google self-signup cascades council → specialty (public `GET /auth/specialties`); invites + superadmin create/edit carry `specialty_id` + `position`; the invitee inherits them on accept. Shown under the name in both nav bars.

## Account lifecycle, requests & slot pools

- **Google auto-verify (physicians):** a Google sign-in **auto-provisions an active physician** with the self-selected council and **no admin approval** (the load reducer for ~80K users). OAuth is gated by `OAUTH_ENABLED` and uses **Supabase's native Google provider** (real handshake — no stub). Email **Request access** still creates a Supabase auth user with **no** `professionals` row → **pending** (`code:pending`) until approved. Both paths require a `council_id`. Public email-OTP self-signup was **removed (2026-06-09)**; email+password **login** remains for superadmin/admin, admin-provisioned, and password-invite accounts.
- **A/B invite links (physicians AND auditors):** `POST /admin/invites` issues an email-bound link; accepting it (password+OTP or Google) **activates the user immediately** — the A/B invite *is* the vetting. The License No. + TMC verification gate was **retired (2026-06-09)**: no `pending_license_review`, no manual verify-license endpoint. The `license_*` columns, `license_verifications`, and `license-verifier/` stay **dormant** for reversibility (`db/migration-drop-license-gate.sql` drops only the `enforce_auditor_license` trigger).
- **Auditor (D) elevation always needs an A/B act** — an invite (above) or approval via the access-request queue (`GET /admin/access-requests`, `…/approve`, `…/reject`, nav "Requests"). Approval **assigns** the role + council and consumes a slot. Admin may grant `physician`/`auditor` **within their own council**; only **superadmin** may grant `admin`; `superadmin` is never grantable (bootstrap-only via `seed-users.js`).
- **One person is either C or D, never both, and never evaluates their own work:** the assign route + the `audit_scores_guard` DB trigger reject assigning/scoring where the auditor is the physician, or the auditor's council ≠ the session's council.
- **Slot pools:** physicians are **uncapped** (Google self-signup); `admin`/`auditor` capacity is **per-council** (`council_slots`); `superadmin` stays a global singleton. Member management (add/edit/deactivate, set council) is **superadmin-only** (nav: "Users").
- **Guest** is a pseudo-role (no account): an ephemeral 2-prompt trial from the physician portal ("Try as guest"); nothing is persisted. See [constraints.md](constraints.md).

## Post-login routing (which app + landing)

Login happens on **either** front-end. The physician portal routes non-physicians to the dashboard (token hand-off); the dashboard routes every role to a shared role-aware `/home` landing.

| Role | Entry | Lands on |
|------|-------|----------|
| A Superadmin | dashboard `/login` | dashboard `/home` (role cards) → ICC / Users / LPDP |
| B Admin | dashboard `/login` | dashboard `/home` → CLEs / QA Queue / Stats |
| C Physician | physician-ui `/` | physician-ui `/dashboard` |
| D Auditor | dashboard `/login` | dashboard `/home` → scoring Queue |

**Nav is role-keyed** (`audit-dashboard/components/NavBar.tsx`): Admin sees CLEs / QA Queue / Stats only; Superadmin additionally sees Users + ICC; Auditor sees Queue only. Admin's auditor-assignment uses the admin-accessible `GET /admin/auditors`.

All four roles have working seeded accounts — see credentials in [deployment.md](deployment.md).
