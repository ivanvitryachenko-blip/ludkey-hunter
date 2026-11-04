// Crash-safe checkpointing: atomically persist scan progress so a restart
// resumes exactly where it left off, with a backup copy.

import { writeFileSync, readFileSync, existsSync, renameSync, copyFileSync } from "node:fs";

export interface Checkpoint {
  puzzle: number;
  rangeStart: string; // hex
  rangeEnd: string; // hex
  position: string; // hex: next key to scan
  scanned: string; // decimal total scanned
  compressed: boolean;
  updatedAt: string;
  found?: { key: string; hash160: string };
}

export function saveCheckpoint(path: string, cp: Checkpoint): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(cp, null, 2));
  if (existsSync(path)) copyFileSync(path, path + ".bak"); // keep a backup
  renameSync(tmp, path); // atomic replace
}

export function loadCheckpoint(path: string): Checkpoint | null {
  for (const p of [path, path + ".bak"]) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")) as Checkpoint; }
      catch { /* try backup */ }
    }
  }
  return null;
}
