# CLICS booth reel (#216, redesigned for the NFCME-2026 attract loop)

GOAL:    the kiosk's screen saver. A passer-by sees, with no sound, what they will do at this screen (draw a case,
         answer 3 steps, see a result card, keep the QR) and taps. Any tap on the loop starts a play; the tap
         prompt is the kiosk's own bar, not only the video's.
OUTPUT:  HyperFrames, 1080 x 1920 portrait, 30 fps; also renders at 2160 x 3840 (PROMO_4K=1 render.sh). The kiosk
         ships the 1080 file.
TIME:    24 s x 30 = 720 frames. Loops: the last frame is the first frame (the flat ECG line alone on the canvas),
         so the cut back to frame 0 has no seam. The manifest lists the reel twice; the loop rewinds the same
         <video> for the second play.
AUDIO:   one music bed, assets/music/bgm.m4a: HeyGen music library track 8abf0643b6b9430080e05ba84685f1dd ("clean
         modern upbeat electronic pluck, 120 BPM"), fetched 2026-11-03 through `hyperframes media-use resolve` (provider
         heygen.audio.sounds) on the owner's HeyGen account (OAuth). Licence: HeyGen's terms for its music library;
         they were not reviewed for this PR, so read them before the file is used anywhere but the kiosk. First 24 s, 0.15 s fade in, 0.8 s fade out. The kiosk plays it muted (booth-loop.js).
LOOK:    reel energy in the booth's tokens. Full-bleed floods cut on the beat: canvas #faf9f5, ink #141413, accent
         #a9583e. Kinetic type: every line slides up out of its own mask (expo.out 0.4-0.5 s), exits up
         (power3.in 0.22-0.25 s). Thai is Noto Sans Thai 700-800; English Inter 500-700; the wordmark Cormorant.
         Mostly motion graphic; the booth's real captured result card and its QR (redrawn to hold the Portal) are the real screens.
FLOOR:   the loop shows the video at 0.8958 (1080 x 1720 stage), so nothing is authored under 32 px; the smallest
         are the demo label (Thai 38 px, English 36 px). Every Thai line is one nowrap phrase or a paragraph broken
         by hand at a word boundary, so no word can break across lines; the harness measures each with the real
         fonts. Contrast: ink on canvas 17.5:1, white on accent 5.1:1, accent on canvas 4.8:1 (display sizes only),
         soft cream on ink 12.5:1.
COPY:    only what is true now. The demo label, "คะแนนสาธิต: ไม่ใช่หน่วยกิต CME / Demo score: not CME credit" (the kiosk's
         DEMO_LABEL in booth-copy.js, word for word), sits on every frame where a score can be seen (result.html). No
         "validated" and no "On-premise" anywhere in the reel.
CASE:    leptospirosis, the only admitted case. The reel shows only its teaser (draw.html, by hand; lock.mjs digests
         it), never its options or its diagnosis. The answer scene is a made-up headache example, labelled so.
SHOTS:
  0-4     hook. Frame 0: the flat ECG line. The accent beat fires, then the owner's headline slams in, line by
          line: "การเรียนรู้ที่แท้จริง / วัดจากกระบวนการคิด / ไม่ใช่เวลา", English under it.
  4-6.5   try (accent flood). "ลองเล่นได้เลย / Try it right here"; a ring draws round "5 นาที / minutes";
          "ไม่ต้องลงชื่อเข้าใช้ / No sign-in needed".
  6.5-10  1 draw (ink). Three card backs shuffle, the top one flips to the case teaser.
  10-14.5 2 "ฝึกวินิจฉัยผ่าน AI / Practise diagnosis with AI" (canvas). A made-up example step ("ตัวอย่างสมมติ / Made-up example", headache options) rises
          tilted; a fingertip picks B; three step pills fill 1-2-3.
          "แตะตัวเลือก หรือพิมพ์เอง / Tap a choice, or type your own".
  14.5-18.5 3 result (canvas). The real result card, its full width (no crop inside the card), punches in;
          "and what to practise next";
          the demo label throughout.
  18.5-21 4 QR (ink). The card's QR, redrawn at capture to hold https://physician-ui.vercel.app/ (EC level M,
          4-module quiet zone), at 1.85x in scan brackets; one scan-line pass, then it stands clear;
          "ไม่เก็บข้อมูลส่วนตัว / No personal data kept".
  21-24   CTA (canvas). Logo + wordmark, "แตะเพื่อเริ่ม / Tap to start", a pulsing tap; everything clears to
          the flat line of frame 0.
QR:      every QR in the reel opens the Portal, https://physician-ui.vercel.app/ (lock.mjs PORTAL_URL), never a
         result page or the capture server. qr-check.mjs decodes it with jsQR off the rendered frames; the harness
         runs it on the 1080 file, and it is run by hand on renders/promo-4k.mp4.
BANNED:  any real transcript or real person's data; a QR to anywhere but the Portal; a mockup of a screen the booth does not draw;
         text moving while it is read; a loop that cuts from a busy frame to a different busy frame.
RENDER:  bash scripts/booth/promo/render.sh: capture, HyperFrames render, H.264 Main 4:2:0 + AAC moov-first
         encode, then promo.lock.json. scripts/booth/scenarios/promo.mjs checks the file, the lock, the headline,
         the line fit, the seam and the layout on the loop.
