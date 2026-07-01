@echo off
title Karen Assistant Manager
echo ========================================================
echo             KAREN ASSISTANT SYSTEM LAUNCHER
echo ========================================================
echo.

:: 1. Launch background daemon minimized in a separate command prompt window
echo [System] Launching background Daemon scheduler (minimized)...
start /min "Karen Daemon Scheduler" cmd /c python daemon.py

:: 2. Launch interactive chatbot CLI in the current command prompt window
echo [System] Launching chatbot console...
echo --------------------------------------------------------
python cli.py

echo.
echo [System] Karen session ended.
pause
