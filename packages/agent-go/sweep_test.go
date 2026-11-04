package main
import ("crypto/sha256";"crypto/rand";"math/big";"testing")
// generic scalar mul of an arbitrary point (for verify)
func scalarMulPtF(k *big.Int, base ptF) ptF {
  kk:=new(big.Int).Mod(k,N); acc:=jInfF(); add:=jacF{base.X,base.Y,feOne}
  for kk.Sign()>0 { if kk.Bit(0)==1 { acc=jAddF(acc,add) }; add=jDoubleF(add); kk.Rsh(kk,1) }
  return toAffineF(acc)
}
func ecVerify(hash []byte, r, s *big.Int, pub ptF) bool {
  if r.Sign()<=0||s.Sign()<=0||r.Cmp(N)>=0||s.Cmp(N)>=0 { return false }
  z:=bits2int(hash,N.BitLen()); w:=new(big.Int).ModInverse(s,N)
  u1:=new(big.Int).Mod(new(big.Int).Mul(z,w),N); u2:=new(big.Int).Mod(new(big.Int).Mul(r,w),N)
  R:=affineAddF(scalarMulGF(u1), scalarMulPtF(u2,pub))
  return new(big.Int).Mod(R.X.toBig(),N).Cmp(r)==0
}
func TestECDSASignVerify(t *testing.T){
  for i:=0;i<200;i++{
    db:=make([]byte,32); rand.Read(db); d:=new(big.Int).SetBytes(db); d.Mod(d,N); if d.Sign()==0{d.SetInt64(1)}
    pub:=scalarMulGF(d)
    msg:=make([]byte,32); rand.Read(msg); h:=sha256.Sum256(msg)
    r,s:=ecdsaSign(h[:],d)
    if !ecVerify(h[:],r,s,pub){ t.Fatalf("sig invalid i=%d",i) }
    // low-S
    half:=new(big.Int).Rsh(N,1); if s.Cmp(half)>0 { t.Fatalf("s not low i=%d",i) }
  }
}
func TestBech32(t *testing.T){
  ver,prog,err:=decodeBech32P2("bc1qqngxt0ckry86kfw36d37g99tfxmlfe5ujpvm2a8lak7cn7u3w0wsqkg95s")
  if err!=nil { t.Fatalf("decode err: %v",err) }
  t.Logf("version=%d proglen=%d prog=%x", ver, len(prog), prog)
  if ver!=0 { t.Fatalf("expected v0 got %d",ver) }
  // known-good P2WPKH vector (bech32 test vector)
  v2,p2,e2:=decodeBech32P2("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")
  if e2!=nil||v2!=0||len(p2)!=20 { t.Fatalf("p2wpkh vector failed: %v %d %d",e2,v2,len(p2)) }
}
