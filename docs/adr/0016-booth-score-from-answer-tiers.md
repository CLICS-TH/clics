# A five-step booth play shows its answer tiers' points, and reasoning breaks ties

Status: accepted 2026-11-26 (owner, from booth feedback at NFCME-2026). Supersedes ADR 0013's map for five-step events.

The number a visitor sees for a five-step play is the sum over its five steps of 20 for a best answer, 10 for a reasonable one and 0 for a weaker one, read from the play's stored tier path (`tier_path`, one letter B, R or W a step). All best is 100 and all weaker is 0. The scale is `tiers-v1`, named in `backend/src/booth-cases/display-score.js` (`TIER_SCALE`). Every board ranks on it: the kiosk's today and event boards, `rank_today` and `rank_event` on the result, and the superadmin's Overall, By day and By case lists. Plays that show the same number rank by the stored raw PIS-7 composite, high first, then the earlier `scored_at`, then the lower tag. So the reasoning the evaluator saw along the path (ADR 0009) still decides between two visitors who chose equally well.

Nothing stored changes. `booth_plays` keeps the raw composite and d1–d7 from the path score table; the result card's domain bands, the auditor reveal, the open dataset (ADR 0010) and the internal export (ADR 0014, which now also names `tier_scale`) read them as before. Every past five-step play gets its new number from its stored tier path, so the whole board re-ranks at once and consistently. A kept result link shows the number of its tiers too, not the rescale it was made with. Three-step events are unchanged: they show and rank on the raw composite.

## Why

Visitors who chose ดีที่สุด (best) at every step did not get 100, and often scored below visitors who did not. Under `display-v2` (ADR 0013) the shown number was a rescale of the path score table's composite, and the tables are a model of the evaluator, not of the tiers. Over the eleven NFCME-2026 five-step tables as committed on 2026-11-26 (stored composites, whole numbers):

| case | all-best raw | shown (display-v2) | paths scoring above all best (of 243) |
|---|---|---|---|
| organophosphate | 48 | 63 | 126 |
| copd-exacerbation | 50 | 69 | 75 |
| adhf | 48 | 63 | 54 |
| toddler-gastro-dehydration | 51 | 71 | 38 |
| sjs-ten-allopurinol | 50 | 69 | 37 |
| melioidosis-farmer | 53 | 77 | 25 |
| ectopic-rupture | 58 | 91 | 4 |
| motorcycle-shock | 54 | 80 | 4 |
| alcohol-pancreatitis | 55 | 83 | 3 |
| dka-young-adult | 58 | 91 | 3 |
| leptospirosis | 53 | 77 | 0 |

On ten of the eleven cases some path scored above all best, and only dka-young-adult and sjs-ten-allopurinol had any path that reached 100, neither of them all best. A visitor reads "I chose the best answer every time" against the number, and the number disagreed. The tiers are what the case authors and the safety review vouched for (ADRs 0005, 0006); the composite is one AI scorer's modelled reading of the path.

## Considered options

- **Keep `display-v2` and re-anchor it**: no anchor puts all best at 100 on every case, because all best is not the top raw path on most of them.
- **Rebuild the tables until all best tops each one**: paid evaluator runs, tree edits, and still no promise; it would also bend the evaluator's output toward the tier labels.
- **Tier points with no tie-break, or ties by time only**: eleven possible numbers (0, 10, … 100) put many visitors on one number, and the daily prize needs an order. The raw composite is already stored and is the only per-play signal of reasoning on the path.

## Consequences

- The shown number no longer reads the evaluator; the radar and domain bands still do. The card keeps the "demo score: not CME credit" label, and the line under the number now says how it adds up (best 20 a step, reasonable 10).
- The standings read every scored play of the event (a few narrow columns, paged by `readAll`) and rank them in the backend, because no index orders the tier points; the old read ordered by raw composite with a 1000-row cap could have cut a high-tier play. An event is a few hundred plays (one kiosk, about one play every five minutes), so this is one page.
- A five-step row whose tier path is not five tier letters would show `display-v2` and rank after every row that has one. The database's check (`tier_path ~ '^[BRW]{0,5}$'`) and the standings filter (five characters) leave no such row, so this is a guard, not a path.
- The dashboard mirrors `tiers-v1` in `audit-dashboard/lib/booth.ts` (`tierScore`, `rowScore`), and its test checks it against the backend's on all 243 paths. The kiosk's result page mirrors it in `physician-ui/public/js/booth-copy.js` (`tierScore`).
- Changing the points is a new scale version, recorded here or in a new ADR.
