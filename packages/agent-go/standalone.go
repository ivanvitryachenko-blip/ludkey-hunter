// Standalone mode: search WITHOUT a coordinator. Each worker picks a random
// 2^25 segment of the #72 range locally and searches it. With 2^46 segments and
// only a few devices, two devices picking the same segment is astronomically
// unlikely, so no coordination is needed. This makes the agent work even when
// the coordinator's host is blocked by an ISP — it falls back automatically.

package main

import (
	"crypto/rand"
	"encoding/hex"
	"math/big"
	"sync/atomic"
)

var goStandalone atomic.Bool // set when the coordinator is unreachable

var (
	saStart      = new(big.Int).Lsh(big.NewInt(1), 71) // 2^71 (#72 range start)
	saChunkSize  = new(big.Int).Lsh(big.NewInt(1), 25) // 2^25 keys per segment
	saChunkCount = new(big.Int).Lsh(big.NewInt(1), 46) // 2^71 / 2^25
)

// #72 target hash160, used when /api/info can't be reached.
var fallbackTarget = func() [20]byte {
	b, _ := hex.DecodeString("bf7413e8df4e7a34ce9dc13e2f2648783ec54adb")
	var t [20]byte
	copy(t[:], b)
	return t
}()

// randSegment returns a random 2^25 segment [start,end] in the #72 range.
func randSegment() (*big.Int, *big.Int) {
	idx, _ := rand.Int(rand.Reader, saChunkCount)
	start := new(big.Int).Add(saStart, new(big.Int).Mul(idx, saChunkSize))
	end := new(big.Int).Sub(new(big.Int).Add(start, saChunkSize), big.NewInt(1))
	return start, end
}
