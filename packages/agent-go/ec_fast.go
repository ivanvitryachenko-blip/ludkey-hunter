// secp256k1 curve operations on the fast fe field (no heap allocation in the
// per-key hot path). Same Jacobian/affine formulas as the browser engine.

package main

import (
	"encoding/binary"
	"math/big"
)

type ptF struct{ X, Y fe }
type jacF struct{ X, Y, Z fe }

var (
	feOne   = fe{1, 0, 0, 0}
	feThree = fe{3, 0, 0, 0}
	feEight = fe{8, 0, 0, 0}
	Gxfe    = feFromBig(Gx)
	Gyfe    = feFromBig(Gy)
)

func jInfF() jacF { return jacF{feOne, feOne, fe{}} }

func jDoubleF(p jacF) jacF {
	if p.Z.isZero() || p.Y.isZero() {
		return jInfF()
	}
	A := feSqr(p.X)
	B := feSqr(p.Y)
	C := feSqr(B)
	t := feSub(feSqr(feAdd(p.X, B)), A)
	t = feSub(t, C)
	D := feAdd(t, t)
	E := feMul(feThree, A)
	F := feSqr(E)
	X3 := feSub(F, feAdd(D, D))
	Y3 := feSub(feMul(E, feSub(D, X3)), feMul(feEight, C))
	Z3 := feMul(feAdd(p.Y, p.Y), p.Z)
	return jacF{X3, Y3, Z3}
}

func jAddF(p, q jacF) jacF {
	if p.Z.isZero() {
		return q
	}
	if q.Z.isZero() {
		return p
	}
	Z1 := feSqr(p.Z)
	Z2 := feSqr(q.Z)
	U1 := feMul(p.X, Z2)
	U2 := feMul(q.X, Z1)
	S1 := feMul(feMul(p.Y, q.Z), Z2)
	S2 := feMul(feMul(q.Y, p.Z), Z1)
	if U1.eq(U2) {
		if !S1.eq(S2) {
			return jInfF()
		}
		return jDoubleF(p)
	}
	H := feSub(U2, U1)
	hh := feAdd(H, H)
	I := feMul(hh, hh)
	J := feMul(H, I)
	r := feAdd(feSub(S2, S1), feSub(S2, S1))
	V := feMul(U1, I)
	X3 := feSub(feSub(feSqr(r), J), feAdd(V, V))
	Y3 := feSub(feMul(r, feSub(V, X3)), feAdd(feMul(S1, J), feMul(S1, J)))
	zsum := feAdd(p.Z, q.Z)
	Z3 := feMul(feSub(feSub(feSqr(zsum), Z1), Z2), H)
	return jacF{X3, Y3, Z3}
}

func toAffineF(p jacF) ptF {
	zi := feInv(p.Z)
	zi2 := feSqr(zi)
	zi3 := feMul(zi2, zi)
	return ptF{feMul(p.X, zi2), feMul(p.Y, zi3)}
}

func scalarMulGF(k *big.Int) ptF {
	kk := new(big.Int).Mod(k, N)
	acc := jInfF()
	add := jacF{Gxfe, Gyfe, feOne}
	for kk.Sign() > 0 {
		if kk.Bit(0) == 1 {
			acc = jAddF(acc, add)
		}
		add = jDoubleF(add)
		kk.Rsh(kk, 1)
	}
	return toAffineF(acc)
}

func affineDoubleF(a ptF) ptF {
	s := feMul(feMul(feThree, feSqr(a.X)), feInv(feAdd(a.Y, a.Y)))
	x := feSub(feSqr(s), feAdd(a.X, a.X))
	y := feSub(feMul(s, feSub(a.X, x)), a.Y)
	return ptF{x, y}
}
func affineAddF(a, b ptF) ptF {
	dx := feSub(b.X, a.X)
	if dx.isZero() {
		return affineDoubleF(a)
	}
	s := feMul(feSub(b.Y, a.Y), feInv(dx))
	x := feSub(feSub(feSqr(s), a.X), b.X)
	y := feSub(feMul(s, feSub(a.X, x)), a.Y)
	return ptF{x, y}
}

func batchModInvF(vals []fe) []fe {
	n := len(vals)
	out := make([]fe, n)
	pre := make([]fe, n)
	acc := feOne
	for i := 0; i < n; i++ {
		pre[i] = acc
		acc = feMul(acc, vals[i])
	}
	inv := feInv(acc)
	for i := n - 1; i >= 0; i-- {
		out[i] = feMul(pre[i], inv)
		inv = feMul(inv, vals[i])
	}
	return out
}

// base + deltas[i] for all i, one batch inversion.
func batchAddDeltasF(base ptF, deltas []ptF) []ptF {
	m := len(deltas)
	dxs := make([]fe, m)
	for i := 0; i < m; i++ {
		dx := feSub(deltas[i].X, base.X)
		if dx.isZero() {
			dx = feOne
		}
		dxs[i] = dx
	}
	invs := batchModInvF(dxs)
	out := make([]ptF, m)
	for i := 0; i < m; i++ {
		d := deltas[i]
		if feSub(d.X, base.X).isZero() {
			out[i] = affineAddF(base, d)
			continue
		}
		s := feMul(feSub(d.Y, base.Y), invs[i])
		x := feSub(feSub(feSqr(s), base.X), d.X)
		y := feSub(feMul(s, feSub(base.X, x)), base.Y)
		out[i] = ptF{x, y}
	}
	return out
}

func precomputeF(count int) []ptF {
	out := make([]ptF, count)
	G := ptF{Gxfe, Gyfe}
	out[0] = G
	for i := 1; i < count; i++ {
		out[i] = affineAddF(out[i-1], G)
	}
	return out
}

// compressed pubkey (33 bytes): prefix + big-endian X.
func compressedF(pt ptF) []byte {
	o := make([]byte, 33)
	if pt.Y[0]&1 == 0 {
		o[0] = 2
	} else {
		o[0] = 3
	}
	binary.BigEndian.PutUint64(o[1:], pt.X[3])
	binary.BigEndian.PutUint64(o[9:], pt.X[2])
	binary.BigEndian.PutUint64(o[17:], pt.X[1])
	binary.BigEndian.PutUint64(o[25:], pt.X[0])
	return o
}
