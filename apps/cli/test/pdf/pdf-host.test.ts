import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  PDF_LIMITS,
  type PdfRefusedLaunch,
  type PdfWrapped,
  type ResourceLimitPort,
  type SandboxHostPort,
  type SandboxStatus,
} from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import { pdfConfinementFacts } from "../../src/features/doctor/reports.js";
import { pdfConfinement, pdfOcrAssets, pdfSandbox } from "../../src/features/pdf/host.js";
import { ownerConfinement } from "../../src/features/sandbox/host.js";

/** The owner's PDF wiring: the engine's confinement and the OCR add-on, found in one place. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** A launch the wrap let run; a refusal fails the test. */
function confined(wrapped: PdfWrapped | PdfRefusedLaunch): PdfWrapped {
  if ("refused" in wrapped) throw new Error("the launch was refused");
  return wrapped;
}

describe("the PDF engine's confinement", () => {
  it("gives the parser and the OCR child each their own read roots, the add-on's directory to the OCR child only", () => {
    const data = directories.create("tavi-pdf-host-");
    const sandbox = pdfSandbox(data, ownerConfinement(), { platform: "darwin" });
    if (sandbox.kind !== "wrapped") throw new Error("expected srt on macOS");
    const settingsOf = (args: readonly string[]): { readonly filesystem?: { readonly allowRead?: readonly string[] } } => {
      const file = args.find((arg) => arg.endsWith(".json"));
      if (file === undefined) throw new Error(`no settings file in ${args.join(" ")}`);
      return JSON.parse(readFileSync(file, "utf8")) as { readonly filesystem?: { readonly allowRead?: readonly string[] } };
    };
    const parser = confined(sandbox.wrap({ argv: ["node", "child.mjs"], env: {}, readRoots: ["/opt/tavi/plugin-pdf"] }));
    const ocr = confined(
      sandbox.wrap({ argv: ["node", "ocr-child.mjs"], env: {}, readRoots: ["/opt/tavi/plugin-pdf", "/opt/tavi/pdf-ocr/dist"] }),
    );
    // The parser's own launch again reuses its file.
    const again = confined(sandbox.wrap({ argv: ["node", "child.mjs"], env: {}, readRoots: ["/opt/tavi/plugin-pdf"] }));
    expect(JSON.stringify(settingsOf(parser.args))).not.toContain("/opt/tavi/pdf-ocr/dist");
    expect(JSON.stringify(settingsOf(ocr.args))).toContain("/opt/tavi/pdf-ocr/dist");
    expect(again.args).toEqual(parser.args);
  });

  it("on Linux follows the sandbox's tier: confined while it confines, refused while it is unavailable", () => {
    const data = directories.create("tavi-pdf-host-");
    let status: SandboxStatus = { tier: "full", checks: [] };
    const host: SandboxHostPort = {
      current: () => status,
      check: async () => status,
      facts: async () => ({ platform: "linux", inContainer: false, appArmorRestrictsUserNamespaces: false, userNamespacesDisabled: false }),
    };
    const sandbox = pdfSandbox(data, ownerConfinement(), { platform: "linux", host });
    if (sandbox.kind !== "wrapped") throw new Error("expected a wrap on Linux");
    const launch = { argv: ["node", "child.mjs"], env: {}, readRoots: ["/opt/tavi/plugin-pdf"] };
    expect(confined(sandbox.wrap(launch)).args.some((arg) => arg.endsWith(".json"))).toBe(true);
    expect(pdfConfinement({ platform: "linux", host })).toBe("srt");
    status = { tier: "nested", checks: [] };
    const nested = confined(sandbox.wrap(launch)).args.find((arg) => arg.endsWith(".json")) ?? "";
    expect(JSON.parse(readFileSync(nested, "utf8"))).toMatchObject({ enableWeakerNestedSandbox: true });
    status = { tier: "unavailable", checks: [], cause: "AppArmor" };
    expect(sandbox.wrap(launch)).toEqual({ refused: "unconfined" });
    expect(pdfConfinement({ platform: "linux", host })).toBe("refused");
    // Fixed again: followed at the next launch, without a restart.
    status = { tier: "full", checks: [] };
    expect(confined(sandbox.wrap(launch)).args.some((arg) => arg.endsWith(".json"))).toBe(true);
  });

  it("runs bare where the sandbox is unavailable only with serve --pdf-allow-unconfined, and refuses elsewhere srt cannot confine", () => {
    const data = directories.create("tavi-pdf-host-");
    const host: SandboxHostPort = {
      current: () => ({ tier: "unavailable", checks: [] }),
      check: async () => ({ tier: "unavailable", checks: [] }),
      facts: async () => ({ platform: "linux", inContainer: false, appArmorRestrictsUserNamespaces: false, userNamespacesDisabled: false }),
    };
    const launch = { argv: ["node", "child.mjs"], env: {}, readRoots: ["/opt/tavi/plugin-pdf"] };
    const allowed = pdfSandbox(data, ownerConfinement(), { platform: "linux", host, allowUnconfined: true });
    if (allowed.kind !== "wrapped") throw new Error("expected a wrap on Linux");
    expect(allowed.wrap(launch)).toEqual({ command: "node", args: ["child.mjs"], env: {} });
    expect(pdfConfinement({ platform: "linux", host, allowUnconfined: true })).toBe("unconfined");
    const elsewhere = pdfSandbox(data, ownerConfinement(), { platform: "win32" });
    if (elsewhere.kind !== "wrapped") throw new Error("expected a wrap");
    expect(elsewhere.wrap(launch)).toEqual({ refused: "unconfined" });
    expect(pdfConfinement({ platform: "win32" })).toBe("refused");
    expect(pdfConfinement({ platform: "darwin", allowUnconfined: true })).toBe("srt");
  });
});

describe("tavi doctor's PDF confinement", () => {
  const unavailable: SandboxStatus = { tier: "unavailable", checks: [], cause: "AppArmor", fix: "run tavi sandbox setup" };

  it("says a refused host's calls are refused, with the sandbox's fix and the flag that allows them bare", () => {
    const refused = pdfConfinementFacts("refused", unavailable);
    expect(refused).toMatchObject({ confinement: "refused" });
    expect(refused["note"]).toContain("because AppArmor, so PDF calls are refused: run tavi sandbox setup");
    expect(refused["note"]).toContain("--pdf-allow-unconfined");
    // Without a fix of the sandbox's own, the setup command is named.
    expect(pdfConfinementFacts("refused", { tier: "unavailable", checks: [] })["note"]).toContain("fix the sandbox (tavi sandbox setup)");
  });

  it("says the owner's flag runs the child bare, with what confines it again and what turns the tools off", () => {
    const bare = pdfConfinementFacts("unconfined", unavailable);
    expect(bare).toMatchObject({ confinement: "unconfined" });
    expect(bare["note"]).toContain("serve was started with --pdf-allow-unconfined");
    expect(bare["note"]).toContain("run tavi sandbox setup confines it");
    expect(bare["note"]).toContain("tavi config set pdf.enabled off");
  });

  it("says srt, and that the tools fail while srt does not work", () => {
    expect(pdfConfinementFacts("srt", { tier: "full", checks: [] })).toEqual({ confinement: "srt" });
    expect(pdfConfinementFacts("srt", { tier: "unavailable", checks: [], cause: "no srt" })).toMatchObject({
      confinement: "srt",
      works: false,
      cause: "no srt",
    });
  });
});

describe("the OCR add-on", () => {
  it("is found as files the engine is handed, or not at all", async () => {
    const assets = await pdfOcrAssets();
    if (assets === undefined) return;
    expect(assets.core.startsWith(assets.directory)).toBe(true);
    expect(assets.wasm.startsWith(assets.directory)).toBe(true);
    expect(assets.languages.eng.startsWith(assets.directory)).toBe(true);
  });
});

describe("the PDF children's cgroup", () => {
  it("places each child with the watchdog's cap and 64 pids, and reports an OOM kill once it exits", () => {
    const data = directories.create("tavi-pdf-limits-");
    const calls: string[] = [];
    const limits: ResourceLimitPort = {
      capabilities: () => ({ memory: "enforced", pids: "enforced", cpu: "enforced", rung: "delegated" }),
      place: (argv, workload, caps) => (
        calls.push(`place ${workload} ${String(caps?.memoryBytes)}`), { argv: ["/bin/sh", "enter", ...argv], groupId: "g1" }
      ),
      kill: (id) => void calls.push(`kill ${id}`),
      outcome: () => "oom",
      release: (id) => void calls.push(`release ${id}`),
    };
    const host: SandboxHostPort = {
      current: () => ({ tier: "unavailable", checks: [] }),
      check: async () => ({ tier: "unavailable", checks: [] }),
      facts: async () => ({ platform: "linux", inContainer: false, appArmorRestrictsUserNamespaces: false, userNamespacesDisabled: false }),
    };
    const sandbox = pdfSandbox(data, ownerConfinement(), { platform: "linux", host, limits, allowUnconfined: true });
    if (sandbox.kind !== "wrapped") throw new Error("expected a wrap");
    const wrapped = confined(sandbox.wrap({ argv: ["node", "child.mjs"], env: {}, readRoots: [] }));
    // Bare (the tier is unavailable, and the owner allowed it) but bounded all the same.
    expect(wrapped.command).toBe("/bin/sh");
    expect(wrapped.args).toEqual(["enter", "node", "child.mjs"]);
    expect(calls).toEqual([`place pdf ${String((PDF_LIMITS.childRssMb + 64) * 1024 * 1024)}`]);
    // The kill ladder's SIGKILL reaches the whole cgroup.
    wrapped.kill?.();
    expect(calls).toContain("kill g1");
    expect(wrapped.onExit?.()).toBe("oom");
    expect(calls).toContain("release g1");
  });
});
