import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { VideoSandbox } from "@tavi/contracts";
import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFfmpegDecoder } from "../../packages/builtin/video/src/decoder.js";
import { findFfmpeg } from "../../packages/builtin/video/src/ffmpeg.js";
import { createRunner } from "../../packages/builtin/video/src/run.js";

/**
 * A video run under the real `ConfinementPort`: wrapped as the owner wraps it, a stand-in child cannot read the
 * person's keys or Tavi's credentials, cannot write beside its run directory,
 * and has no route; the real decoder still reads a clip. On macOS always
 * (Seatbelt); on Linux when the sandbox matrix names a confining case.
 */

const MODE = process.env["TAVI_SANDBOX_MATRIX"] ?? (process.platform === "darwin" && canApplySeatbeltProfile() ? "srt" : undefined);
const RUNS = MODE === "srt" || MODE === "nested";
const SECRET = "TAVI-VIDEO-SECRET";

let root = "";
let home = "";
let data = "";

/** The owner's video wrap: home and data denied but for the run directory, which alone is writable; no network. */
function ownerWrap(): VideoSandbox {
  const confinement = createSrtConfinement();
  return {
    kind: "wrapped",
    wrap: (launch) =>
      confinement.wrap({
        argv: launch.argv,
        env: launch.env,
        policyFile: join(launch.runDirectory, "srt.json"),
        policy: {
          denyRead: [homedir(), home, data],
          allowRead: [launch.runDirectory, ...launch.readRoots],
          allowWrite: [launch.runDirectory],
          domains: [],
          nested: MODE === "nested",
        },
      }),
  };
}

/** What the stand-in child tries: each attempt's outcome as one JSON line. */
const PROBE = `
const fs = require("fs"); const net = require("net");
const out = {};
for (const path of process.argv.slice(1, -1)) { try { out["read " + path] = fs.readFileSync(path, "utf8"); } catch (error) { out["read " + path] = "denied " + error.code; } }
const outside = process.argv.at(-1);
try { fs.writeFileSync(outside, "x"); out.write = "written"; } catch (error) { out.write = "denied " + error.code; }
try { fs.writeFileSync("inside.txt", "x"); out.inside = "written"; } catch (error) { out.inside = "denied " + error.code; }
const socket = net.connect({ host: "1.1.1.1", port: 80, timeout: 3000 });
socket.on("connect", () => { out.tcp = "connected"; done(); });
socket.on("error", (error) => { out.tcp = "denied " + error.code; done(); });
socket.on("timeout", () => { out.tcp = "denied timeout"; done(); });
function done() { socket.destroy(); console.log(JSON.stringify(out)); }
`;

describe.skipIf(!RUNS)(`a video run confined (${MODE ?? "skipped"}, ${process.platform})`, () => {
  const temp = temporaryDirectories();
  beforeAll(() => {
    root = temp.create("tavi-video-confined-");
    home = join(root, "home");
    data = join(root, "data");
    for (const directory of [join(home, ".ssh"), join(data, "credentials")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".ssh", "id_ed25519"), `${SECRET}-ssh\n`);
    writeFileSync(join(data, "credentials", "openai.json"), `${SECRET}-credentials\n`);
  });
  afterAll(() => temp.cleanup());

  it("keeps a stand-in child from the keys and credentials, off the network, and writing only its run directory", async () => {
    const runner = createRunner({ sandbox: ownerWrap(), runsDirectory: join(data, "video", "runs") });
    const run = runner.open({ bytes: new TextEncoder().encode("GIF89a stand-in") }, "gif");
    const reads = [join(home, ".ssh", "id_ed25519"), join(data, "credentials", "openai.json")];
    const outside = join(data, "video", "planted.txt");
    try {
      const result = await runner.exec({
        binary: process.execPath,
        args: ["-e", PROBE, ...reads, outside],
        run,
        timeoutMs: 30_000,
        stdoutMaxBytes: 64 * 1024,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.stdout.toString()).not.toContain(SECRET);
      const found = JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
      for (const path of reads) expect(found[`read ${path}`], path).toMatch(/^denied/);
      expect(found["write"]).toMatch(/^denied/);
      expect(() => readFileSync(outside)).toThrow();
      expect(found["inside"]).toBe("written");
      expect(found["tcp"]).toMatch(/^denied/);
    } finally {
      run.dispose();
      await runner.close();
    }
  }, 60_000);

  const ffmpeg = findFfmpeg();
  it.skipIf("missing" in ffmpeg)(
    "still decodes a clip with the person's FFmpeg",
    async () => {
      const decoder = await createFfmpegDecoder({ sandbox: ownerWrap(), runsDirectory: join(data, "video", "runs") });
      const gif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
      const opened = decoder.open({ bytes: gif });
      if (!opened.ok) throw new Error(JSON.stringify(opened));
      try {
        expect(await decoder.probe(opened.value.input)).toMatchObject({
          ok: true,
          value: { container: "gif", video: { width: 1, height: 1 } },
        });
        const still = await decoder.frames(opened.value.input, { kind: "times", times: [0], longEdge: 64 }, opened.value.directory);
        expect(still.ok, JSON.stringify(still)).toBe(true);
      } finally {
        opened.value.dispose();
        await decoder.close();
      }
    },
    60_000,
  );
});
