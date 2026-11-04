package main
import ("bytes";"encoding/hex";"math/big";"strings";"testing")
func TestSweepSigValidates(t *testing.T){
  priv:=big.NewInt(0x1000003)
  pub:=scalarMulGF(priv); pubc:=compressedF(pub)
  h160:=hash160Fast(pub)
  p2pkh:=append(append([]byte{0x76,0xa9,0x14},h160[:]...),0x88,0xac)
  ver,prog,_:=decodeBech32P2("bc1qqngxt0ckry86kfw36d37g99tfxmlfe5ujpvm2a8lak7cn7u3w0wsqkg95s")
  out:=segwitScript(ver,prog)
  us:=[]utxo{{TxID:strings.Repeat("11",32),Vout:0,Value:100000}}
  rawHex,txid:=buildSignedSweep(priv,us,p2pkh,out,90000)
  t.Logf("txid=%s rawlen=%d", txid, len(rawHex)/2)
  // recompute sighash for the single input and verify the signature embedded
  pre:=serializeLegacy(us,[][]byte{p2pkh},out,90000)
  pre=append(pre,[]byte{0x01,0x00,0x00,0x00}...)
  sighash:=dsha256(pre)
  // parse scriptSig from the raw tx to extract the DER sig: it's PUSH(sig) PUSH(pub)
  raw,_:=hex.DecodeString(rawHex)
  // find the sig: scriptSig starts after version(4)+incount(1)+txid(32)+vout(4)+scriptlen(1)
  off:=4+1+32+4
  slen:=int(raw[off]); off++
  ss:=raw[off:off+slen]
  sigPushLen:=int(ss[0]); sig:=ss[1:1+sigPushLen]
  // verify pubkey matches
  pkPushLen:=int(ss[1+sigPushLen]); pk:=ss[2+sigPushLen:2+sigPushLen+pkPushLen]
  if !bytes.Equal(pk,pubc){ t.Fatalf("pubkey mismatch in scriptSig") }
  // DER decode r,s (strip trailing hashtype 0x01)
  der:=sig[:len(sig)-1]
  r,s:=parseDER(der)
  if !ecVerify(sighash,r,s,pub){ t.Fatalf("embedded signature does NOT validate against sighash") }
  t.Log("embedded signature VALIDATES against the sighash — tx is correctly signed")
}
func parseDER(d []byte) (*big.Int,*big.Int){
  // 0x30 len 0x02 rlen r 0x02 slen s
  i:=2; rlen:=int(d[i+1]); r:=new(big.Int).SetBytes(d[i+2:i+2+rlen]); i=i+2+rlen
  slen:=int(d[i+1]); s:=new(big.Int).SetBytes(d[i+2:i+2+slen])
  return r,s
}
