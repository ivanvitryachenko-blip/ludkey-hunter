@echo off
REM ============================================================
REM  W / TPB sweep for the CUDA agent (quick single-batch bench).
REM  Put this in the SAME folder as main.cu and the other src files,
REM  open the x64 Native Tools Command Prompt, cd into that folder,
REM  and run:  sweep-wtpb.bat
REM
REM  It rebuilds the agent for each (W, TPB) pair WITH the PTX
REM  multiply, benches it 3x, and prints a summary table at the end.
REM  Single-batch numbers are noisy — use them only to pick the top
REM  2-3 pairs, then confirm those with a sustained --standalone run.
REM ============================================================
cd /d "%~dp0"
setlocal enabledelayedexpansion
if exist sweep_results.txt del sweep_results.txt

for %%W in (384 512 640 768 896) do (
  for %%T in (128 256) do (
    echo ========================================
    echo Building W=%%W TPB=%%T ...
    nvcc -O3 -arch=sm_75 -DWIN=%%W -DTPB=%%T -DUSE_PTX_MUL main.cu -o bench_tmp.exe >nul 2>build_err.txt
    if exist bench_tmp.exe (
      echo --- W=%%W TPB=%%T --->> sweep_results.txt
      for /l %%i in (1,1,3) do (
        for /f "delims=" %%L in ('bench_tmp.exe ^| findstr /C:"Mkey/s" /C:"MISMATCH"') do (
          echo    %%L
          echo %%L>> sweep_results.txt
        )
      )
      del bench_tmp.exe 2>nul
    ) else (
      echo BUILD FAILED W=%%W TPB=%%T
      echo --- W=%%W TPB=%%T : BUILD FAILED --->> sweep_results.txt
    )
  )
)

echo.
echo ================= SUMMARY =================
type sweep_results.txt
echo ==========================================
echo.
echo Copy the summary above and send it back.
pause
