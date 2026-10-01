@echo off
rem Spusti uninstall.ps1 bez ohledu na zasady spousteni skriptu PowerShellu.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
