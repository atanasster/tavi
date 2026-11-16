import { emitJson, isTextOutput } from "../../cli/output.js";
import { EXIT, reportFailure } from "../../cli/exit.js";
import type { TaviRuntime } from "../../runtime/types.js";
import { buildDoctorDocument, type DoctorDocument } from "./reports.js";
import { resolveDataDirectory } from "../../shared/data-directory.js";
import type { CliIo } from "../../cli/io.js";
import { attachToOwner } from "../../cli/owner.js";
import type { RuntimeFactory } from "../../cli/runtime-options.js";
import { SANDBOX_OPTION_FLAGS } from "../sandbox/setup.js";

/**
 * Report composition and capability status.
 *
 * A live owner answers over IPC, so a running service describes itself rather
 * than a throwaway composition. With no owner, doctor deliberately composes with
 * **no** provider connection and `requireModelTransport: false`, so it validates
 * the runtime kernel, the tool registry and the database without credentials.
 *
 * It describes the **real** data directory — configuration, checkpoints and the
 * credential source are what an operator needs to see, and a report about a
 * throwaway database would describe nothing. So it takes exclusive ownership like
 * any other foreground command, which is why it refuses on a public directory, and
 * it applies migrations when the directory is new. A live owner answers doctor
 * over IPC instead, so its report describes the capabilities it really has.
 */
/**
 * `doctor`'s verdict, in one place.
 *
 * A corrupt database is not a healthy installation however open admission is, and
 * the exit code is what a monitoring check reads. Shared with the
 * attached path: an owner answers `doctor` over IPC, and a check that got 0 from a
 * daemon whose own report said `integrity.ok: false` would be worse than no check
 * at all.
 */
function doctorExitCode(report: DoctorDocument): number {
  if (report.integrity.checked && report.integrity.ok === false) return EXIT.unavailable;
  return report.admissionOpen ? EXIT.ok : EXIT.unavailable;
}

export async function doctor(
  io: CliIo,
  runtimeFactory: RuntimeFactory,
  explicitDataDirectory?: string,
  options: {
    /**
     * `--deep`: SQLite's full integrity check rather than `PRAGMA quick_check`.
     * Offline only — an attached doctor skips the check either way, as it
     * would block the owner's event loop.
     */
    readonly deep?: boolean;
  } = {},
): Promise<number> {
  // A live owner answers doctor too, so a running service can describe itself.
  let runtime: TaviRuntime;
  try {
    const attached = await attachToOwner(
      resolveDataDirectory(explicitDataDirectory),
      "doctor",
      {},
      io,
      (result) => doctorExitCode(result as DoctorDocument),
      undefined,
      // The owner answered: it is running, and it holds the database doctor would otherwise check.
      (result) => printDoctor(io, result as DoctorDocument, true),
    );
    if (attached !== undefined) return attached;
    runtime = await runtimeFactory(
      {
        dataDirectory: resolveDataDirectory(explicitDataDirectory),
        // The real data directory, not a disposable in-memory store: doctor
        // reports what is installed (tables, checkpoints, model configuration and
        // the credential source), and a report about a throwaway database would
        // describe nothing an operator can act on. Composition is still made
        // without a model transport, so doctor needs no credentials.
        inMemory: false,
        workspaces: [
          {
            workspaceId: "default",
            principalId: "operator",
            permissions: ["tools.invoke", "models.invoke", "runs.create"],
          },
        ],
        providers: [],
        credentials: {},
        defaultConnectionId: "unconfigured",
        defaultModel: "unconfigured",
        logger: { level: "warn", sink: (line) => process.stderr.write(`${line}\n`) },
        externalPlugins: "verify",
      },
      { requireModelTransport: false, inspectCheckpoints: true },
    );
  } catch (error) {
    // Covers both an unreachable owner and a composition failure; `reportFailure`
    // classifies the code, so one prefix for the whole report is honest.
    return reportFailure(error, io, "doctor could not report status");
  }

  try {
    const report = await buildDoctorDocument(runtime, { integrity: options.deep === true ? "full" : "quick" });
    printDoctor(io, report);
    return doctorExitCode(report);
  } catch (error) {
    // Reading the installation can fail (a corrupt row, a store error); that is a
    // report failure, not an internal crash.
    return reportFailure(error, io, "doctor could not read the installation");
  } finally {
    await runtime.close();
  }
}

/** The report as JSON, or its summary under `--format text`. */
function printDoctor(io: CliIo, report: DoctorDocument, fromOwner = false): void {
  if (isTextOutput(io)) io.stdout(doctorSummary(report, fromOwner));
  else emitJson(io, report);
}

/** One of the report's records, or an empty one. */
const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * `tavi doctor --format text`: a line per check a person reads first — Node,
 * the database, migrations, the owner, models, onboarding, the sandbox and its
 * limits, video, taint and web search, disk — and where the whole report is.
 */
export function doctorSummary(report: DoctorDocument, fromOwner = false): string {
  const node = recordOf(report["node"]);
  const integrity = recordOf(report["integrity"]);
  const migrations = recordOf(report["migrations"]);
  const health = recordOf(report["health"]);
  const models = recordOf(report["modelConfiguration"]);
  const onboarding = recordOf(report["onboarding"]);
  const sandbox = recordOf(report["sandbox"]);
  const vcRuntime = recordOf(report["vcRuntime"]);
  const limits = recordOf(sandbox["limits"]);
  const workloads = recordOf(limits["workloads"]);
  const sandboxOptions = recordOf(sandbox["options"]);
  const optIns = Object.entries(SANDBOX_OPTION_FLAGS)
    .filter(([option]) => option !== "pinnedOff" && sandboxOptions[option] === true)
    .map(([, flag]) => flag);
  const video = recordOf(report["video"]);
  const disk = recordOf(report["disk"]);
  const problems = Array.isArray(integrity["problems"]) ? integrity["problems"].length : 0;
  const defaultTarget = recordOf(recordOf(models["workspaceDefault"])["target"]);
  const connections = Array.isArray(models["connections"]) ? models["connections"].length : 0;
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  // A turn an unclean stop cut off waits for the person: each is named with the step that frees it.
  const strandedReport = recordOf(report["strandedAdmissions"]);
  const stranded = Array.isArray(strandedReport["admissions"]) ? strandedReport["admissions"].map(recordOf) : undefined;
  // The running owner's trend: its latest sample, and any measure that kept growing.
  const trendNow = recordOf(health["now"]);
  const growth = Array.isArray(health["growth"]) ? health["growth"].map(recordOf) : [];
  const lines = [
    `Tavi ${String(report["buildId"] ?? "")}`,
    `${mark(node["ok"] === true)} Node ${String(node["version"] ?? "?")} (needs ${String(node["required"] ?? "?")})`,
    // Windows only: the native modules fail to load without it.
    ...(vcRuntime["ok"] === undefined
      ? []
      : vcRuntime["ok"] === true
        ? ["✓ Visual C++ runtime"]
        : [
            `✗ Visual C++ runtime: ${Array.isArray(vcRuntime["missing"]) ? vcRuntime["missing"].join(", ") : "?"} missing`,
            `    fix: ${String(vcRuntime["fix"] ?? "")}`,
          ]),
    // A database the owner holds is not checked here: not a failure, so no ✗.
    integrity["checked"] === true
      ? `${mark(integrity["ok"] === true)} Database: ${String(integrity["mode"])} check, ${problems === 0 ? "no problems" : `${problems} problem(s)`}`
      : "– Database: not checked (the owner holds it)",
    `${mark(Array.isArray(migrations["unknown"]) && migrations["unknown"].length === 0)} Migrations up to ${String(migrations["latest"] ?? "?")}`,
    `${fromOwner || health["running"] === true ? "✓ The owner is running" : "– No owner is running (tavi serve)"}`,
    ...(typeof trendNow["rssBytes"] === "number"
      ? [
          `${mark(growth.length === 0)} Owner health: ${Math.round(trendNow["rssBytes"] / (1024 * 1024))} MB memory` +
            `${typeof trendNow["openFds"] === "number" ? `, ${trendNow["openFds"]} open files` : ""}` +
            `${typeof trendNow["openHandles"] === "number" ? `, ${trendNow["openHandles"]} open handles` : ""}` +
            `, ${String(trendNow["children"] ?? 0)} child processes` +
            `${growth.length === 0 ? "" : `; ${growth.map((entry) => String(entry["warning"] ?? entry["metric"])).join("; ")}`}`,
        ]
      : []),
    ...(stranded === undefined
      ? []
      : stranded.length === 0
        ? ["✓ Stranded turns: none"]
        : [
            `✗ Stranded turns: ${stranded.length}${strandedReport["truncated"] === true ? "+" : ""}, ${stranded.length === 1 ? "a turn" : "turns"} an owner's stop cut off`,
            ...stranded.map((entry) => `    ${String(entry["taskId"])}: ${String(entry["remedy"] ?? "")}`),
          ]),
    `${mark(connections > 0)} Models: ${connections} connection(s)${defaultTarget["model"] === undefined ? ", no default" : `, default ${String(defaultTarget["connectionId"])}/${String(defaultTarget["model"])}`}`,
    `${mark(onboarding["complete"] === true)} Setup: ${onboarding["complete"] === true ? "the required steps are done" : "the model is not set up (tavi onboard)"}`,
    // A nested sandbox works, with less: degraded, not failed (as `tavi sandbox status` exits 0 for it).
    // The operator's off switch outranks the tier: shell commands are refused whatever the host could do.
    sandboxOptions["pinnedOff"] === true
      ? `– Sandbox: off (serve ${SANDBOX_OPTION_FLAGS.pinnedOff}, or TAVI_SANDBOX=off): shell commands are refused; this host could run ${String(sandbox["tier"] ?? "?")} (${String(sandbox["mechanism"] ?? "?")})`
      : `${sandbox["tier"] === "full" ? "✓" : sandbox["tier"] === "nested" ? "–" : "✗"} Sandbox: ${String(sandbox["tier"] ?? "?")} (${String(sandbox["mechanism"] ?? "?")})`,
    ...(typeof sandbox["cause"] === "string" ? [`    ${sandbox["cause"]}`] : []),
    ...(typeof sandbox["fix"] === "string" && sandbox["tier"] === "unavailable" ? [`    fix: ${sandbox["fix"]}`] : []),
    ...(Array.isArray(sandbox["hardening"]) ? sandbox["hardening"].map((hint) => `    hint: ${String(hint)}`) : []),
    ...(optIns.length === 0 ? [] : [`    started with ${optIns.join(", ")}`]),
    ...Object.entries(workloads).map(([workload, limit]) => `    ${workload}: ${String(limit)}`),
    ...(typeof limits["detail"] === "string" ? [`    ${limits["detail"]}`] : []),
    // On without FFmpeg, every video call fails: that needs the person, like a missing bubblewrap.
    `${video["enabled"] !== true ? "–" : mark(typeof video["ffmpeg"] === "string" && video["ffmpeg"] !== "missing")} Video: ${video["enabled"] === true ? `on, ffmpeg ${String(video["ffmpeg"] ?? "missing")}` : "off"}`,
    ...(typeof recordOf(report["taint"])["line"] === "string" ? [`  Taint: ${String(recordOf(report["taint"])["line"])}`] : []),
    ...(typeof recordOf(report["webSearch"])["line"] === "string"
      ? [`  Web search: ${String(recordOf(report["webSearch"])["line"])}`]
      : []),
    `${mark(disk["belowFloor"] !== true)} Disk: ${typeof disk["freeBytes"] === "number" ? `${Math.round(disk["freeBytes"] / 1024 ** 3)} GiB free` : "unknown"}`,
    "",
    "The whole report: tavi doctor --format json",
  ];
  return `${lines.join("\n")}\n`;
}
