# User Roles

| Role | Description | Backend role string |
|------|-------------|---------------------|
| **A — Superadmin** | Full system oversight (ICC calibration, user management, governance) | `superadmin` |
| **B — Admin** | Professional-body admin; manages the pilot cohort | `admin` |
| **C — Physician** | Completes PLEs, receives CPD credit | `physician` |
| **D — Expert Auditor** | Blind-reviews PLEs for ICC calibration | `auditor` |

All four are distinct roles enforced by `requireRole(...)` middleware in `backend/`. Superadmin is **not** an alias of admin — superadmin-only routes are `GET/POST/PATCH /admin/users`, `PATCH /admin/users/:id/status`, `GET/PATCH /admin/slots`, `GET /admin/icc`, `GET /admin/lpdp/:id`.

## Account lifecycle, requests & slot pools

- **Invite/approve only:** new people use **Request access** (physician portal — email or Google/LINE). A request creates a Supabase auth user but **no** `professionals` row, so they stay **pending** (`verifyJwt`/`login` return 403 `code:pending`) until approved. No self-activation; requesters never self-assign a role.
- **Approval queue** (`GET /admin/access-requests`, `…/approve`, `…/reject`) is visible to **admin _and_ superadmin** (nav: "Requests"). Approval **assigns** the role and consumes a slot. Admin may grant `physician`/`auditor`; only **superadmin** may grant `admin`; `superadmin` is never grantable (pool = 1, bootstrap-only via `seed-users.js`).
- **Role slot pools** (`role_slots`) and **member management** (add/edit/deactivate any member) are **superadmin-only** (nav: "Users"). Caps are enforced on approval/create/reactivate (full pool → 409). Deactivated members free their slot; `verifyJwt` 403s them (`code:deactivated`).
- **Guest** is a pseudo-role (no account): an ephemeral 2-prompt trial from the physician portal ("Try as guest"); nothing is persisted. See [constraints.md](constraints.md).

## Post-login routing (which app + landing)

Login happens on **either** front-end. The physician portal routes non-physicians to the dashboard (token hand-off); the dashboard routes every role to a shared role-aware `/home` landing.

| Role | Entry | Lands on |
|------|-------|----------|
| A Superadmin | dashboard `/login` | dashboard `/home` (role cards) → ICC / Users / LPDP |
| B Admin | dashboard `/login` | dashboard `/home` → PLEs / QA Queue / Stats |
| C Physician | physician-ui `/` | physician-ui `/dashboard` |
| D Auditor | dashboard `/login` | dashboard `/home` → scoring Queue |

**Nav is role-keyed** (`audit-dashboard/components/NavBar.tsx`): Admin sees PLEs / QA Queue / Stats only; Superadmin additionally sees Users + ICC; Auditor sees Queue only. Admin's auditor-assignment uses the admin-accessible `GET /admin/auditors`.

All four roles have working seeded accounts — see credentials in [deployment.md](deployment.md).
