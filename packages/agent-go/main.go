// LudKey Hunter — native CPU agent (Go, no external dependencies).
//
// Double-click the .exe (or run it) and it joins your Cloudflare coordinator,
// leases non-overlapping 2^25 segments, searches them on every CPU core, and
// reports progress — exactly like the browser's Connected mode, but native and
// in the background (no tab throttling).
//
// HONEST NOTE: this is a CPU agent. secp256k1 in portable Go is far slower than
// an optimized GPU kernel, so expect on the order of ~1 Mkey/s per fast core,
// not the tens of millions a GPU solver reaches. It exists so you can run a
// native background worker that contributes to the shared search. The crypto is
// a direct port of the browser engine (verified against the puzzle test
// vectors at startup; it refuses to run if the self-test fails).
//
// Build (from this folder):
//   Windows .exe:  GOOS=windows GOARCH=amd64 go build -o ludkey-agent.exe .
//   this machine:  go build -o ludkey-agent .
//
// Run:
//   ludkey-agent.exe                         (defaults to the hosted coordinator)
//   ludkey-agent.exe -server https://...      (another coordinator)
//   ludkey-agent.exe -threads 8 -payout 1Your...Address

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---------------------------------------------------------------------------
// secp256k1 field + curve (big.Int), ported from the browser engine.
// ---------------------------------------------------------------------------
var (
	P, _  = new(big.Int).SetString("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f", 16)
	N, _  = new(big.Int).SetString("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)
	Gx, _ = new(big.Int).SetString("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", 16)
	Gy, _ = new(big.Int).SetString("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8", 16)

	three = big.NewInt(3)
	eight = big.NewInt(8)
	two   = big.NewInt(2)
)

func md(x *big.Int) *big.Int { // mod P into [0,P)
	r := new(big.Int).Mod(x, P)
	return r
}
func mul(a, b *big.Int) *big.Int { return md(new(big.Int).Mul(a, b)) }
func sub(a, b *big.Int) *big.Int { return md(new(big.Int).Sub(a, b)) }
func add(a, b *big.Int) *big.Int { return md(new(big.Int).Add(a, b)) }
func inv(a *big.Int) *big.Int    { return new(big.Int).ModInverse(a, P) }

type Pt struct{ X, Y *big.Int }  // affine
type Jac struct{ X, Y, Z *big.Int }

func jInf() Jac { return Jac{big.NewInt(1), big.NewInt(1), big.NewInt(0)} }

func jDouble(p Jac) Jac {
	if p.Z.Sign() == 0 || p.Y.Sign() == 0 {
		return jInf()
	}
	A := mul(p.X, p.X)
	B := mul(p.Y, p.Y)
	C := mul(B, B)
	t := sub(mul(add(p.X, B), add(p.X, B)), A)
	t = sub(t, C)
	D := md(new(big.Int).Mul(two, t))
	E := mul(three, A)
	F := mul(E, E)
	X3 := sub(F, md(new(big.Int).Mul(two, D)))
	Y3 := sub(mul(E, sub(D, X3)), mul(eight, C))
	Z3 := md(new(big.Int).Mul(two, mul(p.Y, p.Z)))
	return Jac{X3, Y3, Z3}
}

func jAdd(p, q Jac) Jac {
	if p.Z.Sign() == 0 {
		return q
	}
	if q.Z.Sign() == 0 {
		return p
	}
	Z1 := mul(p.Z, p.Z)
	Z2 := mul(q.Z, q.Z)
	U1 := mul(p.X, Z2)
	U2 := mul(q.X, Z1)
	S1 := mul(mul(p.Y, q.Z), Z2)
	S2 := mul(mul(q.Y, p.Z), Z1)
	if U1.Cmp(U2) == 0 {
		if S1.Cmp(S2) != 0 {
			return jInf()
		}
		return jDouble(p)
	}
	H := sub(U2, U1)
	I := mul(md(new(big.Int).Mul(two, H)), md(new(big.Int).Mul(two, H)))
	J := mul(H, I)
	r := md(new(big.Int).Mul(two, sub(S2, S1)))
	V := mul(U1, I)
	X3 := sub(sub(mul(r, r), J), md(new(big.Int).Mul(two, V)))
	Y3 := sub(mul(r, sub(V, X3)), md(new(big.Int).Mul(two, mul(S1, J))))
	Z3 := mul(sub(sub(mul(add(p.Z, q.Z), add(p.Z, q.Z)), Z1), Z2), H)
	return Jac{X3, Y3, Z3}
}

func toAffine(p Jac) Pt {
	zi := inv(p.Z)
	zi2 := mul(zi, zi)
	zi3 := mul(zi2, zi)
	return Pt{mul(p.X, zi2), mul(p.Y, zi3)}
}

func scalarMulG(k *big.Int) Pt {
	kk := new(big.Int).Mod(k, N)
	acc := jInf()
	addp := Jac{new(big.Int).Set(Gx), new(big.Int).Set(Gy), big.NewInt(1)}
	for kk.Sign() > 0 {
		if kk.Bit(0) == 1 {
			acc = jAdd(acc, addp)
		}
		addp = jDouble(addp)
		kk.Rsh(kk, 1)
	}
	return toAffine(acc)
}

func affineAdd(a, b Pt) Pt {
	dx := sub(b.X, a.X)
	if dx.Sign() == 0 {
		return affineDouble(a)
	}
	s := mul(sub(b.Y, a.Y), inv(dx))
	x := sub(sub(mul(s, s), a.X), b.X)
	y := sub(mul(s, sub(a.X, x)), a.Y)
	return Pt{x, y}
}
func affineDouble(a Pt) Pt {
	s := mul(mul(three, mul(a.X, a.X)), inv(md(new(big.Int).Mul(two, a.Y))))
	x := sub(mul(s, s), md(new(big.Int).Mul(two, a.X)))
	y := sub(mul(s, sub(a.X, x)), a.Y)
	return Pt{x, y}
}

// batch modular inverse of many values (one real inversion for all).
func batchModInv(vals []*big.Int) []*big.Int {
	n := len(vals)
	out := make([]*big.Int, n)
	pre := make([]*big.Int, n)
	acc := big.NewInt(1)
	for i := 0; i < n; i++ {
		pre[i] = new(big.Int).Set(acc)
		acc = mul(acc, vals[i])
	}
	invAcc := inv(acc)
	for i := n - 1; i >= 0; i-- {
		out[i] = mul(pre[i], invAcc)
		invAcc = mul(invAcc, vals[i])
	}
	return out
}

// base + deltas[i] for all i, using one batch inversion.
func batchAddDeltas(base Pt, deltas []Pt) []Pt {
	m := len(deltas)
	dxs := make([]*big.Int, m)
	for i := 0; i < m; i++ {
		dx := sub(deltas[i].X, base.X)
		if dx.Sign() == 0 {
			dx = big.NewInt(1)
		}
		dxs[i] = dx
	}
	invs := batchModInv(dxs)
	out := make([]Pt, m)
	for i := 0; i < m; i++ {
		d := deltas[i]
		if sub(d.X, base.X).Sign() == 0 {
			out[i] = affineAdd(base, d)
			continue
		}
		s := mul(sub(d.Y, base.Y), invs[i])
		x := sub(sub(mul(s, s), base.X), d.X)
		y := sub(mul(s, sub(base.X, x)), base.Y)
		out[i] = Pt{x, y}
	}
	return out
}

// precompute [1*G, 2*G, ..., count*G]
func precompute(count int) []Pt {
	out := make([]Pt, count)
	out[0] = Pt{new(big.Int).Set(Gx), new(big.Int).Set(Gy)}
	G := Pt{new(big.Int).Set(Gx), new(big.Int).Set(Gy)}
	for i := 1; i < count; i++ {
		out[i] = affineAdd(out[i-1], G)
	}
	return out
}

// ---------------------------------------------------------------------------
// hash160 = RIPEMD160(SHA256(compressed pubkey))
// ---------------------------------------------------------------------------
func compressed(pt Pt) []byte {
	o := make([]byte, 33)
	if pt.Y.Bit(0) == 0 {
		o[0] = 2
	} else {
		o[0] = 3
	}
	xb := pt.X.Bytes()
	copy(o[1+(32-len(xb)):], xb)
	return o
}

func hash160(pub []byte) [20]byte {
	sh := sha256.Sum256(pub)
	return ripemd160(sh[:])
}

// ---- RIPEMD-160 (ported) ----
var (
	rmdZL = []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13}
	rmdZR = []int{5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11}
	rmdSL = []uint{11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6}
	rmdSR = []uint{8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11}
	rmdKL = []uint32{0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e}
	rmdKR = []uint32{0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000}
)

func rol(x uint32, n uint) uint32 { return (x << n) | (x >> (32 - n)) }
func rmdF(j int, x, y, z uint32) uint32 {
	switch {
	case j < 16:
		return x ^ y ^ z
	case j < 32:
		return (x & y) | (^x & z)
	case j < 48:
		return (x | ^y) ^ z
	case j < 64:
		return (x & z) | (y & ^z)
	default:
		return x ^ (y | ^z)
	}
}

func ripemd160(msg []byte) [20]byte {
	l := len(msg)
	wo := l + 1
	k := (56-(wo%64)+64)%64
	total := wo + k + 8
	b := make([]byte, total)
	copy(b, msg)
	b[l] = 0x80
	bl := uint64(l) * 8
	b[total-8] = byte(bl)
	b[total-7] = byte(bl >> 8)
	b[total-6] = byte(bl >> 16)
	b[total-5] = byte(bl >> 24)
	b[total-4] = byte(bl >> 32)
	b[total-3] = byte(bl >> 40)
	b[total-2] = byte(bl >> 48)
	b[total-1] = byte(bl >> 56)
	h0, h1, h2, h3, h4 := uint32(0x67452301), uint32(0xefcdab89), uint32(0x98badcfe), uint32(0x10325476), uint32(0xc3d2e1f0)
	var X [16]uint32
	for off := 0; off < total; off += 64 {
		for i := 0; i < 16; i++ {
			j := off + i*4
			X[i] = uint32(b[j]) | uint32(b[j+1])<<8 | uint32(b[j+2])<<16 | uint32(b[j+3])<<24
		}
		al, bl2, cl, dl, el := h0, h1, h2, h3, h4
		ar, br, cr, dr, er := h0, h1, h2, h3, h4
		for j := 0; j < 80; j++ {
			rnd := j / 16
			t := rol(al+rmdF(j, bl2, cl, dl)+X[rmdZL[j]]+rmdKL[rnd], rmdSL[j]) + el
			al = el
			el = dl
			dl = rol(cl, 10)
			cl = bl2
			bl2 = t
			t = rol(ar+rmdF(79-j, br, cr, dr)+X[rmdZR[j]]+rmdKR[rnd], rmdSR[j]) + er
			ar = er
			er = dr
			dr = rol(cr, 10)
			cr = br
			br = t
		}
		t := h1 + cl + dr
		h1 = h2 + dl + er
		h2 = h3 + el + ar
		h3 = h4 + al + br
		h4 = h0 + bl2 + cr
		h0 = t
	}
	var o [20]byte
	hs := []uint32{h0, h1, h2, h3, h4}
	for i := 0; i < 5; i++ {
		o[i*4] = byte(hs[i])
		o[i*4+1] = byte(hs[i] >> 8)
		o[i*4+2] = byte(hs[i] >> 16)
		o[i*4+3] = byte(hs[i] >> 24)
	}
	return o
}

// ---- Base58Check / WIF (for printing a found key) ----
const b58alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

func base58check(payload []byte) string {
	c1 := sha256.Sum256(payload)
	c2 := sha256.Sum256(c1[:])
	full := append(append([]byte{}, payload...), c2[:4]...)
	n := new(big.Int).SetBytes(full)
	zero := big.NewInt(0)
	b58 := big.NewInt(58)
	var sb strings.Builder
	for n.Cmp(zero) > 0 {
		m := new(big.Int)
		n.DivMod(n, b58, m)
		sb.WriteByte(b58alpha[m.Int64()])
	}
	for _, bb := range full {
		if bb == 0 {
			sb.WriteByte('1')
		} else {
			break
		}
	}
	r := []byte(sb.String())
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}
func wifCompressed(key *big.Int) string {
	kb := key.Bytes()
	buf := make([]byte, 34)
	buf[0] = 0x80
	copy(buf[1+(32-len(kb)):33], kb)
	buf[33] = 0x01
	return base58check(buf)
}
func addrFromH160(h [20]byte) string {
	return base58check(append([]byte{0x00}, h[:]...))
}

// ---------------------------------------------------------------------------
// Coordinator HTTP client
// ---------------------------------------------------------------------------
type Coord struct {
	base   string
	token  string
	client *http.Client
}

func (c *Coord) post(path string, body any, auth bool, out any) error {
	var r io.Reader
	if body != nil {
		bs, _ := json.Marshal(body)
		r = bytes.NewReader(bs)
	}
	var lastErr error
	for try := 0; try < 4; try++ {
		req, _ := http.NewRequest("POST", c.base+path, r)
		req.Header.Set("content-type", "application/json")
		if auth && c.token != "" {
			req.Header.Set("authorization", "Bearer "+c.token)
		}
		resp, err := c.client.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(300*(try+1)) * time.Millisecond)
			if body != nil {
				bs, _ := json.Marshal(body)
				r = bytes.NewReader(bs)
			}
			continue
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			lastErr = fmt.Errorf("%s -> %d", path, resp.StatusCode)
			time.Sleep(time.Duration(300*(try+1)) * time.Millisecond)
			if body != nil {
				bs, _ := json.Marshal(body)
				r = bytes.NewReader(bs)
			}
			continue
		}
		if out != nil {
			return json.Unmarshal(data, out)
		}
		return nil
	}
	return lastErr
}

func (c *Coord) getJSON(path string, out any) error {
	resp, err := c.client.Get(c.base + path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return json.Unmarshal(data, out)
}

// ---------------------------------------------------------------------------
// Search one segment [start,end] with the batch-stepping engine.
// Returns (foundKey, found) — foundKey is the private key when hit.
// ---------------------------------------------------------------------------
type scanState struct {
	target  [20]byte
	table   []Pt
	window  int
	scanned *uint64 // shared counter
	stop    *atomic.Bool
}

func scanSegment(start, end *big.Int, st *scanState) (*big.Int, [20]byte, bool) {
	cursor := new(big.Int).Set(start)
	one := big.NewInt(1)
	var base Pt
	haveBase := false
	for cursor.Cmp(end) <= 0 {
		if st.stop.Load() {
			return nil, [20]byte{}, false
		}
		if !haveBase {
			base = scalarMulG(cursor)
			haveBase = true
		}
		remaining := new(big.Int).Sub(end, cursor)
		remaining.Add(remaining, one)
		n := st.window
		if remaining.Cmp(big.NewInt(int64(st.window))) < 0 {
			n = int(remaining.Int64())
		}
		// check base (cursor)
		if h := hash160(compressed(base)); h == st.target {
			return new(big.Int).Set(cursor), h, true
		}
		if n > 1 {
			pts := batchAddDeltas(base, st.table[:n-1])
			for i := 0; i < len(pts); i++ {
				if h := hash160(compressed(pts[i])); h == st.target {
					k := new(big.Int).Add(cursor, big.NewInt(int64(i+1)))
					return k, h, true
				}
			}
			base = affineAdd(base, st.table[n-1])
		} else {
			haveBase = false
		}
		cursor.Add(cursor, big.NewInt(int64(n)))
		atomic.AddUint64(st.scanned, uint64(n))
	}
	return nil, [20]byte{}, false
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
func selfTest() bool {
	// (key, hash160 of compressed pubkey) pairs, verified against the browser engine.
	k1 := hash160(compressed(scalarMulG(big.NewInt(1))))
	want1, _ := hex.DecodeString("751e76e8199196d454941c45d1b3a323f1433bd6")
	k21 := hash160(compressed(scalarMulG(big.NewInt(0x15))))
	want21, _ := hex.DecodeString("8f9dff39a81ee4abcbad2ad8bafff090415a2be8")
	k514 := hash160(compressed(scalarMulG(big.NewInt(0x202))))
	want514, _ := hex.DecodeString("d7729816650e581d7462d52ad6f732da0e2ec93b")
	return bytes.Equal(k1[:], want1) && bytes.Equal(k21[:], want21) && bytes.Equal(k514[:], want514)
}

func main() {
	server := flag.String("server", "https://ludkey-hunter.8jt6mh8rz9.workers.dev", "coordinator URL")
	threads := flag.Int("threads", runtime.NumCPU(), "worker threads (1 segment each)")
	window := flag.Int("window", 1024, "batch window size")
	payout := flag.String("payout", "", "your payout address (shown with a found key)")
	flag.Parse()

	fmt.Printf("LudKey Hunter native agent — %d threads\n", *threads)
	fmt.Println("Running crypto self-test...")
	if !selfTest() {
		fmt.Println("SELF-TEST FAILED — refusing to run (would produce wrong results).")
		os.Exit(2)
	}
	fmt.Println("Self-test PASSED (matches the puzzle test vectors).")

	base := strings.TrimRight(*server, "/")
	coord := &Coord{base: base, client: &http.Client{Timeout: 30 * time.Second}}

	// info (target hash160)
	var info struct {
		Puzzle  int    `json:"puzzle"`
		Hash160 string `json:"hash160"`
		Address string `json:"address"`
	}
	if err := coord.getJSON("/api/info", &info); err != nil {
		fmt.Println("Could not reach coordinator /api/info:", err)
		os.Exit(1)
	}
	targetBytes, _ := hex.DecodeString(info.Hash160)
	var target [20]byte
	copy(target[:], targetBytes)
	fmt.Printf("Coordinator OK — puzzle #%d, target %s (%s)\n", info.Puzzle, info.Hash160, info.Address)

	// register
	var reg struct {
		DeviceID string `json:"deviceId"`
		Token    string `json:"token"`
	}
	host, _ := os.Hostname()
	if err := coord.post("/api/register", map[string]string{"name": "native-" + host, "type": "native-cpu"}, false, &reg); err != nil {
		fmt.Println("Register failed:", err)
		os.Exit(1)
	}
	coord.token = reg.Token
	fmt.Printf("Registered as %s — starting search on %d cores\n\n", reg.DeviceID, *threads)

	table := precompute(*window)
	var scanned uint64
	var stop atomic.Bool
	var wg sync.WaitGroup

	// heartbeat + speed printer
	go func() {
		var last uint64
		lastT := time.Now()
		for !stop.Load() {
			time.Sleep(4 * time.Second)
			cur := atomic.LoadUint64(&scanned)
			dt := time.Since(lastT).Seconds()
			spd := float64(cur-last) / dt
			last, lastT = cur, time.Now()
			coord.post("/api/heartbeat", map[string]any{"speed": int(spd), "scanned": fmt.Sprintf("%d", cur)}, true, nil)
			fmt.Printf("\r[%s] total %s keys  ·  %s      ",
				time.Now().Format("15:04:05"), human(cur), speed(spd))
		}
	}()

	for t := 0; t < *threads; t++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			st := &scanState{target: target, table: table, window: *window, scanned: &scanned, stop: &stop}
			for !stop.Load() {
				var lease struct {
					Chunk *struct {
						Index string `json:"index"`
						Start string `json:"start"`
						End   string `json:"end"`
					} `json:"chunk"`
				}
				if err := coord.post("/api/lease", map[string]any{}, true, &lease); err != nil {
					fmt.Printf("\n[worker %d] coordinator unreachable: %v\n", id, err)
					time.Sleep(3 * time.Second)
					continue
				}
				if lease.Chunk == nil {
					fmt.Printf("\n[worker %d] no more work from coordinator\n", id)
					return
				}
				start := hexToBig(lease.Chunk.Start)
				end := hexToBig(lease.Chunk.End)
				// renew this segment's lease periodically
				stopRenew := make(chan struct{})
				go func(idx string) {
					for {
						select {
						case <-stopRenew:
							return
						case <-time.After(60 * time.Second):
							coord.post("/api/heartbeat", map[string]any{"chunkIndex": idx}, true, nil)
						}
					}
				}(lease.Chunk.Index)

				key, h, found := scanSegment(start, end, st)
				close(stopRenew)
				if found {
					addr := addrFromH160(h)
					wif := wifCompressed(key)
					fmt.Printf("\n\n*** MATCH *** key=0x%x\n  WIF (import this): %s\n  address: %s\n", key, wif, addr)
					if *payout != "" {
						fmt.Printf("  payout target: %s (sweep with the CLI --payout; this agent does not broadcast)\n", *payout)
					}
					coord.post("/api/match", map[string]string{"key": "0x" + key.Text(16), "hash160": hex.EncodeToString(h[:]), "address": addr}, true, nil)
					saveFound(key, wif, addr)
					stop.Store(true)
					return
				}
				coord.post("/api/complete", map[string]any{"chunkIndex": lease.Chunk.Index}, true, nil)
			}
		}(t)
	}

	wg.Wait()
	stop.Store(true)
	fmt.Println("\nStopped.")
}

func hexToBig(s string) *big.Int {
	s = strings.TrimPrefix(s, "0x")
	n, _ := new(big.Int).SetString(s, 16)
	return n
}
func human(n uint64) string {
	f := float64(n)
	switch {
	case f >= 1e12:
		return fmt.Sprintf("%.2fT", f/1e12)
	case f >= 1e9:
		return fmt.Sprintf("%.2fB", f/1e9)
	case f >= 1e6:
		return fmt.Sprintf("%.2fM", f/1e6)
	case f >= 1e3:
		return fmt.Sprintf("%.2fK", f/1e3)
	}
	return fmt.Sprintf("%.0f", f)
}
func speed(s float64) string {
	switch {
	case s >= 1e6:
		return fmt.Sprintf("%.2f Mkey/s", s/1e6)
	case s >= 1e3:
		return fmt.Sprintf("%.2f Kkey/s", s/1e3)
	}
	return fmt.Sprintf("%.0f key/s", s)
}
func saveFound(key *big.Int, wif, addr string) {
	f, err := os.Create("FOUND_KEY.txt")
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "when: %s\nprivate key (hex): 0x%x\nWIF (compressed): %s\naddress: %s\n", time.Now().Format(time.RFC3339), key, wif, addr)
}
