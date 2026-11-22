import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/i18n.ts",
    "src/inbound-parts.ts",
    "src/locales/core.ts",
    "src/locales/core-bg.ts",
    "src/locales/core-server.ts",
    "src/locales/core-en.ts",
    "src/plugin-sdk.ts",
    "src/print-theme.ts",
    "src/url-text.ts",
    "src/util.ts",
    "src/zod-util.ts",
  ],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
