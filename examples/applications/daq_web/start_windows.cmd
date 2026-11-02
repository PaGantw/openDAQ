@echo off
setlocal
cd /d "%~dp0..\..\.."
if not exist "build\daq-web-tools\Scripts\python.exe" goto missing_python
set "DAQ_WEB_BIN=build\daq-web\bin"
if exist "%DAQ_WEB_BIN%\daq_web_bridge.exe" goto bridge_found
for %%C in (Release RelWithDebInfo Debug MinSizeRel) do if exist "build\daq-web\bin\%%C\daq_web_bridge.exe" (
    set "DAQ_WEB_BIN=build\daq-web\bin\%%C"
    goto bridge_found
)
echo Cannot find daq_web_bridge.exe under build\daq-web\bin or its configuration folders.
goto not_built
:bridge_found
set "DAQ_WEB_PORT=%~1"
if not defined DAQ_WEB_PORT set "DAQ_WEB_PORT=18080"
echo Default port is 18080. An optional first argument selects another port.
echo The server will print its browser address after startup.
echo Keep this window open. Press Ctrl+C to stop.
"build\daq-web-tools\Scripts\python.exe" examples\applications\daq_web\server.py --bridge "%DAQ_WEB_BIN%\daq_web_bridge.exe" --modules "%DAQ_WEB_BIN%" --recordings build\daq-web\recordings --port "%DAQ_WEB_PORT%"
if errorlevel 1 pause
exit /b
:missing_python
echo Cannot find build\daq-web-tools\Scripts\python.exe.
:not_built
echo Run build_windows.cmd from the Visual Studio x64 developer command prompt first.
pause
exit /b 1
