@echo off
title Click — Privacy Vision Agent
cd /d "%~dp0"

echo ====================================================================
echo   🖱️  CLICK — Privacy-Preserving Browser Vision Agent
echo ====================================================================
echo.

:: Check Python
where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python not found! Please install Python 3.10+ and add to PATH.
    pause
    exit /b 1
)

:: Set UTF-8
chcp 65001 >nul
set PYTHONIOENCODING=utf-8

:: Check dependencies
echo [1/3] Checking dependencies...
pip install -r backend\requirements.txt --quiet 2>nul
echo       Dependencies verified.
echo.

echo [2/3] Starting Click Server...
echo       📡 HTTP Server:    http://127.0.0.1:8765
echo       🔌 WebSocket:      ws://127.0.0.1:8765/ws/browser_agent
echo       🛒 Demo Suite:     http://127.0.0.1:8765/demo/
echo.

start "Click-Server" cmd /k "cd /d %~dp0\backend && set PYTHONIOENCODING=utf-8 && python server.py"

:: Wait for server startup
echo Waiting for server to initialize...
timeout /t 3 /nobreak >nul

echo.
echo [3/3] Launching Browser & Testbed...
echo.
echo ====================================================================
echo   QUICK SETUP (Takes 5 seconds):
echo   1. In Chrome/Edge, open: chrome://extensions
echo   2. Enable "Developer mode" (top-right toggle)
echo   3. Click "Load unpacked" and select this folder:
echo      "%~dp0browser-extension"
echo   4. Pin the Click extension icon to your toolbar!
echo ====================================================================
echo.

:: Open demo page in default browser
start http://127.0.0.1:8765/demo/

echo Click is now running. Press any key to stop the server.
pause >nul

:: Cleanup on exit
taskkill /f /fi "WINDOWTITLE eq Click-Server" >nul 2>&1
echo Click closed.
