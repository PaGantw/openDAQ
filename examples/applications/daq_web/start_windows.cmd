@echo off
setlocal
cd /d "%~dp0..\..\.."
if not exist "build\daq-web-tools\Scripts\python.exe" goto not_built
if not exist "build\daq-web\bin\daq_web_bridge.exe" goto not_built
echo Open http://127.0.0.1:8080 in your browser after startup.
echo Keep this window open. Press Ctrl+C to stop.
"build\daq-web-tools\Scripts\python.exe" examples\applications\daq_web\server.py --bridge build\daq-web\bin\daq_web_bridge.exe --modules build\daq-web\bin --recordings build\daq-web\recordings
if errorlevel 1 pause
exit /b
:not_built
echo Run build_windows.cmd from the Visual Studio x64 developer command prompt first.
pause
exit /b 1
