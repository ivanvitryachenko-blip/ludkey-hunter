package main
import ("bytes";"encoding/hex";"math/big";"testing";"crypto/rand")
func TestFastECVsBig(t *testing.T){
  for i:=0;i<500;i++{
    b:=make([]byte,9); rand.Read(b); k:=new(big.Int).SetBytes(b); if k.Sign()==0 {k.SetInt64(1)}
    pf:=scalarMulGF(k); ps:=scalarMulG(k)
    if pf.X.toBig().Cmp(ps.X)!=0 || pf.Y.toBig().Cmp(ps.Y)!=0 { t.Fatalf("scalarmul mismatch k=%x",k) }
    if !bytes.Equal(compressedF(pf), compressed(ps)) { t.Fatalf("compressed mismatch k=%x",k) }
  }
}
func TestFastVectors(t *testing.T){
  pairs:=[][2]string{{"1","751e76e8199196d454941c45d1b3a323f1433bd6"},{"15","8f9dff39a81ee4abcbad2ad8bafff090415a2be8"},{"202","d7729816650e581d7462d52ad6f732da0e2ec93b"}}
  for _,p:=range pairs{
    k,_:=new(big.Int).SetString(p[0],16)
    h:=hash160(compressedF(scalarMulGF(k)))
    w,_:=hex.DecodeString(p[1])
    if !bytes.Equal(h[:],w){ t.Fatalf("vector %s got %x",p[0],h) }
  }
}
func TestFastBatch(t *testing.T){
  // base + table must equal direct scalarmul
  base:=scalarMulGF(big.NewInt(1000))
  table:=precomputeF(16)
  pts:=batchAddDeltasF(base, table[:8])
  for i:=0;i<8;i++{
    want:=scalarMulGF(big.NewInt(int64(1000+i+1)))
    if !pts[i].X.eq(want.X) || !pts[i].Y.eq(want.Y){ t.Fatalf("batch[%d] mismatch",i) }
  }
}
