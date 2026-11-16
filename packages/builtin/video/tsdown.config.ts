import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/index.ts", "src/internals.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
