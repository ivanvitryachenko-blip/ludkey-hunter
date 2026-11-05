// Auto-sweep: when a key is found, build/sign/broadcast a transaction that
// moves the puzzle address's funds to the user's payout address.
//
// The puzzle address is legacy P2PKH; the found key signs each input
// (ECDSA, RFC6979 deterministic nonce, low-S, SIGHASH_ALL). The output pays a
// native-segwit (bech32) payout address. UTXOs, fee and broadcast go through a
// public API (default mempool.space) from the machine running the agent.
//
// Safety: the fully-signed raw transaction is always printed and saved, so even
// if the broadcast call fails you can submit it by hand and still claim it.

package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// ---- bech32 (v0) decode -> witness program ----
const bech32Charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

func bech32Polymod(values []int) int {
	gen := []int{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	chk := 1
	for _, v := range values {
		b := chk >> 25
		chk = (chk&0x1ffffff)<<5 ^ v
		for i := 0; i < 5; i++ {
			if (b>>uint(i))&1 == 1 {
				chk ^= gen[i]
			}
		}
	}
	return chk
}
func bech32HrpExpand(hrp string) []int {
	var r []int
	for _, c := range hrp {
		r = append(r, int(c)>>5)
	}
	r = append(r, 0)
	for _, c := range hrp {
		r = append(r, int(c)&31)
	}
	return r
}

// decodeBech32P2 returns (witnessVersion, program) for a bc1 address.
func decodeBech32P2(addr string) (int, []byte, error) {
	addr = strings.ToLower(addr)
	pos := strings.LastIndex(addr, "1")
	if pos < 1 {
		return 0, nil, fmt.Errorf("not bech32")
	}
	hrp := addr[:pos]
	if hrp != "bc" {
		return 0, nil, fmt.Errorf("not a mainnet (bc) address")
	}
	dataPart := addr[pos+1:]
	var data []int
	for _, c := range dataPart {
		idx := strings.IndexRune(bech32Charset, c)
		if idx < 0 {
			return 0, nil, fmt.Errorf("bad bech32 char")
		}
		data = append(data, idx)
	}
	if len(data) < 7 {
		return 0, nil, fmt.Errorf("too short")
	}
	ver := data[0]
	// checksum const: 1 for bech32 (v0), 0x2bc830a3 for bech32m (v1+)
	want := 1
	if ver != 0 {
		want = 0x2bc830a3
	}
	if bech32Polymod(append(bech32HrpExpand(hrp), data...)) != want {
		return 0, nil, fmt.Errorf("bad checksum")
	}
	// convert the 5-bit groups (excluding version and 6 checksum) to 8-bit
	prog, err := convertBits(data[1:len(data)-6], 5, 8, false)
	if err != nil {
		return 0, nil, err
	}
	return ver, prog, nil
}
func convertBits(data []int, from, to uint, pad bool) ([]byte, error) {
	acc := 0
	bits := uint(0)
	var ret []byte
	maxv := (1 << to) - 1
	for _, v := range data {
		acc = (acc << from) | v
		bits += from
		for bits >= to {
			bits -= to
			ret = append(ret, byte((acc>>bits)&maxv))
		}
	}
	if pad && bits > 0 {
		ret = append(ret, byte((acc<<(to-bits))&maxv))
	} else if bits >= from || ((acc<<(to-bits))&maxv) != 0 {
		return nil, fmt.Errorf("invalid padding")
	}
	return ret, nil
}

// scriptPubKey for a v0 segwit program: OP_0 <push len> <program>
func segwitScript(ver int, prog []byte) []byte {
	op := byte(0x00)
	if ver > 0 {
		op = byte(0x50 + ver)
	}
	return append([]byte{op, byte(len(prog))}, prog...)
}

// ---- ECDSA (secp256k1) sign with RFC6979 ----
func int2octets(x *big.Int, rolen int) []byte {
	b := x.Bytes()
	if len(b) < rolen {
		b = append(make([]byte, rolen-len(b)), b...)
	}
	return b[len(b)-rolen:]
}
func bits2int(b []byte, qlen int) *big.Int {
	v := new(big.Int).SetBytes(b)
	if len(b)*8 > qlen {
		v.Rsh(v, uint(len(b)*8-qlen))
	}
	return v
}
func bits2octets(b []byte, rolen int) []byte {
	z1 := bits2int(b, N.BitLen())
	z2 := new(big.Int).Sub(z1, N)
	if z2.Sign() < 0 {
		z2 = z1
	}
	return int2octets(z2, rolen)
}
func hmacSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}
func rfc6979k(d, z *big.Int) *big.Int {
	qlen := N.BitLen()
	rolen := (qlen + 7) / 8
	bx := append(int2octets(d, rolen), bits2octets(int2octetsHash(z), rolen)...)
	v := bytes.Repeat([]byte{0x01}, 32)
	k := bytes.Repeat([]byte{0x00}, 32)
	k = hmacSHA256(k, append(append(append(append([]byte{}, v...), 0x00), bx...)))
	v = hmacSHA256(k, v)
	k = hmacSHA256(k, append(append(append(append([]byte{}, v...), 0x01), bx...)))
	v = hmacSHA256(k, v)
	for {
		v = hmacSHA256(k, v)
		cand := bits2int(v, qlen)
		if cand.Sign() > 0 && cand.Cmp(N) < 0 {
			return cand
		}
		k = hmacSHA256(k, append(append([]byte{}, v...), 0x00))
		v = hmacSHA256(k, v)
	}
}

// int2octetsHash renders z (the hash as int) to 32 bytes for bits2octets.
func int2octetsHash(z *big.Int) []byte { return int2octets(z, 32) }

func ecdsaSign(hash32 []byte, d *big.Int) (r, s *big.Int) {
	z := bits2int(hash32, N.BitLen())
	k := rfc6979k(d, z)
	R := scalarMulGF(k)
	r = new(big.Int).Mod(R.X.toBig(), N)
	kinv := new(big.Int).ModInverse(k, N)
	s = new(big.Int).Mul(r, d)
	s.Add(s, z)
	s.Mul(s, kinv)
	s.Mod(s, N)
	half := new(big.Int).Rsh(N, 1)
	if s.Cmp(half) > 0 {
		s.Sub(N, s)
	}
	return
}
func derSig(r, s *big.Int) []byte {
	enc := func(x *big.Int) []byte {
		b := x.Bytes()
		if len(b) == 0 {
			b = []byte{0}
		}
		if b[0]&0x80 != 0 {
			b = append([]byte{0}, b...)
		}
		return b
	}
	rb, sb := enc(r), enc(s)
	body := append(append([]byte{0x02, byte(len(rb))}, rb...), append([]byte{0x02, byte(len(sb))}, sb...)...)
	return append([]byte{0x30, byte(len(body))}, body...)
}

// ---- tx serialization helpers ----
func putVarint(buf *bytes.Buffer, n uint64) {
	switch {
	case n < 0xfd:
		buf.WriteByte(byte(n))
	case n <= 0xffff:
		buf.WriteByte(0xfd)
		binary.Write(buf, binary.LittleEndian, uint16(n))
	case n <= 0xffffffff:
		buf.WriteByte(0xfe)
		binary.Write(buf, binary.LittleEndian, uint32(n))
	default:
		buf.WriteByte(0xff)
		binary.Write(buf, binary.LittleEndian, n)
	}
}
func reverse(b []byte) []byte {
	r := make([]byte, len(b))
	for i := range b {
		r[len(b)-1-i] = b[i]
	}
	return r
}

type utxo struct {
	TxID  string `json:"txid"`
	Vout  uint32 `json:"vout"`
	Value uint64 `json:"value"`
}

// serializeLegacy builds a non-witness tx. scriptSigs[i] is used for input i.
func serializeLegacy(utxos []utxo, scriptSigs [][]byte, outScript []byte, outValue uint64) []byte {
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, uint32(2)) // version
	putVarint(&b, uint64(len(utxos)))
	for i, u := range utxos {
		txh, _ := hex.DecodeString(u.TxID)
		b.Write(reverse(txh))
		binary.Write(&b, binary.LittleEndian, u.Vout)
		putVarint(&b, uint64(len(scriptSigs[i])))
		b.Write(scriptSigs[i])
		binary.Write(&b, binary.LittleEndian, uint32(0xffffffff)) // sequence
	}
	putVarint(&b, 1) // one output
	binary.Write(&b, binary.LittleEndian, outValue)
	putVarint(&b, uint64(len(outScript)))
	b.Write(outScript)
	binary.Write(&b, binary.LittleEndian, uint32(0)) // locktime
	return b.Bytes()
}

func dsha256(b []byte) []byte {
	a := sha256.Sum256(b)
	c := sha256.Sum256(a[:])
	return c[:]
}

// buildSignedSweep returns (rawHex, txid).
func buildSignedSweep(priv *big.Int, utxos []utxo, p2pkhScript, outScript []byte, outValue uint64) (string, string) {
	pub := compressedF(scalarMulGF(priv))
	n := len(utxos)
	scriptSigs := make([][]byte, n)
	// sign each input with SIGHASH_ALL
	for i := 0; i < n; i++ {
		tmp := make([][]byte, n)
		for j := range tmp {
			if j == i {
				tmp[j] = p2pkhScript
			} else {
				tmp[j] = []byte{}
			}
		}
		pre := serializeLegacy(utxos, tmp, outScript, outValue)
		pre = append(pre, []byte{0x01, 0x00, 0x00, 0x00}...) // SIGHASH_ALL
		h := dsha256(pre)
		r, s := ecdsaSign(h, priv)
		sig := append(derSig(r, s), 0x01) // + hashtype
		var ss bytes.Buffer
		ss.WriteByte(byte(len(sig)))
		ss.Write(sig)
		ss.WriteByte(byte(len(pub)))
		ss.Write(pub)
		scriptSigs[i] = ss.Bytes()
	}
	raw := serializeLegacy(utxos, scriptSigs, outScript, outValue)
	txid := hex.EncodeToString(reverse(dsha256(raw)))
	return hex.EncodeToString(raw), txid
}

// ---- API calls (run on the user's machine) ----
func apiGet(url string) ([]byte, error) {
	c := &http.Client{Timeout: 25 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s -> %d: %s", url, resp.StatusCode, string(body))
	}
	return body, nil
}

func autoSweep(priv *big.Int, destAddr, apiBase string) (string, error) {
	apiBase = strings.TrimRight(apiBase, "/")
	ver, prog, err := decodeBech32P2(destAddr)
	if err != nil {
		return "", fmt.Errorf("payout address invalid: %w", err)
	}
	outScript := segwitScript(ver, prog)

	h160 := hash160Fast(scalarMulGF(priv))
	fromAddr := addrFromH160(h160)
	p2pkhScript := append(append([]byte{0x76, 0xa9, 0x14}, h160[:]...), 0x88, 0xac)

	// fetch UTXOs
	ub, err := apiGet(apiBase + "/address/" + fromAddr + "/utxo")
	if err != nil {
		return "", fmt.Errorf("fetch utxos: %w", err)
	}
	var us []utxo
	if err := json.Unmarshal(ub, &us); err != nil {
		return "", fmt.Errorf("parse utxos: %w", err)
	}
	if len(us) == 0 {
		return "", fmt.Errorf("no spendable funds at %s (maybe already swept)", fromAddr)
	}
	sort.Slice(us, func(i, j int) bool { return us[i].Value > us[j].Value })
	var total uint64
	for _, u := range us {
		total += u.Value
	}

	// fee rate (sat/vB)
	feeRate := uint64(20)
	if fb, err := apiGet(apiBase + "/v1/fees/recommended"); err == nil {
		var f struct {
			HalfHourFee uint64 `json:"halfHourFee"`
			FastestFee  uint64 `json:"fastestFee"`
		}
		if json.Unmarshal(fb, &f) == nil && f.HalfHourFee > 0 {
			feeRate = f.HalfHourFee
		}
	}
	vsize := uint64(11 + len(us)*148 + 43) // legacy inputs + 1 segwit output
	fee := feeRate * vsize
	if total <= fee {
		return "", fmt.Errorf("funds (%d sat) do not cover fee (%d sat)", total, fee)
	}
	outValue := total - fee

	rawHex, txid := buildSignedSweep(priv, us, p2pkhScript, outScript, outValue)
	// always save/print the signed tx so nothing is ever lost
	_ = os.WriteFile(besideExe("SWEEP_TX.hex"), []byte(rawHex), 0644)
	fmt.Printf("\nSweep tx built: %s sat -> %s (fee %d sat @ %d sat/vB)\n  txid: %s\n  raw:  %s\n  (saved to SWEEP_TX.hex)\n",
		formatSat(outValue), destAddr, fee, feeRate, txid, rawHex)

	// broadcast
	c := &http.Client{Timeout: 25 * time.Second}
	resp, err := c.Post(apiBase+"/tx", "text/plain", strings.NewReader(rawHex))
	if err != nil {
		return txid, fmt.Errorf("broadcast failed (%v) — submit SWEEP_TX.hex manually", err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return txid, fmt.Errorf("broadcast rejected: %s — submit SWEEP_TX.hex manually", string(rb))
	}
	return strings.TrimSpace(string(rb)), nil
}

func formatSat(s uint64) string {
	return fmt.Sprintf("%d sat (%.8f BTC)", s, float64(s)/1e8)
}
