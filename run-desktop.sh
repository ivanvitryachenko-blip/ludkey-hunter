#!/usr/bin/env bash
# LudKey Hunter — run the CPU (Go) and GPU (CUDA) agents together (Linux/macOS).
#
# Both search Puzzle #72 in standalone mode and SHARE progress: the Go agent
# writes ludkey-progress.txt, the CUDA agent writes ludkey-progress-gpu.txt, and
# each reads BOTH on startup, so CPU and GPU never scan the same 2^25 segment
# twice. Combined throughput = CPU + GPU.
#
# Put the Go agent (ludkey-agent) and the CUDA agent (ludkey_cuda) in this folder.
# Build CUDA first: (cd packages/agent-cuda && make SM=75)  — needs an NVIDIA GPU.
set -euo pipefail
cd "$(dirname "$0")"

CPU_BIN="./ludkey-agent"
[ -x "$CPU_BIN" ] || CPU_BIN="./ludkey-agent-macos-arm64"
[ -x "$CPU_BIN" ] || CPU_BIN="./ludkey-agent-macos-intel"

pids=()
if [ -x "$CPU_BIN" ]; then echo "Starting CPU (Go) agent: $CPU_BIN"; "$CPU_BIN" -standalone & pids+=($!); else echo "[!] Go CPU agent not found"; fi
if [ -x ./ludkey_cuda ]; then echo "Starting GPU (CUDA) agent"; ./ludkey_cuda --standalone & pids+=($!); else echo "[!] ludkey_cuda not found — build it in packages/agent-cuda"; fi

[ ${#pids[@]} -gt 0 ] || { echo "No agents to run."; exit 1; }
echo "Running CPU+GPU with shared progress. Ctrl-C to stop both."
trap 'kill ${pids[*]} 2>/dev/null || true' INT TERM
wait
