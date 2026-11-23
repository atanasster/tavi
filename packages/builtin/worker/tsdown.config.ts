import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
  },
  {
    // The worker runs confined, reading only its own folder: one file, zod and the message formatter inside it.
    entry: ["src/worker.ts"],
    format: ["esm"],
    platform: "node",
    dts: false,
    clean: false,
    sourcemap: false,
    target: "node22",
    noExternal: ["zod", "@tavi/contracts/i18n"],
  },
]);
