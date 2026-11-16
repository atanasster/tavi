import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/channel.ts", "src/connector.ts", "src/inbound.ts", "src/webhook.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
