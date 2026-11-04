# Booth rehearsal checklist, Mon 2 Nov 2026

Run on the real mini-PC and touch panel, with the owner's phone hotspot, against prod. The booth opens Tue 3 Nov
(everything shifts one day if it opens Wed 4 Nov). Staff steps are in the Thai runbook,
[BOOTH-RUNBOOK.th.md](BOOTH-RUNBOOK.th.md). Print it: `node scripts/docs/th-doc-pdf.mjs docs/BOOTH-RUNBOOK.th.md --out booth-runbook.pdf`.

Rehearsal plays are real `NFCME-2026` plays: they take the next tags and appear on the public board. They are kept
like every other play (ADR 0010). `NFCME-2026` already holds the visitor plays of 3–4 Nov, and
`purge-event.mjs --delete` removes every play of an event, so a rehearsal never runs it on `NFCME-2026`.

## Before the freeze (by Sun 1 Nov 18:00, +07:00)

Owner-gated production writes. Do them before the deploy freeze, not on the day.

- [ ] **Booth migrations applied, in this order,** to the prod Supabase: re-apply `db/migration-booth-plays.sql`
      (idempotent; it replaces `booth_start_play` with the version that refuses a start once the switch is off),
      then apply `db/migration-booth-purge.sql` (`booth_event_summary` and the `booth_event_purges` record).
      From #246 on, `migration-booth-plays.sql` drops the one-argument `booth_start_play` for the
      `(event, case, version)` one, so re-apply it only together with a backend deploy that has #246, and
      deploy the kiosk (Vercel), the backend and rimpl as one release: an older backend or kiosk ends every play.
- [ ] **Check, read-only:** `cd backend && node ../scripts/booth/purge-event.mjs --event FREEZE-CHECK` prints
      `dry run: nothing deleted` and `plays 0`. A `Next step:` line that says to apply
      `db/migration-booth-purge.sql` means the purge migration is not applied.
- [ ] **Check, read-only,** in the Supabase SQL editor:
      `select position('booth_enabled' in prosrc) > 0 from pg_proc where proname = 'booth_start_play';` returns
      `true`. `false` means `migration-booth-plays.sql` was not re-applied.
- [ ] **The backend deploy has #217 and #378** and is live before the freeze. Its score and reply log lines are
      what section 3 reads: with an older backend, `score-latency.mjs` finds 0 lines and fails.

## 0. Before you start

- [ ] **Freeze held.** No deploy after Sun 1 Nov 18:00 (+07:00), only rollbacks. Check the newest deploy time of
      each service: `railway deployment list --service backend`, the same for `--service rimpl`, and the Portal and
      dashboard production deployments on Vercel. Anything newer than the freeze is either a rollback you can name
      or a stop.
- [ ] **The pre-freeze section is all ticked.** Rerun its two read-only checks: they still pass.
- [ ] **Railway logged in.** `railway whoami` prints the owner's account (the CLI was logged out on 28 Oct). A
      rollback on the day needs it.
- [ ] **Backend is the backend.** `curl -s https://backend-production-c12e4.up.railway.app/health/deep` reports
      `"service":"backend"`.
- [ ] **Kiosk launcher installed.** `scripts/booth/kiosk/booth-kiosk.cmd` is on the desktop and in `shell:startup`
      (see `scripts/booth/kiosk/README.md`).

## 1. Event switch, on and off

In the dashboard Overview, Booth Mode card. The card saves two ways: the switch saves itself the moment it is
tapped, but opens-at, closes-at and the per-play ceiling are saved only by the card's **บันทึก / Save** button. A
time typed and not saved changes nothing, and the backend refuses to switch on a booth with no saved window.

- [ ] Set opens-at to now (or earlier) and closes-at to tonight, press **Save**, then tap the switch **on**. Within
      30 s the kiosk bar reads แตะเพื่อเริ่ม / Tap to start.
- [ ] Tap the switch **off**. Within 30 s the bar reads ขณะนี้บูทปิดอยู่ / The booth is closed right now, and a tap
      does not start a play.
- [ ] With the switch on, set opens-at in the future and press **Save**. The bar reads closed again. Set opens-at
      back to now and press **Save**.

## 2. Start-up and touch

- [ ] Cold boot: the mini-PC starts Chrome into `/booth` full screen with no restore-session prompt and no browser
      chrome.
- [ ] Kill Chrome from Task Manager, run the launcher again: no "Restore pages?" bubble.
- [ ] Touch lands under the finger in all four corners of the portrait panel. Option cards and "type my own" take
      one tap each. The on-screen keyboard leaves the typing box visible.
- [ ] Alt+F4 exits kiosk mode.

## 3. Prod scores on Claude under 60 s, and replies come under 15 s

- [ ] Play 10 times on the kiosk, all three steps each. Mix tapped choices with at least one "type my own". Every
      play ends on a result card, none on the score-unavailable card.
- [ ] Save the backend's booth lines to a file: Railway dashboard, backend, Logs, filter `[booth]`, or
      `railway logs --service backend --since 2h --filter '"[booth]"' > booth.log` (`--since` stops it
      streaming). Then run `node scripts/booth/score-latency.mjs booth.log`. It prints two gates and a last line.
- [ ] The score gate prints `score PASS`. It fails on fewer than 5 scored plays, any unavailable play, p95 at or
      over 60 s, or any provider other than `anthropic`.
- [ ] Read the reply gate: `reply PASS`, `reply FAIL` or `reply TOO FEW`. It needs at least 30 replies (10 plays
      of 3 steps) and a reply p95 under 15 s. An empty reply (the AI failed or timed out, and the kiosk showed the
      fallback question) counts, since the visitor waited for it. The last line says `PASS` only when both gates
      pass.
- [ ] A reply FAIL or TOO FEW does not block opening. Record the reply p95. A FAIL makes streaming or a faster
      reply model the first wave-2 ticket.
- [ ] On FAIL with a `local` provider: rimpl is routing the evaluator to the local model, whose p95 (about 90 s) is
      past the 60 s cap. Fix the rimpl env before opening, not the cap.

## 4. Hotspot failover

- [ ] With a play on screen, turn the venue Wi-Fi off on the mini-PC. It joins the hotspot by itself, or after one
      tap on the Wi-Fi icon. The bar returns to Tap to start within 30 s of the hotspot joining.
- [ ] Play once on the hotspot to the result card.

## 5. Network unplugged

- [ ] Turn all networks off at the loop. The loop and the promo video keep playing, and within 30 s the bar reads
      ขณะนี้เชื่อมต่อ CLICS ไม่ได้ / CLICS is offline right now. A tap starts nothing.
- [ ] Start a play, then cut the network mid-step. The play ends on a plain "connection lost" message and returns
      to the loop by itself.
- [ ] Reconnect. The bar returns to Tap to start within 30 s.
- [ ] Reboot with no network. The page still loads from the booth's offline cache and shows the offline bar.

## 6. Clean up after rehearsal

- [ ] Tap the switch **off** in the Booth Mode card (it saves itself).
- [ ] Delete nothing. The rehearsal plays stay with the event's plays (ADR 0010). Removing them is an
      owner-ordered removal, decided by the owner, and `purge-event.mjs` cannot do it: it deletes the whole event.
- [ ] Set opens-at and closes-at to Tue 3 Nov's booth hours and press **Save**. Reload the page and check both
      times are still shown. Leave the switch off until the morning.
- [ ] Write the staff names and phone numbers by hand on the printed runbook, section 7.
