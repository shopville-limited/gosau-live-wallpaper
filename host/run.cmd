@echo off
rem Spusti run.ps1 bez ohledu na zasady spousteni skriptu PowerShellu.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
