@echo off
rem Spusti install.ps1 bez ohledu na zasady spousteni skriptu PowerShellu.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
