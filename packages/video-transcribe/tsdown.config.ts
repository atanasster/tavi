import { defineConfig } from "tsdown";
// The add-on's module, and the child it runs in a confined process of its own.
export default defineConfig({
  entry: ["src/index.ts", "src/child.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
