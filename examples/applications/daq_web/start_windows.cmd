@echo off
setlocal
cd /d "%~dp0..\..\.."
if not exist "build\daq-web-tools\Scripts\python.exe" goto not_built
if not exist "build\daq-web\bin\daq_web_bridge.exe" goto not_built
set "DAQ_WEB_PORT=%~1"
if not defined DAQ_WEB_PORT set "DAQ_WEB_PORT=18080"
echo Default port is 18080. An optional first argument selects another port.
echo The server will print its browser address after startup.
echo Keep this window open. Press Ctrl+C to stop.
"build\daq-web-tools\Scripts\python.exe" examples\applications\daq_web\server.py --bridge build\daq-web\bin\daq_web_bridge.exe --modules build\daq-web\bin --recordings build\daq-web\recordings --port "%DAQ_WEB_PORT%"
if errorlevel 1 pause
exit /b
:not_built
echo Run build_windows.cmd from the Visual Studio x64 developer command prompt first.
pause
exit /b 1
