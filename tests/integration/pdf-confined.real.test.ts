import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ConfinementPort, PdfLaunch, PdfSandbox } from "@tavi/contracts";
import { canApplySeatbeltProfile } from "@tavi/test-support/sandbox";
import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPdfService } from "../../packages/builtin/pdf/src/host.js";
import { sampleForm } from "../../packages/builtin/pdf/test/support.js";

/** The package under test, from the repository's tests. */
const packageDirectory = join(import.meta.dirname, "..", "..", "packages", "builtin", "pdf");

/**
 * The PDF children under the real `ConfinementPort`: a stand-in child,
 * wrapped as the owner wraps the parser (`apps/cli/src/features/pdf/host.ts`), cannot read the person's keys, Tavi's
 * credentials or the owner's staging (E1, E16), has no route (E7), and cannot
 * write its package directory; the real parser still reads a PDF. On macOS
 * always (Seatbelt); on Linux when the sandbox matrix names a confining case
 * (`TAVI_SANDBOX_MATRIX=srt` or `nested`, scripts/sandbox-matrix/suite.sh).
 */

const MODE = process.env["TAVI_SANDBOX_MATRIX"] ?? (process.platform === "darwin" && canApplySeatbeltProfile() ? "srt" : undefined);
const RUNS = MODE === "srt" || MODE === "nested";
if (!RUNS)
  console.info(
    `[plugin-pdf] Skipping the confined PDF children: ${process.platform === "darwin" ? "this shell is already inside a sandbox, so srt cannot apply a nested profile" : "TAVI_SANDBOX_MATRIX does not name a confining case (srt or nested)"}`,
  );

const SECRET = "TAVI-PDF-SECRET";
const childPath = join(packageDirectory, "dist", "child.mjs");
const probeChild = join(import.meta.dirname, "fixtures", "probe-child.mjs");

let root = "";
let home = "";
let data = "";
let staging = "";
let sandbox: PdfSandbox;

/** The owner's wrap (`pdfSandbox`): home and data unreadable but for the launch's roots, nothing writable, no network. */
function ownerWrap(confinement: ConfinementPort): PdfSandbox {
  return {
    kind: "wrapped",
    wrap: (launch: PdfLaunch) => {
      const roots = [...new Set(launch.readRoots)].sort();
      const key = createHash("sha256").update(JSON.stringify(roots)).digest("hex").slice(0, 16);
      return confinement.wrap({
        argv: launch.argv,
        env: launch.env,
        policyFile: join(data, "pdf", `srt-${key}.json`),
        policy: { denyRead: [homedir(), home, data], allowRead: roots, allowWrite: [], domains: [], nested: MODE === "nested" },
      });
    },
  };
}

describe.skipIf(!RUNS)(`the PDF children confined (${MODE ?? "skipped"}, ${process.platform})`, () => {
  const temp = temporaryDirectories();
  beforeAll(() => {
    root = temp.create("tavi-pdf-confined-");
    home = join(root, "home");
    data = join(root, "data");
    for (const directory of [join(home, ".ssh"), join(data, "credentials"), join(data, "pdf")])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".ssh", "id_ed25519"), `${SECRET}-ssh\n`);
    writeFileSync(join(data, "credentials", "openai.json"), `${SECRET}-credentials\n`);
    staging = temp.create("tavi-pdf-staging-");
    writeFileSync(join(staging, "spool.bin"), `${SECRET}-staging\n`);
    sandbox = ownerWrap(createSrtConfinement({ alwaysDenyRead: [staging] }));
  });

  afterAll(() => {
    temp.cleanup();
  });

  it("keeps a stand-in child from the keys, the credentials and the staging, off the network, and out of its package", () => {
    if (sandbox.kind !== "wrapped") throw new Error("expected a wrapped sandbox");
    const written = join(packageDirectory, `pdf-confined-${String(process.pid)}.txt`);
    const reads = [join(home, ".ssh", "id_ed25519"), join(data, "credentials", "openai.json"), join(staging, "spool.bin")];
    // As the engine launches its children: Node, the entry, its package's folder readable.
    const launch = sandbox.wrap({
      argv: [process.execPath, probeChild, written, ...reads],
      env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), LANG: "C.UTF-8" },
      readRoots: [dirname(dirname(probeChild)), packageDirectory],
    });
    if ("refused" in launch) throw new Error("the sandbox refused the launch: it is unavailable on this host");
    try {
      const result = spawnSync(launch.command, [...launch.args], {
        env: { ...launch.env },
        cwd: dirname(probeChild),
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.stdout, result.stderr).not.toContain(SECRET);
      const found = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
      for (const path of reads) expect(found[`read ${path}`], path).toMatch(/^denied/);
      expect(found["write package"]).toMatch(/^denied/);
      expect(existsSync(written)).toBe(false);
      expect(found["tcp"]).toMatch(/^denied/);
      expect(found["udp"]).not.toBe("answered");
    } finally {
      rmSync(written, { force: true });
    }
  }, 60_000);

  it("still reads a PDF with the real parser", async () => {
    expect(existsSync(childPath), "build @tavi/plugin-pdf before its tests").toBe(true);
    const pdf = createPdfService({ sandbox, childPath, warm: false });
    try {
      const read = await pdf.run({ op: "read", find: "drain pump" }, await sampleForm());
      expect(read.ok, JSON.stringify(read)).toBe(true);
      expect(read.ok && read.answer.pages?.[0]?.page).toBe(1);
    } finally {
      await pdf.close();
    }
  }, 60_000);
});
