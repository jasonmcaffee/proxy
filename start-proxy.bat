@echo off
setlocal enabledelayedexpansion
echo Starting Proxy Service...
echo.

echo Checking for processes on port 80...
for /f "tokens=2,5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr /R /C:"[0-9.]*:80[^0-9]"') do (
    echo Found process %%b on port %%a, killing it...
    taskkill /PID %%b /F >nul 2>&1
    if !errorlevel! equ 0 (
        echo Successfully killed process %%b on port %%a
    ) else (
        echo Failed to kill process %%b on port %%a
    )
)

echo.
echo Starting proxy service...
npm run start

pause
