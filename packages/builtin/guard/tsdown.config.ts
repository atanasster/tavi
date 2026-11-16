import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/manifest.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
