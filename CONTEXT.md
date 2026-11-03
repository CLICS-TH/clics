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

**Google sign-in**:
Signing in to the Portal with a Google account, whether to sign up, to accept an invite, or to link Google to an existing account.
_Avoid_: OAuth login, social login

**Google sign-in mode**:
Which way a Google sign-in reaches Google: in the Portal's own page (the default), or by a redirect through Supabase (the fallback).
_Avoid_: GIS flag, OAuth mode

**Callback page**:
The Portal page at `/auth/callback` that finishes every Google sign-in, in either mode.
_Avoid_: redirect page, OAuth return

**OAuth rescue**:
The head script at the Portal root that forwards a stray sign-in return to the Callback page.
_Avoid_: root redirect

**Link Google**:
Adding Google sign-in to an account that already signs in with email and password.
_Avoid_: connect Google, merge accounts

**Sign out**:
Ending the session on this device and asking the server to end it everywhere. It looks the same to the user whether or not the server succeeds.
_Avoid_: logout (when meaning only clearing the browser), revoke

## Audit

**De-identified view**:
The only form in which an auditor sees a PLE: its case text and conversation after the PII filter, in the CLICS screens. Never the chief complaint, title or conversation as the physician typed them.
_Avoid_: blinded copy, redacted transcript, filtered PLE

## Booth

**Booth Mode**:
The kiosk version of the Portal that runs on the touch screen at the CCME booth of the National Forum on CME. It awards no prize and collects no personal data.
_Avoid_: kiosk app, demo mode, booth version

**Booth event**:
One venue's run of Booth Mode, named by an event code such as NFCME-2026, with its own case pool and leaderboard.
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

**Booth case**:
One fictional clinical case written for Booth Mode as a branching tree of three steps, in Thai with English beneath.
_Avoid_: trigger case, scenario, CT (those are DPU curriculum terms)

**Case pool**:
The admitted booth cases of one booth event, from which each booth play draws its case.
_Avoid_: case bank, case list

**Admission**:
A booth case passing the AI safety review and either the physician sandbox or an owner waiver of the sandbox (ADR 0005), which is what puts it in the case pool.
_Avoid_: approval, sign-off, physician read

**Physician sandbox**:
Simulated physicians (scripted paths and AI personas) playing every candidate booth case through the real evaluator, to check that the cases are of matched difficulty. It writes no booth plays.
_Avoid_: dry run, simulation (alone), test players

**Case teaser**:
The card that shows a visitor which booth case they drew: presenting complaint and setting, never the diagnosis.
_Avoid_: case title, preview

**Reroll**:
A visitor drawing a different booth case from the case pool before the play starts.
_Avoid_: gacha, shuffle, skip

**Grill play**:
The booth play's dialogue: the AI asks one question per step and offers three choices from the option bank, never marking a best one.
_Avoid_: Socratic mode (that is the pilot's rescue tutor), quiz

**Option bank**:
The reviewed question variants and options that a booth case holds for one point on its branching path.
_Avoid_: choice pool, answer key

**Tier**:
The quality grade of a booth option or answer: best, reasonable, or weaker but safe. Each question offers one option of each tier.
_Avoid_: grade, level, difficulty

**Band descriptor**:
The fixed Thai and English line that says what a score band in one PIS-7 domain means and what to practise next.
_Avoid_: AI feedback, comment, rationale (the evaluator's rationale is a different thing)
