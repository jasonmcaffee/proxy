@echo off
echo Starting Proxy Service...
echo.

echo Checking for processes on port 80...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :80 ^| findstr LISTENING') do (
    echo Found process %%a on port 80, killing it...
    taskkill /PID %%a /F >nul 2>&1
    if !errorlevel! equ 0 (
        echo Successfully killed process %%a
    ) else (
        echo Failed to kill process %%a
    )
)

echo.
echo Starting proxy service...
npm run start

pause
