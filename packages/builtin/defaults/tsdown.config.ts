import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/heartbeat.ts", "src/ideas.ts", "src/memory.ts", "src/onboarding.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
