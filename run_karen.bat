@echo off
title Karen Assistant Manager
echo ========================================================
echo             KAREN ASSISTANT SYSTEM LAUNCHER
echo ========================================================
echo.

:: 1. Maximize/Fullscreen the console window (supports both legacy CMD and new Windows Terminal)
powershell -Command "(New-Object -ComObject Wscript.Shell).SendKeys('%%{ENTER}')"
powershell -Command "(New-Object -ComObject Wscript.Shell).SendKeys('{F11}')"

:: 2. Launch background daemon minimized in a separate command prompt window
echo [System] Launching background Daemon scheduler (minimized)...
start /min "Karen Daemon Scheduler" cmd /c python daemon.py

:: 3. Launch interactive chatbot CLI in the current command prompt window
echo [System] Launching chatbot console...
echo --------------------------------------------------------
python cli.py

echo.
echo [System] Karen session ended.
pause
