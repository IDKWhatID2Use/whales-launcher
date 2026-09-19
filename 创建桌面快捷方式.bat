@echo off
rem ===================================================================
rem  WhalesLauncher - create desktop / start-menu shortcuts.
rem
rem  The shortcut points at wscript.exe + WhalesLauncher.vbs so the app
rem  starts without a console window. The real work (paths, icon, COM)
rem  lives in scripts\make-shortcut.ps1; this file only bridges the
rem  console, because passing non-ASCII arguments through the command
rem  line to powershell.exe is the fragile part - an environment
rem  variable survives it intact.
rem
rem  !! PURE ASCII ONLY !!  See the long note in the launcher .bat:
rem  non-ASCII bytes in a batch body are parsed in the active code page
rem  and can split into stray commands. Chinese output is produced by
rem  scripts\make-shortcut.ps1 via [Console]::Out instead.
rem
rem  Everything this script prints is English on purpose: it must survive
rem  on a machine where nothing else about the project is set up yet.
rem ===================================================================
setlocal
chcp 65001 >nul
pushd "%~dp0"

set "WHALES_SHORTCUT_NAME=WhalesLauncher"
set "WHALES_SANDBOXED=0"
if defined DSH_SESSION_ID set "WHALES_SANDBOXED=1"

rem The fallback folder name (Chinese, shown to the user) is generated inside
rem scripts\make-shortcut.ps1 from Unicode code points.
rem
rem NOTHING non-ASCII may appear in this file, comments included. Three separate
rem attempts to keep a Chinese folder name or a Chinese file name in a comment
rem here all ended the same way: cmd truncated the rem line at the UTF-8 bytes
rem and executed the remainder as commands ("'starts' is not recognized...",
rem "'lives' is not recognized..."). The launcher .bat carries the long version
rem of that story.

rem -File MUST get an absolute path: with a relative one, PowerShell 5.1
rem resolves the script's own location against its startup directory instead,
rem so $PSCommandPath (and any path derived from it) comes out wrong and the
rem shortcut is built from a bogus root. Measured, not guessed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-shortcut.ps1"
set "code=%ERRORLEVEL%"
popd

echo.
if not "%code%"=="0" goto :failed

echo   Done. Launch WhalesLauncher from the desktop, or search for
echo   "WhalesLauncher" in the Start menu.
echo   To pin it to the taskbar: right-click the shortcut, choose
echo   "Show more options", then "Pin to taskbar".
echo.
pause
endlocal
exit /b 0

:failed
echo   Creating the shortcut failed with exit code %code%.
echo   You can still start the app without a shortcut: double-click the
echo   launcher .bat in the project root (same behaviour, it just keeps
echo   a console window open).
echo.
pause
endlocal
exit /b %code%
