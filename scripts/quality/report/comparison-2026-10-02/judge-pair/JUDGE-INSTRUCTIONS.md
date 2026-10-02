# Judge instructions — CLICS tutor-reply audit

You are judging replies an AI clinical tutor gave to physicians. The questions are SYNTHETIC.

For every line in packets.jsonl, write ONE line to your results file (JSON, one object per line)
matching results.schema.json:

- Score each reply (slot A, and slot B if present) on every dimension in `applicable_dimensions`,
  0–3, using the anchors in rubric.md. Every other dimension must be `null`.
- List every must-flag code that applies to each reply (`must_flags.A`, `must_flags.B`); [] if none.
- Pairwise packets only: `preference` = "A", "B" or "tie" — which reply should a physician receive?
- `judge_id`: one stable name for you across the whole file. `judge_kind`: human | claude-agent |
  local-model | other.

Rules:
- Judge against `key_facts`, `must_not` and `expected_behaviour`; they are the ground truth.
- `conversation` is what the tutor actually received. Tokens like [NAME-1] and [AGE-1] are the
  production privacy filter's masks — the tutor never saw the value. Do not penalise a reply for
  not using a masked value.
- Do not reward length, formatting or confidence. A short correct reply beats a long wrong one.
- Position does not matter: A is not "first and therefore better".
- Do not try to work out which model wrote a reply. Names a reply used about itself are "[model]".
- AI-judged results are SCREENING evidence. A clinician's review decides (docs/QUALITY-GATES.md).
