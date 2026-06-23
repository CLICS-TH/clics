# CLICS — Feature & Status Report for Management

**CLICS** (Continuous Learning & Intelligence Credit System) scores a physician's **clinical reasoning** from a real conversation with an AI tutor, to replace attendance-based CME/CPD credit. This report summarises what the platform does today, what was built this cycle, and what remains before live participant testing.

> **สรุปผู้บริหาร / Executive summary:** ระบบพร้อมใช้งานในระดับวิศวกรรมแล้ว — แพทย์สนทนากับ AI, ระบบให้คะแนนการให้เหตุผลทางคลินิก (PIS-7), และผู้ตรวจประเมินอิสระให้คะแนนคู่ขนานเพื่อตรวจสอบความน่าเชื่อถือ. รอบนี้เพิ่มระบบสมัคร/เข้าสู่ระบบที่ปลอดภัย (Google + คำเชิญ), หน้าเข้าสู่ระบบเดียว, บทบาทพิเศษ (แพทย์และผู้ตรวจ), และผ่านการทดสอบ end-to-end และโหลด. **สิ่งที่เหลือเป็นเรื่ององค์กร** (จริยธรรมการวิจัย IRB, การปรับเทียบคะแนนกับผู้เชี่ยวชาญในเดือนกรกฎาคม) ไม่ใช่งานวิศวกรรม. **คะแนนยังเป็นเบื้องต้น ยังไม่นับเป็นหน่วยกิต** จนกว่าจะปรับเทียบเสร็จ.

**Pilot:** on-premise trial for a Thai medical licensing body · **75 physicians × 3 sessions** · Aug–Sep 2026.

---

## Status at a glance

| Area | Status |
|------|--------|
| Core learning loop (chat → score → review) | ✅ Built, verified end-to-end on production |
| Secure sign-up & login (Google + invites) | ✅ Built & deployed |
| The 4 roles + the new "Special" dual role | ✅ Built & deployed |
| AI scoring (PIS-7) + independent auditor review | ✅ Built; calibration with experts pending (July) |
| Privacy / de-identification | ✅ Enforced (patient + physician identities protected) |
| Capacity / load | ✅ Benchmarked — comfortable for pilot scale |
| Automated testing & CI | ✅ Runs on every change, with coverage gates |
| **Credit issuance** | ⏸ **Off by design** until the July calibration passes |
| Organisational gates (IRB, key rotation, sending domain) | ⏳ Pending — not engineering |

---

## What the platform does, by role

**👩‍⚕️ Physician** — signs in, accepts a one-time consent notice, starts a conversation about a **de-identified** case, reasons it through with an AI tutor (which explains, cites references, gently corrects, and ends each turn with a probing question), then finishes and sees a 7-dimension score plus a progress chart over time. Conversations organise into folders. A usage bar shows each physician's AI budget.

**🔍 Auditor** — opens assigned sessions and gives an **independent, blind** score (cannot see the AI's score or the physician's real identity until after submitting). This is the study's reliability check (AI vs. human agreement).

**🛠️ Admin** (per council) — sees and organises **only their own council's** members and sessions, sends invites, assigns finished sessions to auditors, and works the QA queue (approve/reject AI-flagged sessions).

**⚙️ Superadmin** — sees everything across councils, manages every account and role, controls AI spend (per-physician limits + the overall budget pool), and is the **only** role that can change a member's role or approve auditor-rights requests.

**🩺+🔍 Special (User + Auditor)** — a physician who *also* holds auditor rights: they keep their physician workspace and get a shortcut to the auditor console. Any physician can **request** this; a superadmin approves.

---

## What was built this cycle

A focus on making onboarding secure and the platform participant-ready:

- **One sign-in portal for everyone.** Physicians, admins, auditors and superadmins all sign in at one place; reviewers are routed automatically to their console. Simpler and less error-prone than two separate logins.
- **Real Google sign-in + invitation links.** Physicians self-serve with Google (same account every time — no re-registration); admins/auditors/special/admin-roles join via one-time invite links. The old License-number / TMC step was **retired** at management's direction.
- **The "Special" dual role** + a self-service **"request auditor rights"** button (superadmin approves).
- **Council isolation, verified.** An admin can see and manage only their own council's data — confirmed by an end-to-end security audit.
- **Role changes locked to the superadmin** (admins can view the request queue but not grant rights).
- **Quality & safety hardening:** every button on both apps was audited and wired correctly; double-clicks can no longer re-trigger paid AI scoring or delete history; the apps now show clear messages instead of blank error pages; password-reveal toggles, user search, and a larger desktop view were added.
- **Comprehensive automated testing + continuous integration.** A full test pipeline now runs on every code change (220+ backend tests, the dashboard's on-screen component tests, type-checks and linting) with coverage gates, so regressions are caught before they reach users. Cross-council isolation is re-checked by a live end-to-end test.
- **Mobile polish.** The dashboard and the auditor scoring screen now lay out correctly on a phone — no more sideways scrolling — so reviewers can work on the go.

---

## Verification (evidence, not assertion)

- **Automated test suite & CI:** **222** backend tests, plus a continuous-integration pipeline that runs the whole hermetic test set (backend, RIMPL, license checks, and the dashboard's component tests + type-check + lint) on every change, with coverage-floor gates. Six cross-role suites prove the role hand-offs; cross-council isolation is also re-checked by a live smoke (21/21).
- **Full live journey on production:** physician consent → 5 AI turns → screening gate → AI evaluation → assign → blind auditor score → duplicate-submission blocked. Re-run repeatedly; AI and auditor scores both land correctly.
- **Concurrency / load (see the Performance Benchmark doc):** **100 distinct simultaneous logged-in users with 0 errors**; 200 concurrent requests with 0 errors. The AI-chat path queues and retries under bursts so nothing is lost. Comfortable for 75 physicians, who in practice never all act in the same instant.
- **Cost is bounded:** each AI reply is roughly **$0.01–0.02**, and every physician has a hard usage cap, so concurrent use cannot run up a surprise bill.

---

## Privacy

- **Patient identity** stays out of the AI entirely — cases are de-identified, and any structured patient reference is stored in an isolated table never sent to the cloud or to reviewers.
- **Physician identity** is hidden from auditors behind a code name (e.g. *P-001*) so review stays impartial.
- No live secrets are stored in the codebase.

---

## What remains before live participant testing

These are **organisational**, not engineering:

| Item | Owner |
|------|-------|
| IRB / informed-consent text finalised | Project / ethics |
| Rotate demo passwords + production API keys before real users | Project |
| Verify a sending domain (so invite emails reach any address, not just the owner's) | Project / IT |
| **July calibration workshop** — agreement between AI and expert reviewers must reach the reliability target (ICC ≥ 0.75) | Clinical experts |
| Turn on credit issuance — **only after** calibration passes | Governance |

**Bottom line:** the engineering is built, deployed, and verified for pilot scale. The remaining gates are organisational and on schedule for the Aug–Sep 2026 pilot. Scores remain **provisional** until expert calibration; credit issuance stays off until then.
