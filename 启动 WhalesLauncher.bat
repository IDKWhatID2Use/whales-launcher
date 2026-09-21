@echo off
rem ===================================================================
rem  WhalesLauncher - double-click launcher (visible console).
rem
rem  Delegates to scripts\launch-app.ps1, which starts the native
rem  WinUI 3 app at desktop\src\WhalesLauncher.App.
rem
rem  HISTORY (why the target changed):
rem    This file used to run "node scripts\launch.mjs", which booted the
rem    Electron shell. The front end was replaced by a native WinUI 3
rem    application and launch.mjs was deleted, but this entry point kept
rem    calling it - so double-clicking failed with "Cannot find module".
rem    The target is now scripts\launch-app.ps1.
rem
rem  !! THIS FILE MUST STAY PURE ASCII. !!
rem  Measured the hard way: cmd.exe reads a .bat in the *active* code
rem  page, and a "chcp 65001" line inside the file does NOT re-read what
rem  follows. UTF-8 Chinese in a batch body therefore arrives as mojibake
rem  whose bytes include ', " and \ - which silently breaks command
rem  parsing ("'coding' is not recognized as an internal command...", the
rem  second half of a sentence executed as a command, etc).
rem  All user-facing text is printed by scripts\launch-app.ps1, which
rem  switches the console to UTF-8 itself (the "chcp 65001" below only
rem  covers this file's own echo lines).
rem
rem  Options are passed straight through to launch-app.ps1. Note that this
rem  file's real name is Chinese ("qi dong" = start); it is deliberately
rem  NOT spelled out below, because non-ASCII bytes in a rem line would
rem  reintroduce exactly the parsing hazard described above.
rem    --build     build first, then start
rem    --check     report the exe path, do not start
rem    --wait      keep the console attached
rem    --help      show the option list
rem ===================================================================
setlocal
chcp 65001 >nul
pushd "%~dp0"

if /i "%~1"=="--help" goto :help

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-app.ps1" %*
set "code=%ERRORLEVEL%"

if not "%code%"=="0" goto :failed

popd
endlocal
exit /b 0

:failed
echo.
echo   WhalesLauncher did not start (exit code %code%).
echo   The reason is printed above.
echo.
pause
popd
endlocal
exit /b %code%

:help
echo.
echo   WhalesLauncher launcher
echo.
echo     --build    build the app first, then start it
echo     --check    print which exe would run, then exit
echo     --wait     keep this console attached until the app exits
echo     (no args)  start the app now if it is already built
echo.
echo   The app itself is a native WinUI 3 program; see README.md.
echo.
pause
popd
endlocal
exit /b 0
