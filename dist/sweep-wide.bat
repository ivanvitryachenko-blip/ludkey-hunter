@echo off
REM ============================================================
REM  Wide W/TPB sweep using the SUSTAINED-average benchmark.
REM  Rebuilds for each (W, TPB) with PTX mul + dedicated sqr and
REM  the read-only-cached delta reads, runs a 20 s average, and
REM  prints a comparison. Put in the folder with main.cu + the
REM  .cuh files; run from the x64 Native Tools prompt. Stop any
REM  running search first so the GPU is idle.
REM
REM  GTX 1650 / Turing: leave ARCH=sm_75 (below).
REM  RTX 5070 / Blackwell: change ARCH to sm_120 (needs CUDA 12.8+).
REM  Big-L2 cards (5070): the larger W values matter most here.
REM ============================================================
cd /d "%~dp0"
set ARCH=sm_75
if exist widesweep.txt del widesweep.txt

for %%W in (896 1536 2048 3072) do (
  for %%T in (128 256) do (
    echo ========================================
    echo Building W=%%W TPB=%%T (arch %ARCH%) ...
    nvcc -O3 -arch=%ARCH% -DWIN=%%W -DTPB=%%T -DUSE_PTX_MUL -DUSE_SQR main.cu -o wb_tmp.exe 2>nul
    if exist wb_tmp.exe (
      wb_tmp.exe --avgbench 20 | findstr /C:"Mkey/s" /C:"MISMATCH" >> widesweep.txt
      wb_tmp.exe --avgbench 20 | findstr /C:"Mkey/s" /C:"MISMATCH"
      del wb_tmp.exe
    ) else (
      echo BUILD FAILED / too many resources for W=%%W TPB=%%T  (expected for very large W)
      echo W=%%W TPB=%%T : build failed>> widesweep.txt
    )
  )
)

echo.
echo ================= SUMMARY =================
type widesweep.txt
echo ==========================================
echo Pick the highest sustained Mkey/s; build your production
echo exe with that -DWIN / -DTPB. Send the summary back.
pause
