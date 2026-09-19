@echo off
rem ===================================================================
rem  WhalesLauncher - double-click launcher (visible console).
rem
rem  Why this file exists: the only supported way to start the app used
rem  to be "npm start" typed into a terminal. Double-clicking must work.
rem
rem  !! THIS FILE MUST STAY PURE ASCII. !!
rem  Measured the hard way: cmd.exe reads a .bat in the *active* code
rem  page, and a "chcp 65001" line inside the file does NOT re-read what
rem  follows. UTF-8 Chinese in a batch body therefore arrives as mojibake
rem  whose bytes include ', " and \ - which silently breaks command
rem  parsing ("'coding' is not recognized as an internal command...", the
rem  second half of a sentence executed as a command, etc).
rem  All user-facing Chinese lives in scripts\launch.mjs, which prints it
rem  to a console already switched to UTF-8 by the "chcp 65001" below.
rem
rem  Every decision (environment check, rebuild-if-stale, start,
rem  diagnosis) deliberately lives in scripts\launch.mjs, shared by all
rem  three entry points (.bat / .vbs / npm run launch).
rem
rem  From a terminal you can pass options through:
rem    "WhalesLauncher.bat" --rebuild        force a rebuild first
rem    "WhalesLauncher.bat" --skip-build     start the existing dist/ as-is
rem    "WhalesLauncher.bat" --help           full option list
rem ===================================================================
setlocal
chcp 65001 >nul
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node "scripts\launch.mjs" %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" goto :failed

popd
endlocal
exit /b 0

:failed
echo.
echo   Startup failed with exit code %code%.
echo   Latest log: logs\launcher-*.log
echo   Please attach that log file plus the output above when asking for help.
echo.
pause
popd
endlocal
exit /b %code%

:no_node
echo.
echo   Node.js was not found (the "node" command is not on PATH).
echo   WhalesLauncher needs Node.js 22 or newer: https://nodejs.org/
echo   After installing, open a NEW terminal (or sign out and back in)
echo   so PATH takes effect, then double-click this file again.
echo.
pause
popd
endlocal
exit /b 1
