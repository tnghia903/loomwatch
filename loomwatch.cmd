@echo off
rem LoomWatch on Windows: loomwatch starts it, loomwatch stop stops it, loomwatch help lists the rest.
rem One line, so an update that replaces this file while it runs cannot leave cmd.exe reading the new one.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\loomwatch.ps1" %* & exit /b
