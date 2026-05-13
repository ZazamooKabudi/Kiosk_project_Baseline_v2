@echo off
chcp 65001 >nul
echo ============================================
echo   Kiosk Player — Build EXE
echo ============================================
echo.

cd /d "%~dp0"

echo [1/2] Installing / updating dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: npm install failed.
    pause & exit /b 1
)

echo.
echo [2/2] Building portable Windows EXE...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Build failed. See errors above.
    pause & exit /b 1
)

echo.
echo ============================================
echo   Build OK!
echo   Output: %~dp0dist\
echo ============================================
echo.
pause
