package main
import ("math/big";"sync/atomic";"testing";"time";"fmt")
func mkState(tgt [20]byte, w int) *scanState {
  var scanned uint64; var stop atomic.Bool
  return &scanState{target:tgt,table:precomputeF(w),window:w,scanned:&scanned,stop:&stop,
    dxs:make([]fe,w),pre:make([]fe,w),invs:make([]fe,w)}
}
func TestFastSpeed(t *testing.T){
  st:=mkState([20]byte{0xde,0xad},1024)
  start:=new(big.Int).Lsh(big.NewInt(1),71)
  end:=new(big.Int).Add(start,big.NewInt(3000000))
  t0:=time.Now(); scanSegment(start,end,st); dt:=time.Since(t0).Seconds()
  n:=atomic.LoadUint64(st.scanned)
  fmt.Printf("FASTSPEED: %.0f key/s per core (%.3f Mkey/s)\n", float64(n)/dt, float64(n)/dt/1e6)
}
func TestPlantedFast(t *testing.T){
  secret:=big.NewInt(0x1200034)
  tgt:=hash160Fast(scalarMulGF(secret))
  st:=mkState(tgt,64)
  k,_,found:=scanSegment(big.NewInt(0x1200000),big.NewInt(0x1200100),st)
  if !found||k.Cmp(secret)!=0 { t.Fatalf("planted key not found correctly: %v",k) }
}
func BenchmarkScanAlloc(b *testing.B){
  st:=mkState([20]byte{0xde,0xad},1024)
  start:=new(big.Int).Lsh(big.NewInt(1),71)
  end:=new(big.Int).Add(start,big.NewInt(int64(b.N)+2048))
  b.ResetTimer(); scanSegment(start,end,st)
}
