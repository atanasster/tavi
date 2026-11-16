import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/chromium.ts", "src/live.ts", "src/playwright.ts", "src/render.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
