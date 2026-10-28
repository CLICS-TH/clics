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

## Booth

**Booth Mode**:
The kiosk version of the Portal that runs on the touch screen at the CCME booth of the National Forum on CME. It awards no prize and collects no personal data.
_Avoid_: kiosk app, demo mode, booth version

**Booth event**:
One venue's run of Booth Mode, named by an event code such as NFCME-2026, with its own case and leaderboard.
_Avoid_: batch, campaign, venue (alone)

**Booth play**:
One visitor's run on the booth screen, from tap to demo score. It is not a PLE: it earns no credit and never enters pilot data.
_Avoid_: booth PLE, booth session, demo PLE

**Demo score**:
The PIS-7 score a booth play earns, always shown as a demo: not CME credit and not validated.
_Avoid_: CME score, credit, PIS-7 score (alone)

**Booth tag**:
The auto-made label, such as "Booth #042", that names one visitor's play on the booth leaderboard. The visitor never types it.
_Avoid_: nickname, username, player name
