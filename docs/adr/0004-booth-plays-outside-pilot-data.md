# Booth plays live outside the pilot data model

Booth Mode (the kiosk at the National Forum on CME booth) does not create professionals, PLE rows or SANDBOX-council records. A booth play keeps its dialogue in the kiosk page's memory, as guest chat does, and the backend stores only a `booth_plays` row: booth tag, demo score, d1–d7 and time, no transcript. We chose this over reusing the SANDBOX council because SANDBOX is not an isolation boundary: ICC, payouts and the XLSX export filter only on `ples.is_test` (which follows the global `pilot_test_mode`), the Participants sheet lists every professional, PLE/P codes are global sequences, and the 60 held-out calibration anchors live in SANDBOX. A separate table keeps booth data out of every pilot query by construction, because no pilot query reads it.

## Considered options

- **PLE rows in the SANDBOX council**: reuses the whole pipeline, but every cross-council aggregate would first need a SANDBOX exclusion, and booth data would sit beside the calibration anchors.
- **Backend memory only**: no migration, but the leaderboard is lost on any restart or redeploy during the forum.
