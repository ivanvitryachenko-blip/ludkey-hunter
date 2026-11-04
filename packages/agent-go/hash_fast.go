// Allocation-free hash160 for the search hot path: compressed pubkey built on
// the stack, SHA-256 (stdlib, stack result), and a 32-byte-input RIPEMD-160
// that uses stack buffers (no make() per key). This removes the per-key heap
// allocations that otherwise thrash Go's GC across many cores.

package main

import (
	"crypto/sha256"
	"encoding/binary"
)

func hash160Fast(pt ptF) [20]byte {
	var pub [33]byte
	if pt.Y[0]&1 == 0 {
		pub[0] = 2
	} else {
		pub[0] = 3
	}
	binary.BigEndian.PutUint64(pub[1:], pt.X[3])
	binary.BigEndian.PutUint64(pub[9:], pt.X[2])
	binary.BigEndian.PutUint64(pub[17:], pt.X[1])
	binary.BigEndian.PutUint64(pub[25:], pt.X[0])
	sh := sha256.Sum256(pub[:])
	return ripemd160_32(&sh)
}

// RIPEMD-160 of exactly 32 bytes (one block), stack-only.
func ripemd160_32(msg *[32]byte) [20]byte {
	var b [64]byte
	copy(b[:], msg[:])
	b[32] = 0x80
	// length in bits = 256, little-endian, in the last 8 bytes
	binary.LittleEndian.PutUint64(b[56:], 256)

	h0, h1, h2, h3, h4 := uint32(0x67452301), uint32(0xefcdab89), uint32(0x98badcfe), uint32(0x10325476), uint32(0xc3d2e1f0)
	var X [16]uint32
	for i := 0; i < 16; i++ {
		X[i] = binary.LittleEndian.Uint32(b[i*4:])
	}
	al, bl, cl, dl, el := h0, h1, h2, h3, h4
	ar, br, cr, dr, er := h0, h1, h2, h3, h4
	for j := 0; j < 80; j++ {
		rnd := j / 16
		t := rol(al+rmdF(j, bl, cl, dl)+X[rmdZL[j]]+rmdKL[rnd], rmdSL[j]) + el
		al = el
		el = dl
		dl = rol(cl, 10)
		cl = bl
		bl = t
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
	h4 = h0 + bl + cr
	h0 = t
	var o [20]byte
	binary.LittleEndian.PutUint32(o[0:], h0)
	binary.LittleEndian.PutUint32(o[4:], h1)
	binary.LittleEndian.PutUint32(o[8:], h2)
	binary.LittleEndian.PutUint32(o[12:], h3)
	binary.LittleEndian.PutUint32(o[16:], h4)
	return o
}
