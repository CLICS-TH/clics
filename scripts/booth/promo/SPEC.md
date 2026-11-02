# CLICS booth promo (#216)

GOAL:    a passer-by at the NFCME-2026 booth understands, with no sound, what CLICS does and that they can
         try it on this screen in about 5 minutes, then taps.
OUTPUT:  HyperFrames, 1080 x 1920 portrait, 30 fps, silent (the loop plays muted in a noisy hall).
TIME:    57 s x 30 = 1710 frames. No music.
LOOK:    the Portal's own booth look, not a new one. Ground #faf9f5 (booth --canvas), ink #141413, body #3d3d3a,
         one accent #a9583e (booth --accent) on the section flood and the tap mark only. Display face Cormorant
         Garamond 500 (the CLICS wordmark only); every caption Noto Sans Thai / Inter.
         Captions: Thai 64 px / 1.45 weight 600 ink, English 40 px / 1.3 weight 500 body beneath it.
         The booth's floor is 28 px at 1080 wide, measured as displayed: the loop shows the video at 0.8958
         (1080 x 1720 stage, under the 200 px bar), so no font in the promo is authored under 32 px (32 x
         0.8958 = 28.7). The smallest are the demo label's lines, Thai 34 px and English 32 px.
         Contrast: ink on ground 18:1, body on ground 10:1, white on accent 5.0:1.
         Medium: real product screens in one card, 960 x 1240 at x 60 y 620, radius 36, 2 px #e6dfd8 edge,
         shadow 0 24 60 rgba(20,20,19,.18). Captions live in the band above it (y 150-580).
OBJECTS: the Landing page's fixture-built screenshots (PLE chat, PIS-7 radar, domain scores) and the booth
         flow captured in the fixture world of scripts/booth/promo/stub.mjs: a stubbed booth API with the real
         NFCME-2026 case (NFCME-2026/leptospirosis.json) and an empty attract loop, so no staff loop file can reach a frame. The result card and
         both boards show Booth #042 with one score. Nothing invented: every screen is the product's own render.
CASE:    the video shows the case's vignette and step 1 (question, options, the visitor's pick). The owner kept
         the NFCME-2026 case for the promo (2026-10-29): if a clinical review changes the vignette or step 1,
         re-run render.sh. promo.lock.json digests those parts (step 1 as the stub asks it), so the booth harness
         fails until the promo is re-rendered; changes to steps 2-3 leave it alone. The lock also digests every
         file the capture served the booth page (capture-files.json), so a kiosk copy or CSS edit needs a
         re-render too.
LOOP:    the manifest item carries "board": false, so the loop board hides while the promo plays and nothing
         covers its demo labels or end card. A { "type": "board", "seconds": 15 } item follows it, so every loop
         cycle shows the board alone over the stage's wordmark. The board shows over every other loop item.
MOTION:  arrive expo.out 0.6-0.7 s; camera pans power2.inOut 1.2-1.6 s; exits power3.in 0.3-0.35 s;
         captions blur 8 px -> 0 in 0.18 s, Thai first then English 0.1 s later, dead still while read,
         blur out 0.18 s.
SHOTS:
  0-5     hook. CLICS wordmark and the Landing hero line already on frame 0. ECG pulse draws under the mark.
  5-12    chat. Card rises with the PLE conversation; pan from the question to the AI answer. "Talk a made-up case through".
  12-19   score. Whip up into the PIS-7 radar (sample 75/100) with the demo label on the card.
  19-26   audit. Blur swap to the domain scores; the pilot will compare AI with blind expert auditors.
  26-38   booth A. Accent flood: "Try it at this booth, about 5 minutes". Ground floods back; card rises with
          the vignette, iris to step 1, a fingertip presses option B, iris from the tap into the AI reply.
  38-51   booth B. AI reply, blur swap to scoring, blur swap to the result card (demo score, tag, board).
  51-57   end. Card carries away; mark + wordmark; "Tap the screen to try CLICS"; no sign-in, no personal
          data; pilot not started, results are not CME credit. Holds 3 s.
COPY:    only what is true now. No "On-premise", no "validated" outside the booth's own demo label, which
         sits on every shot that shows a score (12-26, 47-51).
BANNED:  dark void, glow, gradients, glass cards; everything fading up; text moving while read; corner logos;
         click rings; a mockup of any screen; any real transcript or real person's data.
RENDER:  bash scripts/booth/promo/render.sh: capture, HyperFrames render, H.264 Main 4:2:0 moov-first encode,
         then promo.lock.json. scripts/booth/scenarios/promo.mjs checks the file, the lock and the layout.
QA:      frames 0, 8, 15, 22, 27, 31, 36, 38.5, 41, 45, 49, 55 - captions inside 80% title-safe,
         demo label on screen wherever a score is.
