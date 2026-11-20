import { describe, expect, it } from "vitest";

import { doctorSummary } from "../../src/features/doctor/client.js";
import type { DoctorDocument } from "../../src/features/doctor/reports.js";

/** `tavi doctor --format text`: a mark per line, ticked when it's fine and crossed when it needs the person. */

const report = (sections: Record<string, unknown>): DoctorDocument => sections as unknown as DoctorDocument;
const line = (text: string, label: string): string | undefined => text.split("\n").find((entry) => entry.includes(` ${label}:`));

describe("doctor's text summary", () => {
  it("says what the last model lifecycle sync stored: nothing, all well, or each model in use that warns", () => {
    const lifecycle = (value: unknown) => doctorSummary(report({ modelConfiguration: { connections: [], lifecycle: value } }));
    expect(line(lifecycle({ checkedAt: null, hint: "Set RHUMB_KEY", warnings: [] }), "Model lifecycle")).toBe(
      "– Model lifecycle: not checked (Set RHUMB_KEY)",
    );
    expect(line(lifecycle({ checkedAt: "2026-11-20T08:00:00.000Z", warnings: [] }), "Model lifecycle")).toBe(
      "✓ Model lifecycle: no model in use is retiring or redirected (checked 2026-11-20)",
    );
    const text = lifecycle({
      checkedAt: "2026-11-20T08:00:00.000Z",
      warnings: [
        {
          connectionId: "openai",
          model: "gpt-5",
          level: "error",
          says: ["retired on 2026-11-19"],
          replacements: { provider: { model: "gpt-6-luna" }, rhumb: [{ for: "agent", model: "gpt-6.2-sol" }] },
        },
      ],
    });
    expect(text).toContain(
      "      the provider moves it to gpt-6-luna; Rhumb suggests gpt-6.2-sol (with tools) (tavi models replace moves every use)",
    );
    expect(line(text, "Model lifecycle")).toBe(
      "✗ Model lifecycle: 1 model(s) in use retired or retiring, redirected or changing (checked 2026-11-20)",
    );
    expect(text).toContain("    openai/gpt-5: retired on 2026-11-19");
    const warned = lifecycle({
      checkedAt: "2026-11-01T08:00:00.000Z",
      stale: true,
      unchecked: ["gemini/gemini-3.8-flash"],
      unread: ["default routines of operator: database is locked"],
      warnings: [{ connectionId: "openai", model: "o3", level: "warning", says: ["retires on 2026-12-11"] }],
    });
    expect(line(warned, "Model lifecycle")).toBe(
      "– Model lifecycle: 1 model(s) in use retiring, redirected or changing (checked 2026-11-01)",
    );
    expect(warned).toContain("    stale: the daily sync has not run");
    expect(warned).toContain("    not yet checked: gemini/gemini-3.8-flash");
    expect(warned).toContain("    1 source(s) of models in use not read");
    expect(line(lifecycle({ checkedAt: null, hint: "no cloud connection Rhumb knows" }), "Model lifecycle")).toBe(
      "– Model lifecycle: not checked (no cloud connection Rhumb knows)",
    );
    expect(line(lifecycle({ problem: "database is locked" }), "Model lifecycle")).toBe(
      "– Model lifecycle: could not be read (database is locked)",
    );
    expect(line(doctorSummary(report({ modelConfiguration: { connections: [] } })), "Model lifecycle")).toBeUndefined();
  });

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
