@echo off
REM LudKey Hunter — GPU agent, double-click to run.
REM Searches Puzzle #72 on the GPU (standalone) and saves progress to
REM ludkey-progress-gpu.txt in this folder; it resumes from there next time.
REM Put this file in the SAME folder as ludkey_cuda.exe.
cd /d "%~dp0"
title LudKey Hunter - GPU
echo Starting GPU search (Puzzle #72). Close this window or press Ctrl+C to stop.
echo.
ludkey_cuda.exe --standalone
echo.
echo [agent stopped]
pause
