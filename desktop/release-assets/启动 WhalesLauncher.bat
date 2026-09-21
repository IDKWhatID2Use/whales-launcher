@echo off
rem ===================================================================
rem  WhalesLauncher - launcher for the released build.
rem
rem  Same as double-clicking WhalesLauncher.exe, except this keeps a
rem  console window open so a failed start is visible instead of vanishing.
rem
rem  WHY PURE ASCII: cmd.exe reads a .bat in the *active* code page
rem  (936 on a Chinese Windows). UTF-8 Chinese in a batch body arrives as
rem  mojibake whose bytes include ', " and \ - which silently breaks
rem  command parsing. All user-facing Chinese lives in README-*.txt and
rem  in the app itself, never here.
rem ===================================================================
setlocal
chcp 65001 >nul
pushd "%~dp0"

if not exist "WhalesLauncher.exe" (
  echo.
  echo   Error: WhalesLauncher.exe was not found next to this file.
  echo   Please extract the WHOLE archive first, then run this again.
  echo.
  pause
  popd
  endlocal
  exit /b 1
)

echo   Starting WhalesLauncher ...
echo.

"%~dp0WhalesLauncher.exe"
set "code=%ERRORLEVEL%"

if not "%code%"=="0" (
  echo.
  echo   WhalesLauncher exited with code %code%.
  echo   See README (Chinese) in this folder, and the logs folder
  echo   created next to the program, for details.
  echo.
  pause
)

popd
endlocal
exit /b %code%
