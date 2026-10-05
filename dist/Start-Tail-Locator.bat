@echo off
title Tail Locator
cd /d "%~dp0"
where py >nul 2>nul && (py -3 tail_locator.py %* & goto :end)
where python >nul 2>nul && (python tail_locator.py %* & goto :end)
echo Python 3 was not found. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and run this again.
:end
pause
