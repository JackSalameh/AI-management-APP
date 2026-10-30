' Codex Projects Management - Windows launcher (no console window). (c) 2026 Jack Salameh
Option Explicit
Dim sh, fso, dir, nodeExe, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
rc = sh.Run("cmd /c where node >nul 2>nul", 0, True)
If rc <> 0 Then
  MsgBox "Node.js 22 or newer is required." & vbCrLf & "Install it from https://nodejs.org, then start this launcher again.", vbExclamation, "Codex Projects Management"
  WScript.Quit 1
End If
sh.CurrentDirectory = dir
' Window style 0 = hidden. The server opens the app window itself and reuses a running instance.
sh.Run "node """ & dir & "\server.mjs"" --open", 0, False
