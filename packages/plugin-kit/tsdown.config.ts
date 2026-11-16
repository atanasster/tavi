import { defineConfig } from "tsdown";
export default defineConfig({
  entry: {
    heartbeat: "src/heartbeat/index.ts",
    ideas: "src/ideas/index.ts",
    memory: "src/memory/index.ts",
    onboarding: "src/onboarding/index.ts",
  },
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
