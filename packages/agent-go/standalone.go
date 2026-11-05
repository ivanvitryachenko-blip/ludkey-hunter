// Standalone mode: search WITHOUT a coordinator. Each worker picks a random
// 2^25 segment of the #72 range locally and searches it. With 2^46 segments and
// only a few devices, two devices picking the same segment is astronomically
// unlikely, so no coordination is needed. This makes the agent work even when
// the coordinator's host is blocked by an ISP — it falls back automatically.

package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// segBounds returns [start,end] for a segment index.
func segBounds(idx *big.Int) (*big.Int, *big.Int) {
	start := new(big.Int).Add(saStart, new(big.Int).Mul(idx, saChunkSize))
	end := new(big.Int).Sub(new(big.Int).Add(start, saChunkSize), big.NewInt(1))
	return start, end
}

// segStore persists which standalone segments are already searched, so progress
// survives restarts and can be exported. The file is append-only: one segment
// index per line (plain text).
type segStore struct {
	mu       sync.Mutex
	done     map[string]struct{}
	inflight map[string]struct{}
	f        *os.File
	path     string
}

func newSegStore(path string) *segStore {
	s := &segStore{done: map[string]struct{}{}, inflight: map[string]struct{}{}, path: path}
	loadInto := func(p string) int {
		n := 0
		if f, err := os.Open(p); err == nil {
			sc := bufio.NewScanner(f)
			sc.Buffer(make([]byte, 1024*1024), 1024*1024)
			for sc.Scan() {
				if l := strings.TrimSpace(sc.Text()); l != "" {
					if _, ok := s.done[l]; !ok {
						s.done[l] = struct{}{}
						n++
					}
				}
			}
			f.Close()
		}
		return n
	}
	loadInto(path)
	// Also skip segments a sibling agent (e.g. the CUDA GPU agent) has already
	// completed: read every ludkey-progress*.txt next to this file, read-only, so
	// CPU and GPU running together never re-scan each other's segments.
	dir := filepath.Dir(path)
	if dir == "" {
		dir = "."
	}
	if matches, err := filepath.Glob(filepath.Join(dir, "ludkey-progress*.txt")); err == nil {
		for _, m := range matches {
			if m != path {
				loadInto(m)
			}
		}
	}
	s.f, _ = os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	return s
}

// pickRandom returns a random segment index not yet done and not in flight.
func (s *segStore) pickRandom() *big.Int {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := 0; i < 64; i++ {
		idx, _ := rand.Int(rand.Reader, saChunkCount)
		k := idx.String()
		if _, d := s.done[k]; d {
			continue
		}
		if _, f := s.inflight[k]; f {
			continue
		}
		s.inflight[k] = struct{}{}
		return idx
	}
	idx, _ := rand.Int(rand.Reader, saChunkCount) // fallback (space is vast; collision negligible)
	return idx
}

func (s *segStore) markDone(idx *big.Int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := idx.String()
	delete(s.inflight, k)
	if _, d := s.done[k]; !d {
		s.done[k] = struct{}{}
		if s.f != nil {
			s.f.WriteString(k + "\n")
			s.f.Sync()
		}
	}
}

func (s *segStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.done)
}
