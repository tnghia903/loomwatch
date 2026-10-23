@echo off
rem LoomWatch from a copy of its source on Windows: loomwatch starts it, loomwatch stop stops it,
rem loomwatch help lists the rest.
rem One line, so a git pull that replaces this file while it runs cannot leave cmd.exe reading the
rem new one; a bare "exit /b" there would lose the exit code, so success and failure are said.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\loomwatch.ps1" %* && exit /b 0 || exit /b 1
