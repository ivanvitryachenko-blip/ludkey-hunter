# LudKey Hunter — native CPU agent (Go)

A dependency-free native agent that joins your Cloudflare coordinator, leases
non-overlapping 2²⁵ segments, and searches them on every CPU core — like the
browser's Connected mode, but native and in the background.

The crypto (secp256k1 + SHA-256 + RIPEMD-160, batch-inversion stepping) is a
port of the browser engine and is checked against the puzzle test vectors at
startup; the agent refuses to run if the self-test fails.

## Build

```bash
# Windows .exe (from any OS):
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w" -o ludkey-agent.exe .
# this machine:
go build -o ludkey-agent .
```

## Run

```bash
./ludkey-agent                       # defaults to the hosted coordinator
./ludkey-agent -server https://...   # another coordinator
./ludkey-agent -threads 8 -payout 1YourAddress
```

A found key is written to `FOUND_KEY.txt` (private key + WIF) and reported to
the coordinator (which stores it privately, never serving it).

## Speed

This version uses Go `math/big` → ~0.16 Mkey/s per core (similar to the
browser). A uint64-limb field-arithmetic rewrite (no allocations) is the path
to several Mkey/s per core.
