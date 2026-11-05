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

// CPU and GPU agents share progress: the Go store must also load a sibling
// ludkey-progress*.txt (e.g. the CUDA agent's) so they never re-scan each other.
func TestSegStoreSharesSiblingProgress(t *testing.T){
  dir, _ := os.MkdirTemp("", "ludshare")
  defer os.RemoveAll(dir)
  cpu := dir+"/ludkey-progress.txt"
  gpu := dir+"/ludkey-progress-gpu.txt"
  os.WriteFile(gpu, []byte("111\n222\n333\n"), 0644) // segments the GPU agent finished
  s := newSegStore(cpu)
  for _, k := range []string{"111","222","333"} {
    if _, ok := s.done[k]; !ok { t.Fatalf("CPU store did not load GPU segment %s", k) }
  }
  // its own writes go only to its own file, not the sibling
  s.markDone(big.NewInt(999)); s.f.Close()
  if b, _ := os.ReadFile(gpu); string(b) != "111\n222\n333\n" { t.Fatal("CPU agent must not write to the GPU progress file") }
  // a fresh CPU store sees its own 999 + the 3 GPU segments = 4
  s2 := newSegStore(cpu)
  if s2.count()!=4 { t.Fatalf("combined count=%d want 4", s2.count()) }
  t.Log("shared CPU+GPU progress OK")
}
