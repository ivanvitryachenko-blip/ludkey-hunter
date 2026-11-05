@echo off
REM ============================================================
REM  LudKey Hunter - GPU agent (double-click to run)
REM ------------------------------------------------------------
REM  Searches Puzzle #72 on the GPU and saves progress to
REM  ludkey-progress-gpu.txt in THIS folder (it resumes next time).
REM
REM  Put this file in the SAME folder as:
REM     ludkey_cuda.exe    (the GPU searcher)
REM     ludkey-agent.exe   (the signer that does the auto-sweep)
REM
REM  On a find, ludkey_cuda.exe writes FOUND_KEY.txt and exits.
REM  This launcher then runs ludkey-agent.exe to sweep the prize
REM  to YOUR address -- nothing is sent anywhere else. The key
REM  also stays saved in FOUND_KEY.txt so you can import it by
REM  hand if you ever want to.
REM ============================================================
cd /d "%~dp0"
title LudKey Hunter - GPU

echo Starting GPU search (Puzzle #72).
echo Close this window or press Ctrl+C to stop.
echo.

ludkey_cuda.exe --standalone

echo.
echo [GPU agent stopped]

REM --- if a key was found, auto-sweep it to your address ---
if exist "FOUND_KEY.txt" (
  echo.
  echo ============================================================
  echo  KEY FOUND. Sweeping the prize to your address...
  echo ============================================================
  echo.
  if exist "ludkey-agent.exe" (
    ludkey-agent.exe -sweepfile "FOUND_KEY.txt"
  ) else (
    echo ludkey-agent.exe is not in this folder, so the auto-sweep
    echo did not run. The private key is saved in FOUND_KEY.txt --
    echo import it into a wallet to claim the prize.
  )
)

echo.
pause
