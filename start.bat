@echo off
echo ==========================================
echo   Kiosk Manager Server
echo ==========================================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    npm install
    echo.
)

echo Starting server on port 3000...
echo.
echo Admin interface: http://localhost:3000
echo Default login:   nivm / (your password)
echo.
echo Press Ctrl+C to stop the server.
echo ==========================================
echo.

node server.js
pause
