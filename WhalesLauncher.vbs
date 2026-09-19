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
'  Failure reporting matters more here than anywhere else: the console
'  that would have shown the error is hidden, so a broken start would
'  otherwise fail *silently*. Signals used:
'    1. exit code of "node scripts\launch.mjs" - launch.mjs only returns
'       after Electron exits, so non-zero means "never came up"/"crashed";
'    2. everything the attempt printed lands in
'       logs\launcher-shortcut.log (launch.mjs is its ONLY writer, and it
'       rotates the previous run into logs\history\). The redirect below
'       goes to a SEPARATE file on purpose - see the note at the call.
' ===================================================================
Option Explicit

Dim shell, fso, scriptDir, launcher, logFile, consoleFile, cmd, code, shellNote

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = scriptDir & "\scripts\launch.mjs"

If Not fso.FileExists(launcher) Then
  MsgBox "WhalesLauncher: scripts\launch.mjs is missing." & vbCrLf & _
         "Expected here: " & launcher & vbCrLf & vbCrLf & _
         "The project folder looks incomplete or was moved.", _
         16, "WhalesLauncher"
  WScript.Quit 1
End If

' Check Node.js up front: otherwise the hidden cmd swallows the error and
' the user just sees "nothing happened".
If FindOnPath("node.exe") = "" Then
  MsgBox "WhalesLauncher needs Node.js 22 or newer, but no node.exe was found on PATH." & vbCrLf & vbCrLf & _
         "Install it from https://nodejs.org/ and sign out / back in so PATH" & vbCrLf & _
         "takes effect. For the full explanation, run the .bat launcher in" & vbCrLf & _
         "the project root instead.", _
         16, "WhalesLauncher"
  WScript.Quit 1
End If

If Not fso.FolderExists(scriptDir & "\logs") Then
  On Error Resume Next
  fso.CreateFolder(scriptDir & "\logs")
  On Error GoTo 0
End If

logFile = scriptDir & "\logs\launcher-shortcut.log"
consoleFile = scriptDir & "\logs\launcher-console-" & TimeStamp() & ".log"
shell.CurrentDirectory = scriptDir

' The redirect target MUST be a different file from --log.
'
' Why (found by measurement): the first version redirected into the same
' path, "... --log=<logFile> > <logFile> 2>&1". cmd empties and holds
' <logFile> BEFORE node starts, so launch.mjs's rotation saw a file that
' had just been truncated, archived that empty file into history on every
' single start, and then Electron overwrote the real failure output. The
' rotation looked alive but preserved nothing.
' Now launch.mjs is the only writer of launcher-shortcut.log, and this
' redirect only catches errors raised earlier - e.g. node.exe missing from
' PATH at execution time.
'
' A timestamped name keeps consecutive failures side by side instead of
' each one overwriting the last; anything older than a week is swept away
' first (these files are empty in the normal case, so the sweep is cheap).
SweepOldConsoleLogs scriptDir & "\logs", 7

cmd = "cmd /c node """ & launcher & """ --quiet --log=""" & logFile & """ > """ & consoleFile & """ 2>&1"
code = shell.Run(cmd, 0, True)

If code = 0 Then
  WScript.Quit 0
End If

' On failure, show shell-level output first (it explains the cases where
' node never ran), otherwise point at the log file that launch.mjs wrote.
shellNote = ""
On Error Resume Next
If fso.FileExists(consoleFile) Then
  If fso.GetFile(consoleFile).Size > 0 Then
    shellNote = vbCrLf & vbCrLf & "Shell-level output:" & vbCrLf & ReadHead(consoleFile, 800)
  End If
End If
On Error GoTo 0

MsgBox "WhalesLauncher failed to start (exit code " & code & ")." & vbCrLf & vbCrLf & _
       "Read this first: " & scriptDir & "\logs\launcher-summary.log" & _
       vbCrLf & "Full log: " & logFile & shellNote & vbCrLf & vbCrLf & _
       "For the full walkthrough, run the .bat launcher in the project root.", _
       16, "WhalesLauncher"
WScript.Quit code

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

' ------------------------------------------------------------------
' Look up an executable on PATH without starting it. App Paths wins,
' then every directory listed in %PATH%.
' ------------------------------------------------------------------
Function FindOnPath(exeName)
  Dim appPath, pathVar, parts, i, candidate
  FindOnPath = ""

  On Error Resume Next
  appPath = shell.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" & exeName & "\")
  On Error GoTo 0
  If VarType(appPath) = vbString Then
    If appPath <> "" And fso.FileExists(appPath) Then
      FindOnPath = appPath
      Exit Function
    End If
  End If

  pathVar = shell.ExpandEnvironmentStrings("%PATH%")
  parts = Split(pathVar, ";")
  For i = 0 To UBound(parts)
    candidate = Trim(parts(i))
    If candidate <> "" Then
      If Right(candidate, 1) <> "\" Then candidate = candidate & "\"
      If fso.FileExists(candidate & exeName) Then
        FindOnPath = candidate & exeName
        Exit Function
      End If
    End If
  Next
End Function
