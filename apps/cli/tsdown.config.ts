import { defineConfig } from "tsdown";

export default defineConfig({
  tsconfig: "tsconfig.build.json",
  // `main` is the importable library surface; `executable` is the binary.
  entry: { main: "src/main.ts", executable: "src/bin/executable.ts" },
  format: ["esm"],
  platform: "node",
  dts: { sourcemap: true },
  clean: true,
  sourcemap: true,
  target: "node22",
  // The add-ons are found where they are installed, beside Tavi, never built into it:
  // the pose add-on's child is a file of its own package.
  deps: { neverBundle: ["better-sqlite3", "@tavi/pdf-ocr", "@tavi/video-pose", "@tavi/video-transcribe"] },
});
