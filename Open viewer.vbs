Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = files.GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd.exe /c """ & files.BuildPath(shell.CurrentDirectory, "start.bat") & """", 0, False
