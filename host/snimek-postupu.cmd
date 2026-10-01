@echo off
rem Ulozi snimek bezici tapety do slozky postup\ (viz snimek-postupu.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0snimek-postupu.ps1" %*
