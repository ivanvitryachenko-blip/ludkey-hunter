package main
import ("crypto/rand";"math/big";"testing")
func randFe() (fe, *big.Int){ b:=make([]byte,32); rand.Read(b); x:=new(big.Int).SetBytes(b); x.Mod(x,P); return feFromBig(x), x }
func TestFieldFuzz(t *testing.T){
  for i:=0;i<200000;i++{
    fa,ba:=randFe(); fb,bb:=randFe()
    if feAdd(fa,fb).toBig().Cmp(new(big.Int).Mod(new(big.Int).Add(ba,bb),P))!=0 { t.Fatalf("add mismatch i=%d",i) }
    if feSub(fa,fb).toBig().Cmp(new(big.Int).Mod(new(big.Int).Sub(ba,bb),P))!=0 { t.Fatalf("sub mismatch i=%d",i) }
    if feMul(fa,fb).toBig().Cmp(new(big.Int).Mod(new(big.Int).Mul(ba,bb),P))!=0 { t.Fatalf("mul mismatch i=%d a=%x b=%x",i,ba,bb) }
  }
}
func TestFieldInv(t *testing.T){
  for i:=0;i<2000;i++{
    fa,ba:=randFe(); if ba.Sign()==0 { continue }
    got:=feInv(fa).toBig()
    want:=new(big.Int).ModInverse(ba,P)
    if got.Cmp(want)!=0 { t.Fatalf("inv mismatch i=%d",i) }
  }
}
func TestFieldEdge(t *testing.T){
  pm1:=new(big.Int).Sub(P,big.NewInt(1))
  cases:=[]*big.Int{big.NewInt(0),big.NewInt(1),pm1,new(big.Int).Sub(P,big.NewInt(2))}
  for _,a:=range cases { for _,b:=range cases {
    fa,fb:=feFromBig(a),feFromBig(b)
    if feMul(fa,fb).toBig().Cmp(new(big.Int).Mod(new(big.Int).Mul(a,b),P))!=0 { t.Fatalf("edge mul %x*%x",a,b) }
    if feAdd(fa,fb).toBig().Cmp(new(big.Int).Mod(new(big.Int).Add(a,b),P))!=0 { t.Fatalf("edge add") }
  }}
}
