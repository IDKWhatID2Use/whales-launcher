' ===================================================================
'  WhalesLauncher - windowless launcher (this is what desktop
'  shortcuts point at).
'
'  Double-clicking a .bat always flashes a console window; starting
'  through this .vbs instead uses window style 0, so WhalesLauncher
'  opens like an ordinary application.
'
'  !! PURE ASCII ONLY - THIS FILE MUST CONTAIN ZERO NON-ASCII BYTES. !!
'  WSH reads .vbs as ANSI (code page 936 here), so UTF-8 Chinese in a
'  comment decodes into stray bytes - measured: it turned into a syntax
'  error at "end of statement expected" pointing at a line BELOW the
'  comment, i.e. the comment swallowed part of the code. Do not add
'  Chinese here, not even in a comment.
'
'  HISTORY (why the target changed):
'    This file used to run "node scripts\launch.mjs"; the front end is
'    now a native WinUI 3 application (desktop\src\WhalesLauncher.App)
'    and launch.mjs was deleted. Calling it produced a message box
'    saying "scripts\launch.mjs is missing" on every shortcut launch.
'    The target is now scripts\launch-app.ps1.
'
'  Failure reporting matters more here than anywhere else: the console
'  that would have shown the error is hidden, so a broken start would
'  otherwise fail *silently*. Signals used:
'    1. scripts\launch-app.ps1 is run with -Wait, so it stays alive for
'       as long as the app does. While the app is up this script exits 0
'       and the console tears down by itself - nothing is killed.
'    2. If the app is gone within 10 seconds, that is a start failure:
'       the launcher is terminated and its output - which explains why -
'       is shown in a message box. Everything the attempt printed also
'       lands in logs\launcher-console-<timestamp>.log.
' ===================================================================
Option Explicit

Dim shell, fso, scriptDir, launcher, consoleFile, cmd, code, shellNote, waited, running

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = scriptDir & "\scripts\launch-app.ps1"

If Not fso.FileExists(launcher) Then
  MsgBox "WhalesLauncher: scripts\launch-app.ps1 is missing." & vbCrLf & _
         "Expected here: " & launcher & vbCrLf & vbCrLf & _
         "The project folder looks incomplete or was moved.", _
         16, "WhalesLauncher"
  WScript.Quit 1
End If

If Not fso.FolderExists(scriptDir & "\logs") Then
  On Error Resume Next
  fso.CreateFolder(scriptDir & "\logs")
  On Error GoTo 0
End If

consoleFile = scriptDir & "\logs\launcher-console-" & TimeStamp() & ".log"
shell.CurrentDirectory = scriptDir

' These files are empty in the normal case, so the sweep is cheap; a
' timestamped name keeps consecutive failures side by side instead of
' each one overwriting the last.
SweepOldConsoleLogs scriptDir & "\logs", 7

' No "pause" here on purpose: this console has no stdin, so "pause" would
' block forever after a failure and leave a hidden powershell.exe behind.
' launch-app.ps1 -Wait keeps the console alive for exactly as long as the
' app lives, which is the liveness signal polled below.
' Window style 0 hides the console; window style 7 would minimise it.
cmd = "cmd /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & launcher & """ -Wait > """ & consoleFile & """ 2>&1"

On Error Resume Next
code = shell.Run(cmd, 0, False)
If Err.Number <> 0 Then
  MsgBox "WhalesLauncher could not start its launcher process." & vbCrLf & vbCrLf & _
         "Error: " & Err.Description, 16, "WhalesLauncher"
  WScript.Quit 1
End If
On Error GoTo 0

' Wait for the app to come up: the launcher prints the exe path, builds
' nothing, and returns immediately after Start-Process, so 10 seconds is
' generous even on a cold start. A healthy app simply keeps running, and
' in that case this script exits while the app stays up.
running = False
For waited = 1 To 20
  WScript.Sleep 500
  If IsAppRunning() Then
    running = True
    Exit For
  End If
Next

If running Then
  WScript.Quit 0
End If

' ---------------------------------------------------------------- failure
' Kill the launcher first, otherwise the hidden console lingers.
On Error Resume Next
shell.Run "taskkill /f /im powershell.exe /fi ""WINDOWTITLE eq*"" ", 0, True
On Error GoTo 0

shellNote = ""
On Error Resume Next
If fso.FileExists(consoleFile) Then
  If fso.GetFile(consoleFile).Size > 0 Then
    shellNote = vbCrLf & vbCrLf & "Output:" & vbCrLf & ReadHead(consoleFile, 800)
  End If
End If
On Error GoTo 0

MsgBox "WhalesLauncher did not start." & vbCrLf & vbCrLf & _
       "Most common reason: the app has not been built yet." & vbCrLf & _
       "Build it once with:  npm run build" & vbCrLf & _
       "or run the .bat launcher in the project root and pass --build." & _
       shellNote & vbCrLf & vbCrLf & _
       "Log: " & consoleFile, _
       16, "WhalesLauncher"
WScript.Quit 1

' ------------------------------------------------------------------
' True when a WhalesLauncher.exe process exists.
' ------------------------------------------------------------------
Function IsAppRunning()
  Dim wmi, procs, p
  IsAppRunning = False
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then Exit Function
  Set procs = wmi.ExecQuery("SELECT Name FROM Win32_Process WHERE Name = 'WhalesLauncher.exe'")
  If Err.Number <> 0 Then Exit Function
  For Each p In procs
    IsAppRunning = True
    Exit For
  Next
  On Error GoTo 0
End Function

' ------------------------------------------------------------------
' Read the first maxChars characters of a text file (for the message box).
' ------------------------------------------------------------------
Function ReadHead(filePath, maxChars)
  Dim stream, text
  ReadHead = ""
  On Error Resume Next
  Set stream = fso.OpenTextFile(filePath, 1)
  If Err.Number = 0 Then
    If Not stream.AtEndOfStream Then
      text = stream.Read(maxChars)
      ReadHead = text
    End If
    stream.Close
  End If
  On Error GoTo 0
End Function

' ------------------------------------------------------------------
' YYYYMMDD-HHMMSS, for log file names.
' ------------------------------------------------------------------
Function TimeStamp()
  Dim d, pad2
  d = Now
  pad2 = ""
  If Len(CStr(Month(d))) = 1 Then pad2 = "0"
  TimeStamp = CStr(Year(d)) & pad2 & CStr(Month(d))
  pad2 = ""
  If Len(CStr(Day(d))) = 1 Then pad2 = "0"
  TimeStamp = TimeStamp & pad2 & CStr(Day(d)) & "-"
  pad2 = ""
  If Len(CStr(Hour(d))) = 1 Then pad2 = "0"
  TimeStamp = TimeStamp & pad2 & CStr(Hour(d))
  pad2 = ""
  If Len(CStr(Minute(d))) = 1 Then pad2 = "0"
  TimeStamp = TimeStamp & pad2 & CStr(Minute(d))
  pad2 = ""
  If Len(CStr(Second(d))) = 1 Then pad2 = "0"
  TimeStamp = TimeStamp & pad2 & CStr(Second(d))
End Function

' ------------------------------------------------------------------
' Delete launcher-console-*.log files older than maxAgeDays.
' ------------------------------------------------------------------
Sub SweepOldConsoleLogs(dirPath, maxAgeDays)
  Dim folder, file
  On Error Resume Next
  If Not fso.FolderExists(dirPath) Then Exit Sub
  Set folder = fso.GetFolder(dirPath)
  For Each file In folder.Files
    If Left(file.Name, 17) = "launcher-console-" Then
      If DateDiff("d", file.DateLastModified, Now) > maxAgeDays Then
        fso.DeleteFile file.Path, True
      End If
    End If
  Next
  On Error GoTo 0
End Sub
