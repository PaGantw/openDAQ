@echo off
setlocal
cd /d "%~dp0..\..\.."
where cl >nul 2>&1
if errorlevel 1 goto need_visual_studio
where git >nul 2>&1
if errorlevel 1 goto need_git
py -3.12 --version
if errorlevel 1 goto need_python
py -3.12 -m venv "build\daq-web-tools"
if errorlevel 1 goto failed
call "build\daq-web-tools\Scripts\activate.bat"
python -m pip install cmake==3.31.10 ninja==1.13.0
if errorlevel 1 goto failed
set "CMAKE_GENERATOR=Ninja"
python examples\applications\daq_web\build.py --parallel 4
if errorlevel 1 goto failed
echo.
echo Build succeeded. Run examples\applications\daq_web\start_windows.cmd
exit /b 0
:need_visual_studio
echo Open "x64 Native Tools Command Prompt for VS 2022" and run this script again.
echo Install the Desktop development with C++ workload, MSVC v143, and a Windows SDK.
exit /b 1
:need_git
echo Install Git for Windows, then open a new developer command prompt.
exit /b 1
:need_python
echo Install Python 3.12 with the Windows Python launcher, then retry.
exit /b 1
:failed
echo Build failed. Copy the first error and the final 30 output lines for diagnosis.
exit /b 1
