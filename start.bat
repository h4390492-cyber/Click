@echo off
title Click
cd /d "%~dp0"

echo ============================================
echo   CLICK - Standalone AI Assistant
echo ============================================
echo.

:: Quick environment checks
where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python not found! Please install Python 3.10+ and add to PATH.
    pause
    exit /b 1
)

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found! Please install Node.js 18+ and add to PATH.
    pause
    exit /b 1
)

:: One-time setup: only run pip/npm on true first run
if not exist "backend\.installed" (
    echo [Setup] First run: Installing Python dependencies...
    pip install -r backend\requirements.txt
    if %ERRORLEVEL% equ 0 (
        type nul > "backend\.installed"
        echo [Setup] Python dependencies installed successfully.
    ) else (
        echo [ERROR] Failed to install Python dependencies. Please check your network and Python installation.
        pause
        exit /b 1
    )
)

if not exist "electron\node_modules" (
    echo [Setup] First run: Installing Electron dependencies...
    cd electron
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install Node dependencies. Please check your internet connection.
        cd ..
        pause
        exit /b 1
    )
    cd ..
    echo [Setup] Electron dependencies installed successfully.
)

:: Start Python backend in background (instant, no delays)
start /B "Click-Backend" python backend\server.py

:: Start Electron immediately
echo Starting Click...
cd electron
if exist "node_modules\.bin\electron.cmd" (
    call node_modules\.bin\electron.cmd .
) else (
    call npx electron .
)
cd ..

:: Cleanup: Kill the Python backend when Electron closes
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
taskkill /f /im python.exe /fi "WINDOWTITLE eq Click-Backend" >nul 2>&1
echo.
echo Click closed.
