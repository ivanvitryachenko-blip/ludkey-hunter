@echo off
REM LudKey Hunter — run the CPU (Go) and GPU (CUDA) agents together.
REM
REM Both search Puzzle #72 in standalone mode (no server needed) and SHARE their
REM progress: the Go agent writes ludkey-progress.txt, the CUDA agent writes
REM ludkey-progress-gpu.txt, and each reads BOTH on startup, so CPU and GPU never
REM scan the same 2^25 segment twice. Combined throughput = CPU + GPU.
REM
REM Put ludkey-agent.exe (Go) and ludkey_cuda.exe (CUDA) in THIS folder, then run
REM this file. Build the CUDA one first: cd packages\agent-cuda ^&^& make SM=75
REM (or: nvcc -O3 -arch=sm_75 -DWIN=64 src\main.cu -o ..\..\ludkey_cuda.exe)

setlocal
cd /d "%~dp0"

if not exist ludkey-agent.exe echo [!] ludkey-agent.exe (Go CPU agent) not found in this folder.
if not exist ludkey_cuda.exe  echo [!] ludkey_cuda.exe (CUDA GPU agent) not found — build it in packages\agent-cuda.

echo Starting CPU (Go) + GPU (CUDA) agents, shared progress, Puzzle #72...
if exist ludkey-agent.exe start "LudKey CPU (Go)" ludkey-agent.exe -standalone
if exist ludkey_cuda.exe  start "LudKey GPU (CUDA)" ludkey_cuda.exe --standalone
echo.
echo Two windows opened (CPU and GPU). Close them to stop. Progress is saved in
echo ludkey-progress.txt (CPU) and ludkey-progress-gpu.txt (GPU) and resumes next run.
endlocal
