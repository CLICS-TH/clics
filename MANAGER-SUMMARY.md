# CLICS — Prototype Summary (for non-technical readers)

**CLICS** = *Clinical Learning & Intelligence Credit System*
A pilot platform for a Thai medical licensing body, July–September 2026.

---

## 1. What problem does it solve?

Today, doctors earn continuing-education (CME/CPD) credit largely by **attending** lectures — which proves they showed up, not that they learned. CLICS changes the basis of credit from *attendance* to **the quality of a doctor's clinical thinking.**

A doctor has a real clinical conversation with an AI tutor about a patient case. The system then scores **how well the doctor reasoned** — the questions they asked, how they weighed evidence, whether they challenged the AI — and awards credit on that basis.

---

## 2. Who uses it? (four roles)

| Role | In plain terms | What they do |
|------|----------------|--------------|
| **Physician** (แพทย์อาสา) | The doctor earning credit | Has AI case discussions, gets scored, tracks progress |
| **Admin** | The pilot coordinator | Oversees cases, assigns expert reviewers, sees statistics |
| **Expert Auditor** | A senior doctor checking quality | Independently re-scores cases "blind" to confirm the AI is fair |
| **Superadmin** | The system owner | Manages accounts and oversees the whole programme |

---

## 3. What does a doctor actually experience?

1. **Log in** to the physician portal.
2. **Start a case** ("Clinical Learning Episode") and type the patient's main problem.
3. **Discuss it with the AI tutor** — ask questions, propose a diagnosis, think it through.
   - The AI is a **mentor, not an answer machine**: it explains its reasoning, **backs claims with references**, **politely corrects mistakes** instead of just agreeing, and **ends every reply with a question** that pushes the doctor to think one level deeper.
4. **Finish the session.** The system checks it was a genuine learning episode, then scores the doctor's reasoning.
5. **See the result** — a 7-part score and a personal progress chart over time.

**New in this update:** doctors can now **organise their conversations into folders, name/rename each one, and move them around** — like folders for case discussions — all shown on a tidy dashboard.

---

## 4. How is "quality of thinking" measured?

- **PIS-7** — every session is scored on **7 dimensions** of clinical reasoning (e.g. quality of questions, depth of reasoning, use of evidence, self-reflection), shown as an easy-to-read radar chart.
- **Fairness check (ICC)** — human expert auditors re-score a sample of cases *without seeing the AI's score*. We then measure how closely the AI and the human experts agree. The programme only proceeds to full scale once that agreement is high enough (a recognised statistical bar). This is what makes the AI scoring **trustworthy**, not a black box.

---

## 5. Privacy & safety (important for the pilot)

- **Patient/doctor identifying information stays on-premise.** Only **de-identified** text is ever sent to the cloud AI.
- The AI is built to **avoid making things up** and to **cite evidence** — reducing the risk of confident-but-wrong advice.
- All accounts are role-restricted: each person only sees what their role allows.

---

## 6. What's working right now (live prototype)

All four roles are deployed and were tested end-to-end on the live system:

- ✅ Doctors can log in, run an AI case discussion (with references + follow-up questions), and get a 7-part reasoning score + progress chart.
- ✅ **Conversation folders**: create, rename, move, and delete — verified working and saved.
- ✅ **Works well on a phone**: clean mobile layout, readable full text, a one-tap **dark mode**, and a desktop/mobile preview switch.
- ✅ Expert auditor scoring shows the **blind-then-reveal** comparison against the AI's score.
- ✅ A more **polished, premium look** across every screen, in both Thai and English.

## 7. What is *not* in this prototype yet (roadmap, not bugs)

To set expectations clearly, these were intentionally **out of scope** for the prototype and are planned for later:

- Rotating between **multiple AI providers** (today it runs on a single, high-quality model).
- **Full pseudonymisation** of identities (today uses pattern-based de-identification).
- The automated **credit-issuing engine** (scores are produced; formal credit issuance is a later step).

---

## 8. How to try it

See **`LOGIN-ACCOUNTS.txt`** for the live web links and the four demo logins (one per role).
*Note: these are throwaway demo passwords for the pilot walkthrough and will be replaced before the real pilot.*

> This is a **working prototype** for hands-on evaluation — built to demonstrate the concept end-to-end, not the final production system.
