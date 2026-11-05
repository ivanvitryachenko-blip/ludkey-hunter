package main
import ("math/big";"os";"testing")
func TestSegStorePersist(t *testing.T){
  p := "/tmp/segtest.txt"; os.Remove(p)
  s := newSegStore(p)
  s.markDone(big.NewInt(100)); s.markDone(big.NewInt(200)); s.markDone(big.NewInt(100)) // dup
  if s.count()!=2 { t.Fatalf("count=%d want 2",s.count()) }
  s.f.Close()
  // reopen -> should load 2
  s2 := newSegStore(p)
  if s2.count()!=2 { t.Fatalf("reload count=%d want 2",s2.count()) }
  // pickRandom never returns a done index (statistically; check it marks inflight)
  idx := s2.pickRandom()
  if _,d := s2.done[idx.String()]; d { t.Fatal("picked a done idx") }
  if _,f := s2.inflight[idx.String()]; !f { t.Fatal("picked idx not marked inflight") }
  // markDone moves inflight->done and persists
  s2.markDone(idx)
  if s2.count()!=3 { t.Fatalf("after pick+done count=%d want 3",s2.count()) }
  s2.f.Close()
  s3 := newSegStore(p)
  if s3.count()!=3 { t.Fatalf("final reload=%d want 3",s3.count()) }
  t.Log("segStore persist/load/skip OK")
}
