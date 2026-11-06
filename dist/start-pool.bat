@echo off
REM ============================================================
REM  LudKey Hunter - POOL mode (double-click to run).
REM  The Go agent talks to the coordinator and feeds leased
REM  ranges to the GPU (ludkey_cuda.exe --serve). On a find it
REM  auto-sweeps to your payout address. If the coordinator is
REM  unreachable it keeps searching offline and uploads later.
REM
REM  Put this file in the SAME folder as:
REM     ludkey-agent.exe   and   ludkey_cuda.exe
REM  No x64 Native Tools prompt needed to RUN (only to rebuild).
REM ============================================================
cd /d "%~dp0"
title LudKey Hunter - Pool (GPU)
echo Starting pool search. Close this window or press Ctrl+C to stop.
echo.
ludkey-agent.exe -gpu
echo.
echo [agent stopped]
pause
