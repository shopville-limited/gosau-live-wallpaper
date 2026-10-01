@echo off
rem Samotest ve WebView2, viz test.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0test.ps1" %*
