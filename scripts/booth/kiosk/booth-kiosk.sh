#!/bin/sh
# CLICS booth kiosk: opens the booth full screen in Chrome (Linux or macOS). See README.md beside this file.
# The profile is a real one, not incognito, so the booth's offline cache survives a restart.
set -eu

BOOTH_URL="${BOOTH_URL:-https://physician-ui.vercel.app/booth}"
case "$(uname -s)" in
  Darwin) default_profile="$HOME/Library/Application Support/CLICS-Booth/chrome-profile" ;;
  *) default_profile="${XDG_CONFIG_HOME:-$HOME/.config}/clics-booth/chrome-profile" ;;
esac
BOOTH_PROFILE="${BOOTH_PROFILE:-$default_profile}"

find_chrome() {
  for path in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    /opt/google/chrome/chrome; do
    [ -x "$path" ] && { printf '%s\n' "$path"; return 0; }
  done
  for name in google-chrome-stable google-chrome chromium chromium-browser; do
    command -v "$name" 2>/dev/null && return 0
  done
  return 1
}
CHROME="${CHROME:-$(find_chrome || true)}"
if [ -z "$CHROME" ]; then
  echo "Google Chrome was not found. Install it, or set CHROME to its path." >&2
  exit 1
fi

# A power cut leaves the profile marked as crashed, and Chrome then offers to restore pages over the booth.
prefs="$BOOTH_PROFILE/Default/Preferences"
if [ -f "$prefs" ]; then
  if command -v sed >/dev/null 2>&1; then
    sed -E -e 's/"exit_type"[[:space:]]*:[[:space:]]*"[^"]*"/"exit_type":"Normal"/g' \
      -e 's/"exited_cleanly"[[:space:]]*:[[:space:]]*false/"exited_cleanly":true/g' "$prefs" > "$prefs.tmp"
  else
    python3 - "$prefs" > "$prefs.tmp" <<'PY'
import json, sys
prefs = json.load(open(sys.argv[1], encoding='utf-8'))
prefs.setdefault('profile', {}).update(exit_type='Normal', exited_cleanly=True)
sys.stdout.write(json.dumps(prefs, separators=(',', ':')))
PY
  fi
  mv "$prefs.tmp" "$prefs"
fi

exec "$CHROME" --user-data-dir="$BOOTH_PROFILE" --kiosk --no-first-run --no-default-browser-check --noerrdialogs \
  --disable-infobars --disable-translate --disable-features=Translate --hide-crash-restore-bubble --disable-pinch \
  --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 \
  "$BOOTH_URL"
