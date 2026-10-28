# CLICS

CLICS scores physician clinical reasoning from physician–AI dialogue sessions (PLEs) to award CME/CPD credit. This glossary holds the project's own terms; domain detail lives in `docs/domain-concepts.md`.

## Sign-in

**Portal**:
The physician-ui front-end: the one place every role signs in.
_Avoid_: physician portal (when meaning the sign-in front door for all roles), front door

**Login page**:
The Portal page at `/login` that holds the sign-in form.
_Avoid_: index, home

**Landing page**:
The public page at the Portal root `/`, readable without signing in.
_Avoid_: login, splash

**Privacy page**:
The public Portal page at `/privacy` that states what personal data CLICS collects, who processes it, and the reader's rights.
_Avoid_: privacy policy page, PDPA page, terms

**Handoff**:
The Portal passing a signed-in admin, auditor or superadmin to the audit-dashboard with their token.
_Avoid_: SSO, redirect login
