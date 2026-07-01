@echo off
title Karen Assistant Manager
echo ========================================================
echo             KAREN ASSISTANT SYSTEM LAUNCHER
echo ========================================================
echo.

:: 1. Check if virtual environment exists and activate it if found
if exist "venv\Scripts\activate.bat" (
    echo [System] Activating virtual environment...
    call venv\Scripts\activate.bat
)

:: 2. Launch background daemon in a separate command prompt window
echo [System] Launching background Daemon scheduler in a separate window...
start "Karen Daemon Scheduler" cmd /k python daemon.py

:: 3. Launch interactive chatbot CLI in the current command prompt window
echo [System] Launching chatbot console...
echo --------------------------------------------------------
python cli.py

echo.
echo [System] Karen session ended.
pause
