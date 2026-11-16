import { defineConfig } from "tsdown";

/**
 * The package's three entry points, and two built files nothing imports:
 * `host-process`, which `paths.ts` spawns as srt's host process, and
 * `policy-compile`, which `scripts/sandbox-footprint.mjs` loads by path.
 */
export default defineConfig({
  entry: ["src/runtime.ts", "src/srt-cli.ts", "src/host.ts", "src/policy-compile.ts", "src/host-process.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
