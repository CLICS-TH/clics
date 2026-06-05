# User Roles

| Role | Description | Backend role string |
|------|-------------|---------------------|
| **A — Superadmin** | Full system oversight (ICC calibration, user management, governance) | `superadmin` |
| **B — Admin** | Professional-body admin; manages the pilot cohort | `admin` |
| **C — Physician** | Completes PLEs, receives CPD credit | `physician` |
| **D — Expert Auditor** | Blind-reviews PLEs for ICC calibration | `auditor` |

All four are distinct roles enforced by `requireRole(...)` middleware in `backend/`. Superadmin is **not** an alias of admin — superadmin-only routes are `GET/POST /admin/users`, `GET /admin/icc`, `GET /admin/lpdp/:id`.

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
