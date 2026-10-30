@echo off
REM Starts Workshop Inventory. First run installs dependencies.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install --omit=dev
if "%PORT%"=="" set PORT=3100
echo Open http://localhost:%PORT%  (or http://^<this-computer's-ip^>:%PORT% from your phone)
node dist\index.js
pause
