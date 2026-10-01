@echo off
rem Spusti build.ps1 bez ohledu na zasady spousteni skriptu PowerShellu.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
