# Booth cases are admitted by AI safety review and the physician sandbox, not a physician read

A booth case enters the case pool only after a separate AI clinical-safety review of every question variant and option, against current Thai and WHO guidance, and after the physician sandbox shows its difficulty matches the pool (every group mean within a band of the pool median sized from the measured play-to-play noise, and the best path's mean above the weakest's by more than noise explains; see `scripts/booth/sandbox-verdict.mjs`). No physician reads the cases before the NFCME-2026 booth: the owner has no physician crew available before 3 Nov 2026, and the case pool grew from one case to eleven. This supersedes #215's acceptance criterion that a physician reads the case. The admission marker lives in the case file, the loader leaves out any case without it, and a superadmin can switch a single case off during the forum.

## Owner waiver of the sandbox (2026-11-03)

The owner may admit a case without a sandbox pass by an owner waiver, recorded in the case file as `admission.owner_waiver` with its date, this ADR's number, the reason, and the sandbox run the case failed. The waiver replaces the sandbox only: a case is admitted with a safety review and either a sandbox pass or a waiver, never without the safety review. On 2026-11-03 the owner chose option A and waived the sandbox for the ten NFCME-2026 cases it did not admit. Before that, a blind clinical review of the ten (#348) revised four for clinical defects, each revised case passed a fresh safety review, and one pre-registered run admitted none of them. leptospirosis keeps its sandbox admission.

## Consequences

- A clinical error that both the AI review and the "no withhold or delay" test miss reaches a national CME audience; the per-case off switch is the only remedy at the booth.
- The sandbox measures difficulty, not clinical truth.
- The first rule (±10 and a 15-point gap on one play per path) admitted no case in two full runs: one play moved by up to 21 points between runs, and the evaluator's compressed scale put the pool's own best-to-weakest gap at 13 (#344). The thresholds are now computed from measured noise, and each path plays 3 times.
- With the waiver, ten of the eleven NFCME-2026 cases are not shown to match the pool's difficulty. The sandbox run each failed is named in its waiver, and a superadmin can still switch any case off at the booth.
