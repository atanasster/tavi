import { describe, expect, it } from "vitest";

import { doctorSummary } from "../../src/features/doctor/client.js";
import type { DoctorDocument } from "../../src/features/doctor/reports.js";

/** `tavi doctor --format text`: a mark per line, ticked when it's fine and crossed when it needs the person. */

const report = (sections: Record<string, unknown>): DoctorDocument => sections as unknown as DoctorDocument;
const line = (text: string, label: string): string | undefined => text.split("\n").find((entry) => entry.includes(` ${label}:`));

describe("doctor's text summary", () => {
  it("ticks Video when FFmpeg is there, and crosses it when video is on without FFmpeg", () => {
    expect(line(doctorSummary(report({ video: { enabled: true, ffmpeg: "9.0.2" } })), "Video")).toBe("✓ Video: on, ffmpeg 9.0.2");
    expect(line(doctorSummary(report({ video: { enabled: true, ffmpeg: "missing" } })), "Video")).toBe("✗ Video: on, ffmpeg missing");
    expect(line(doctorSummary(report({ video: { enabled: false } })), "Video")).toBe("– Video: off");
  });

  it("says under the sandbox line why it is unavailable, and each hint (WSL1, WSL2's keep-running settings)", () => {
    const text = doctorSummary(
      report({ sandbox: { tier: "unavailable", cause: "WSL1 has no Linux kernel namespaces", hardening: ["set instanceIdleTimeout=-1"] } }),
    );
    expect(text).toMatch(/^✗ Sandbox: unavailable \(\?\)\n {4}WSL1 has no Linux kernel namespaces\n {4}hint: set instanceIdleTimeout=-1$/m);
  });

  it("names the sandbox's fix where it is unavailable (Windows: WSL2)", () => {
    const text = doctorSummary(
      report({ sandbox: { tier: "unavailable", cause: "the sandbox runs on macOS and Linux, not win32", fix: "run Tavi inside WSL2" } }),
    );
    expect(text).toMatch(
      /^✗ Sandbox: unavailable \(\?\)\n {4}the sandbox runs on macOS and Linux, not win32\n {4}fix: run Tavi inside WSL2$/m,
    );
  });

  it("checks the Visual C++ runtime on Windows only, naming what is missing and the fix", () => {
    expect(doctorSummary(report({}))).not.toMatch(/Visual C\+\+/);
    expect(doctorSummary(report({ vcRuntime: { ok: true, missing: [] } }))).toMatch(/^✓ Visual C\+\+ runtime$/m);
    expect(doctorSummary(report({ vcRuntime: { ok: false, missing: ["msvcp140.dll"], fix: "winget install x" } }))).toMatch(
      /^✗ Visual C\+\+ runtime: msvcp140.dll missing\n {4}fix: winget install x$/m,
    );
  });

  it("says the owner pinned the sandbox off, and names the opt-ins it was started with", () => {
    const sandbox = (options: Record<string, unknown>) =>
      doctorSummary(report({ sandbox: { tier: "full", mechanism: "seatbelt", options } }));
    expect(line(sandbox({}), "Sandbox")).toBe("✓ Sandbox: full (seatbelt)");
    expect(sandbox({})).not.toMatch(/started with/);
    expect(line(sandbox({ pinnedOff: true }), "Sandbox")).toBe(
      "– Sandbox: off (serve --sandbox-tier unavailable, or TAVI_SANDBOX=off): shell commands are refused; this host could run full (seatbelt)",
    );
    expect(sandbox({ pty: true, localBind: true, inspectTls: true })).toMatch(
      /^✓ Sandbox: full \(seatbelt\)\n {4}started with --sandbox-pty, --sandbox-local-bind, --sandbox-inspect-tls$/m,
    );
  });

  it("crosses Stranded turns when an unclean stop cut a turn off, naming the task and how to free it", () => {
    expect(line(doctorSummary(report({ strandedAdmissions: { admissions: [], truncated: false } })), "Stranded turns")).toBe(
      "✓ Stranded turns: none",
    );
    const text = doctorSummary(
      report({
        strandedAdmissions: {
          admissions: [{ taskId: "task-1", slot: "held", remedy: "`tavi recover task-1 --generation 1` frees the slot" }],
          truncated: false,
        },
      }),
    );
    expect(line(text, "Stranded turns")).toBe("✗ Stranded turns: 1, a turn an owner's stop cut off");
    expect(text).toMatch(/^✗ Stranded turns: .*\n {4}task-1: `tavi recover task-1 --generation 1` frees the slot$/m);
  });

  it("shows the owner's health, and crosses it when a measure kept growing", () => {
    const now = { at: "2026-11-04T00:00:00.000Z", rssBytes: 200 * 1024 * 1024, openFds: 40, children: 2 };
    expect(line(doctorSummary(report({ health: { now, growth: [] } }), true), "Owner health")).toBe(
      "✓ Owner health: 200 MB memory, 40 open files, 2 child processes",
    );
    expect(
      line(
        doctorSummary(report({ health: { now, growth: [{ metric: "rssBytes", warning: "memory grew 3x in 6 hours" }] } }), true),
        "Owner health",
      ),
    ).toBe("✗ Owner health: 200 MB memory, 40 open files, 2 child processes; memory grew 3x in 6 hours");
    // Windows counts handles, not descriptors.
    const windows = { at: now.at, rssBytes: now.rssBytes, openHandles: 512, children: 2 };
    expect(line(doctorSummary(report({ health: { now: windows, growth: [] } }), true), "Owner health")).toBe(
      "✓ Owner health: 200 MB memory, 512 open handles, 2 child processes",
    );
    // No owner, no trend.
    expect(doctorSummary(report({ health: { running: false } }))).not.toMatch(/Owner health/);
  });
});

describe("what tavi serve logs at start for a stranded turn", () => {
  it("one plain warning per task, pointing at tavi doctor", async () => {
    const { strandedTurnWarnings } = await import("../../src/features/doctor/reports.js");
    const warnings = strandedTurnWarnings({
      admissions: [
        {
          taskId: "task-1",
          admissionId: "adm-1",
          operationKey: "k",
          kind: "run",
          claimedAt: "2026-11-04T00:00:00.000Z",
          slot: "held",
          execution: { generation: 1 },
          remedy: "r",
        } as never,
      ],
      truncated: false,
    });
    expect(warnings.map((warning) => warning.message)).toEqual([
      "a turn of task task-1 was cut off when an owner stopped; `tavi doctor --format text` says how to free it",
    ]);
  });
});
