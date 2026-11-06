@echo off
REM ============================================================
REM  Fair A/B: dedicated squaring (-DUSE_SQR) ON vs OFF.
REM  Builds both, runs a 30s sustained-average bench on each,
REM  prints the two averages. Put in the SAME folder as main.cu
REM  and the .cuh files; run from the x64 Native Tools prompt.
REM
REM  Stop any running search first (Ctrl+C) so the GPU is idle,
REM  otherwise the numbers are skewed by contention.
REM ============================================================
cd /d "%~dp0"

echo === Building WITHOUT -DUSE_SQR ...
nvcc -O3 -arch=sm_75 -DWIN=896 -DTPB=128 -DUSE_PTX_MUL main.cu -o nb_nosqr.exe 2>nul
echo === Building WITH -DUSE_SQR ...
nvcc -O3 -arch=sm_75 -DWIN=896 -DTPB=128 -DUSE_PTX_MUL -DUSE_SQR main.cu -o nb_sqr.exe 2>nul
echo.

if not exist nb_nosqr.exe ( echo BUILD FAILED: no-sqr & pause & exit /b 1 )
if not exist nb_sqr.exe   ( echo BUILD FAILED: sqr    & pause & exit /b 1 )

echo ======================================================
echo  A) WITHOUT -DUSE_SQR  (30s average)
echo ======================================================
nb_nosqr.exe --avgbench 30 | findstr /C:"Mkey/s" /C:"MISMATCH"
echo.
echo ======================================================
echo  B) WITH -DUSE_SQR  (30s average)
echo ======================================================
nb_sqr.exe --avgbench 30 | findstr /C:"Mkey/s" /C:"MISMATCH"
echo.

del nb_nosqr.exe nb_sqr.exe 2>nul
echo ======================================================
echo  Compare the two "sustained average" numbers above.
echo  Higher wins. Build your production exe with/without
echo  -DUSE_SQR accordingly.
echo ======================================================
pause
