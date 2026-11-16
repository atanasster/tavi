import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  // The contracts' types are inlined, so a plugin needs only this package and zod.
  deps: { dts: { alwaysBundle: [/^@tavi\/contracts/] } },
  clean: true,
  sourcemap: true,
  target: "node22",
});
