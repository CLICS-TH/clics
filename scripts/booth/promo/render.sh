#!/usr/bin/env bash
# Rebuilds physician-ui/public/booth-loop/promo.mp4 from source: capture, render, encode for the kiosk.
# Run from anywhere: bash scripts/booth/promo/render.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../../physician-ui/public/booth-loop/promo.mp4"

node "$here/capture.mjs"
(cd "$here" && npx --yes hyperframes@0.8.214 render --quality delivery --fps 30 --skill hyperframes -o renders/promo-master.mp4)
# H.264 main, yuv420p, no audio track, moov first, keyframe every 2 s: plays in Chrome and stays small for the
# booth service worker's cache.
ffmpeg -y -loglevel error -i "$here/renders/promo-master.mp4" -an -c:v libx264 -profile:v main -pix_fmt yuv420p \
  -preset slow -crf 20 -g 60 -movflags +faststart "$out"
node "$here/lock.mjs" --write
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,profile -of default=nw=1 "$out"
