@echo off
chcp 65001 >nul
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [Error] Node.js ^(^>= 22^) not found. Please install Node.js LTS first.
    if not "%DXL_NO_PAUSE%"=="1" pause
    popd
    exit /b 1
)

node bin\unpatch-app.js %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [Error] Execution failed ^(Exit Code: %EXIT_CODE%^). Check the output above.
)

if not "%DXL_NO_PAUSE%"=="1" (
    echo.
    pause
)

popd
exit /b %EXIT_CODE%
