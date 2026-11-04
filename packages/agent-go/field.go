// Fast secp256k1 field arithmetic on fixed uint64[4] limbs (no heap allocation).
// Prime p = 2^256 - 2^32 - 977. Limbs are little-endian (fe[0] least significant).
// This replaces the big.Int math in the hot path; correctness is fuzz-checked
// against big.Int in field_test.go.

package main

import "math/bits"

type fe [4]uint64

const kFold = 0x1000003D1 // 2^256 mod p = 2^32 + 977

// p itself, for comparisons/normalisation.
var pfe = fe{0xFFFFFFFEFFFFFC2F, 0xFFFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF}

// madd returns hi,lo = a*b + c + cin (no overflow: hi stays < 2^64).
func madd(a, b, c, cin uint64) (hi, lo uint64) {
	hi, lo = bits.Mul64(a, b)
	var carry uint64
	lo, carry = bits.Add64(lo, c, 0)
	hi += carry
	lo, carry = bits.Add64(lo, cin, 0)
	hi += carry
	return
}

func (a fe) isZero() bool { return a[0]|a[1]|a[2]|a[3] == 0 }
func (a fe) eq(b fe) bool { return a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3] }

// gte reports whether a >= b.
func (a fe) gte(b fe) bool {
	for i := 3; i >= 0; i-- {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return true
}

// normalize: subtract p while a >= p (at most twice after a reduction).
func (a *fe) normalize() {
	for i := 0; i < 2; i++ {
		if !a.gte(pfe) {
			return
		}
		var brw uint64
		a[0], brw = bits.Sub64(a[0], pfe[0], 0)
		a[1], brw = bits.Sub64(a[1], pfe[1], brw)
		a[2], brw = bits.Sub64(a[2], pfe[2], brw)
		a[3], _ = bits.Sub64(a[3], pfe[3], brw)
	}
}

func feAdd(a, b fe) fe {
	var r fe
	var c uint64
	r[0], c = bits.Add64(a[0], b[0], 0)
	r[1], c = bits.Add64(a[1], b[1], c)
	r[2], c = bits.Add64(a[2], b[2], c)
	r[3], c = bits.Add64(a[3], b[3], c)
	// c (bit 256) ≡ kFold mod p; fold it back
	if c != 0 {
		var c2 uint64
		r[0], c2 = bits.Add64(r[0], kFold, 0)
		r[1], c2 = bits.Add64(r[1], 0, c2)
		r[2], c2 = bits.Add64(r[2], 0, c2)
		r[3], c2 = bits.Add64(r[3], 0, c2)
		if c2 != 0 { // extremely rare
			r[0], c2 = bits.Add64(r[0], kFold, 0)
			r[1], c2 = bits.Add64(r[1], 0, c2)
			r[2], c2 = bits.Add64(r[2], 0, c2)
			r[3], _ = bits.Add64(r[3], 0, c2)
		}
	}
	r.normalize()
	return r
}

func feSub(a, b fe) fe {
	var r fe
	var brw uint64
	r[0], brw = bits.Sub64(a[0], b[0], 0)
	r[1], brw = bits.Sub64(a[1], b[1], brw)
	r[2], brw = bits.Sub64(a[2], b[2], brw)
	r[3], brw = bits.Sub64(a[3], b[3], brw)
	// if borrow, add p (≡ subtract kFold worth); add p back
	if brw != 0 {
		var c uint64
		r[0], c = bits.Add64(r[0], pfe[0], 0)
		r[1], c = bits.Add64(r[1], pfe[1], c)
		r[2], c = bits.Add64(r[2], pfe[2], c)
		r[3], _ = bits.Add64(r[3], pfe[3], c)
	}
	return r
}

func reduceWide(r *[8]uint64) fe {
	// t = r_low + r_high*kFold  (5 limbs)
	var t [5]uint64
	var carry uint64
	for i := 0; i < 4; i++ {
		hi, lo := bits.Mul64(r[4+i], kFold)
		var c uint64
		t[i], c = bits.Add64(lo, carry, 0)
		carry = hi + c
	}
	t[4] = carry
	var c uint64
	t[0], c = bits.Add64(t[0], r[0], 0)
	t[1], c = bits.Add64(t[1], r[1], c)
	t[2], c = bits.Add64(t[2], r[2], c)
	t[3], c = bits.Add64(t[3], r[3], c)
	t[4] += c
	// fold t[4]*kFold into t[0..3]
	var out fe
	hi, lo := bits.Mul64(t[4], kFold)
	out[0], c = bits.Add64(t[0], lo, 0)
	out[1], c = bits.Add64(t[1], hi, c)
	out[2], c = bits.Add64(t[2], 0, c)
	out[3], c = bits.Add64(t[3], 0, c)
	for c != 0 { // absorb any final carry (rare; loops at most twice)
		out[0], c = bits.Add64(out[0], kFold, 0)
		out[1], c = bits.Add64(out[1], 0, c)
		out[2], c = bits.Add64(out[2], 0, c)
		out[3], c = bits.Add64(out[3], 0, c)
	}
	out.normalize()
	return out
}

func feMul(a, b fe) fe {
	var r [8]uint64
	for i := 0; i < 4; i++ {
		var carry uint64
		for j := 0; j < 4; j++ {
			var hi uint64
			hi, r[i+j] = madd(a[i], b[j], r[i+j], carry)
			carry = hi
		}
		r[i+4] = carry
	}
	return reduceWide(&r)
}

func feSqr(a fe) fe { return feMul(a, a) }

// feInv = a^(p-2) mod p via square-and-multiply (used rarely, in batch inversion).
func feInv(a fe) fe {
	// p-2 limbs (little-endian)
	pm2 := fe{0xFFFFFFFEFFFFFC2D, 0xFFFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF}
	result := fe{1, 0, 0, 0}
	base := a
	for limb := 0; limb < 4; limb++ {
		w := pm2[limb]
		for bit := 0; bit < 64; bit++ {
			if (w>>uint(bit))&1 == 1 {
				result = feMul(result, base)
			}
			base = feSqr(base)
		}
	}
	return result
}

// conversions (for tests and setup; not in the hot path)
func feFromBig(x *bigInt) fe {
	var f fe
	b := new(bigInt).Mod(x, pBig)
	words := b.Bits()
	_ = words
	// portable: pull 4 64-bit limbs
	tmp := new(bigInt).Set(b)
	mask := new(bigInt).SetUint64(^uint64(0))
	for i := 0; i < 4; i++ {
		f[i] = new(bigInt).And(tmp, mask).Uint64()
		tmp.Rsh(tmp, 64)
	}
	return f
}
func (a fe) toBig() *bigInt {
	r := new(bigInt)
	for i := 3; i >= 0; i-- {
		r.Lsh(r, 64)
		r.Or(r, new(bigInt).SetUint64(a[i]))
	}
	return r
}
