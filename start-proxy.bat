@echo off
setlocal enabledelayedexpansion
echo Starting Proxy Service...
echo.

echo Checking for processes on port 80 (IPv4)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":80 " ^| findstr LISTENING') do (
    echo Found IPv4 process %%a on port 80, killing it...
    taskkill /PID %%a /F >nul 2>&1
    if !errorlevel! equ 0 (
        echo Successfully killed IPv4 process %%a
    ) else (
        echo Failed to kill IPv4 process %%a
    )
)

echo.
echo Checking for processes on port 80 (IPv6)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "\[::\]:80" ^| findstr LISTENING') do (
    echo Found IPv6 process %%a on port 80, killing it...
    taskkill /PID %%a /F >nul 2>&1
    if !errorlevel! equ 0 (
        echo Successfully killed IPv6 process %%a
    ) else (
        echo Failed to kill IPv6 process %%a
    )
)

echo.
echo Starting proxy service...
npm run start

pause
