# Booth kiosk launchers

Open the booth full screen in Chrome on the booth mini-PC.

- `booth-kiosk.cmd` is for Windows.
- `booth-kiosk.sh` is for Linux and macOS.

Both open `https://physician-ui.vercel.app/booth`. Set `BOOTH_URL` to open another address, and `BOOTH_PROFILE` to move the Chrome profile. On Linux or macOS, set `CHROME` if Chrome is not installed in a standard place.

## The profile

The launchers use their own Chrome profile, not incognito. The booth's offline cache lives in that profile, so it survives a restart. The default profile folder is:

- Windows: `%LOCALAPPDATA%\CLICS-Booth\chrome-profile`
- macOS: `~/Library/Application Support/CLICS-Booth/chrome-profile`
- Linux: `~/.config/clics-booth/chrome-profile`

After a power cut, Chrome marks the profile as crashed and offers to restore pages. Before each launch, the script edits the profile's `Default/Preferences` file so Chrome sees a clean exit and shows no prompt. On the very first launch the file does not exist yet, and the script skips this step.

## Flags

| Flag | What it does |
|---|---|
| `--user-data-dir=<profile>` | Uses the booth profile above, so the offline cache persists |
| `--kiosk` | Full screen with no address bar, tabs or window frame |
| `--no-first-run` | No welcome page on the first launch |
| `--no-default-browser-check` | No "make Chrome your default browser" bar |
| `--noerrdialogs` | No error dialogs over the booth |
| `--disable-infobars` | No info bars across the top |
| `--disable-translate`, `--disable-features=Translate` | No offer to translate the Thai page |
| `--hide-crash-restore-bubble` | A second guard against the restore prompt, on Chrome versions that support it |
| `--disable-pinch` | A pinch on the touch panel does not zoom the page |
| `--overscroll-history-navigation=0` | A sideways swipe does not go back a page |
| `--autoplay-policy=no-user-gesture-required` | The idle loop video plays without a tap first |
| `--check-for-update-interval=31536000` | Chrome does not update itself during the event |

## Start the booth when Windows starts

1. Press Win+R, type `shell:startup` and press Enter. The Startup folder opens.
2. Copy `booth-kiosk.cmd` into that folder, or put a shortcut to it there.
3. Sign out and back in, or restart, to check that the booth opens by itself.

The Startup folder runs only after sign-in, so the mini-PC's Windows account needs automatic sign-in (no password
prompt at boot). Copy `booth-kiosk.cmd` from a git clone, not a GitHub download: only a checkout gives it the
Windows line endings cmd.exe needs (`.gitattributes`).

## Exit kiosk mode

- Windows and Linux: press Alt+F4.
- macOS: press Cmd+Q.

Plug in a keyboard first if the mini-PC has only the touch panel.
