@echo off
rem CLICS booth kiosk: opens the booth full screen in Chrome on the mini-PC. See README.md beside this file.
rem The profile is a real one, not incognito, so the booth's offline cache survives a restart.
setlocal
if not defined BOOTH_URL set "BOOTH_URL=https://physician-ui.vercel.app/booth"
if not defined BOOTH_PROFILE set "BOOTH_PROFILE=%LOCALAPPDATA%\CLICS-Booth\chrome-profile"

set "CHROME="
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe") do if not defined CHROME if exist "%%~P" set "CHROME=%%~P"
if not defined CHROME goto nochrome

rem A power cut leaves the profile marked as crashed, and Chrome then offers to restore pages over the booth.
rem [char]34 is a double quote: a literal one would end this cmd string early.
set "BOOTH_PREFS=%BOOTH_PROFILE%\Default\Preferences"
if not exist "%BOOTH_PREFS%" goto launch
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:BOOTH_PREFS; $q=[char]34; $s=[IO.File]::ReadAllText($p); $s=$s -replace ('exit_type'+$q+'\s*:\s*'+$q+'\w*'+$q), ('exit_type'+$q+':'+$q+'Normal'+$q); $s=$s -replace ('exited_cleanly'+$q+'\s*:\s*false'), ('exited_cleanly'+$q+':true'); [IO.File]::WriteAllText($p, $s)"

:launch
start "" "%CHROME%" --user-data-dir="%BOOTH_PROFILE%" --kiosk --no-first-run --no-default-browser-check --noerrdialogs --disable-infobars --disable-translate --disable-features=Translate --hide-crash-restore-bubble --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 "%BOOTH_URL%"
exit /b 0

:nochrome
echo Google Chrome was not found in Program Files or the user's AppData. Install Chrome, then run this again.
pause
exit /b 1
