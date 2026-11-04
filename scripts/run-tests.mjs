// Runs every test suite and prints a summary. Exit code 1 if any suite fails.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const suites = [
  ["crypto core", "packages/core/test/core.test.ts"],
  ["CPU engine", "packages/engine/test/engine.test.ts"],
  ["range allocator", "packages/server/test/allocator.test.ts"],
  ["server integration", "packages/server/test/server.integration.test.ts"],
  ["claim / tx signing", "packages/claim/test/claim.test.ts"],
  ["webgpu field model", "packages/web-webgpu/model/field.test.mjs"],
  ["webgpu EC model", "packages/web-webgpu/model/ec.test.mjs"],
  ["webgpu pipeline model", "packages/web-webgpu/model/pipeline.test.mjs"],
];

let failed = 0;
for (const [name, path] of suites) {
  process.stdout.write(`\n\x1b[1m### ${name}\x1b[0m (${path})\n`);
  try {
    const out = execFileSync("node", ["--experimental-strip-types", join(root, path)], { encoding: "utf8" });
    process.stdout.write(out);
  } catch (e) {
    failed++;
    process.stdout.write((e.stdout || "") + (e.stderr || ""));
    process.stdout.write(`\x1b[31m### ${name} FAILED\x1b[0m\n`);
  }
}
process.stdout.write(failed === 0 ? "\n\x1b[32mALL SUITES PASSED\x1b[0m\n" : `\n\x1b[31m${failed} SUITE(S) FAILED\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
