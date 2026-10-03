# Candidate local addenda (plan 2.6)

Scored on the 40 tuning anchors only, with
`score-local.mjs --split tuning --addendum-file scripts/calibration/anchors/addenda/<file>`.
The adoption rule is pre-registered in AUTHORING.md §7 item 21. Both files were committed
on 2026-10-02, two minutes after the baseline run started. By then 2 of its 120 evaluations had
returned (anc-001, anc-002), and neither was read before the candidates were written. Each change is justified from the
rubric, not from an anchor's number.

- **v1-evidence-first.txt** removes the shipping addendum's two "default to 3" rules: "3 is the
  anchor" and "if you cannot point at the absence, the score is not below 3". The base rubric names 3
  as "moderate — reasonably structured", a level that is earned, and says "do not compress toward
  the middle". v1 also drops "because the session is short" from the do-not-lower list, because a
  short session can genuinely lack d4/d6 evidence. It adds "do not raise a score because the AI's
  answers were good", since the base prompt says to ignore AI turns. Kept unchanged: the per-domain
  rule, the d1 rule and the quoting/format block.
- **v2-format-only.txt** keeps only the quoting and output-format block. It tests whether the
  scoring-process section causes the low-end lift. The base prompt's own calibration rules then
  apply alone, exactly as the cloud evaluator receives them.

At most one further variant (v3) may be added after these two are scored, under the same rule.
