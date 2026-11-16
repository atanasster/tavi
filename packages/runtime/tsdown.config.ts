import { defineConfig } from "tsdown";

export default defineConfig({
  tsconfig: "tsconfig.build.json",
  entry: {
    index: "src/index.ts",
    // The host allowlist language alone, for a caller (the CLI's flag check) that must not load the runtime.
    "host-policy": "src/host-policy.ts",
    // Attaching to a live owner alone (discovery, token, ownership probe, IPC client), without the database client.
    "owner-attach": "src/owner-attach.ts",
    "database-worker": "src/persistence/worker.ts",
    "ownership-worker": "src/persistence/ownership-worker.ts",
  },
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  deps: { neverBundle: ["better-sqlite3"] },
});
