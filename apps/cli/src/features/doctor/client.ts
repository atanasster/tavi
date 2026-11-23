import { emitJson, isTextOutput } from "../../cli/output.js";
import { EXIT, reportFailure } from "../../cli/exit.js";
import type { TaviRuntime } from "../../runtime/types.js";
import { buildDoctorDocument, type DoctorDocument } from "./reports.js";
import { resolveDataDirectory } from "../../shared/data-directory.js";
import type { CliIo } from "../../cli/io.js";
import { attachToOwner } from "../../cli/owner.js";
import type { RuntimeFactory } from "../../cli/runtime-options.js";
import { replacementsInWords, replacementsOf } from "../models/replacements.js";
import { SANDBOX_OPTION_FLAGS } from "../sandbox/setup.js";
import { ownerWords, storeWords } from "../../shared/terminal-words.js";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

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
      async (result, client) => printDoctor(io, result as DoctorDocument, true, isTextOutput(io) ? await ownerWords(client) : coreEnglish),
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
    printDoctor(io, report, false, isTextOutput(io) ? await storeWords(runtime.store) : coreEnglish);
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
function printDoctor(io: CliIo, report: DoctorDocument, fromOwner: boolean, t: CoreT): void {
  if (isTextOutput(io)) io.stdout(doctorSummary(report, fromOwner, t));
  else emitJson(io, report);
}

/** One of the report's records, or an empty one. */
const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * `tavi doctor --format text`: a line per check a person reads first — Node,
 * the database, migrations, the owner, models, onboarding, the sandbox and its
 * limits, video, taint and web search, disk — and where the whole report is.
 * Said in `t`'s language; what the owner or the host reports in its own words
 * (a cause, a fix, a remedy, a warning) is shown as it came.
 */
export function doctorSummary(report: DoctorDocument, fromOwner = false, t: CoreT = coreEnglish): string {
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
  const fix = (how: unknown): string => `    ${t("cli.doctor.fix", { fix: String(how ?? "") })}`;
  const lines = [
    `Tavi ${String(report["buildId"] ?? "")}`,
    `${mark(node["ok"] === true)} ${t("cli.doctor.node", { version: String(node["version"] ?? "?"), required: String(node["required"] ?? "?") })}`,
    // Windows only: the native modules fail to load without it.
    ...(vcRuntime["ok"] === undefined
      ? []
      : vcRuntime["ok"] === true
        ? [`✓ ${t("cli.doctor.vcRuntime")}`]
        : [
            `✗ ${t("cli.doctor.vcRuntimeMissing", { missing: Array.isArray(vcRuntime["missing"]) ? vcRuntime["missing"].join(", ") : "?" })}`,
            fix(vcRuntime["fix"]),
          ]),
    // A database the owner holds is not checked here: not a failure, so no ✗.
    integrity["checked"] === true
      ? `${mark(integrity["ok"] === true)} ${t("cli.doctor.database", {
          mode: String(integrity["mode"]),
          problems: problems === 0 ? t("cli.doctor.noProblems") : t("cli.doctor.problems", { n: String(problems), count: problems }),
        })}`
      : `– ${t("cli.doctor.databaseHeld")}`,
    `${mark(Array.isArray(migrations["unknown"]) && migrations["unknown"].length === 0)} ${t("cli.doctor.migrations", { latest: String(migrations["latest"] ?? "?") })}`,
    fromOwner || health["running"] === true ? `✓ ${t("cli.doctor.ownerRunning")}` : `– ${t("cli.doctor.noOwner")}`,
    ...(typeof trendNow["rssBytes"] === "number"
      ? [
          `${mark(growth.length === 0)} ${t("cli.doctor.health", { mb: String(Math.round(trendNow["rssBytes"] / (1024 * 1024))) })}` +
            `${typeof trendNow["openFds"] === "number" ? `, ${t("cli.doctor.openFiles", { n: String(trendNow["openFds"]) })}` : ""}` +
            `${typeof trendNow["openHandles"] === "number" ? `, ${t("cli.doctor.openHandles", { n: String(trendNow["openHandles"]) })}` : ""}` +
            `, ${t("cli.doctor.children", { n: String(trendNow["children"] ?? 0) })}` +
            `${growth.length === 0 ? "" : `; ${growth.map((entry) => String(entry["warning"] ?? entry["metric"])).join("; ")}`}`,
        ]
      : []),
    ...(stranded === undefined
      ? []
      : stranded.length === 0
        ? [`✓ ${t("cli.doctor.strandedNone")}`]
        : [
            `✗ ${t("cli.doctor.stranded", {
              n: `${stranded.length}${strandedReport["truncated"] === true ? "+" : ""}`,
              count: stranded.length,
            })}`,
            ...stranded.map((entry) => `    ${String(entry["taskId"])}: ${String(entry["remedy"] ?? "")}`),
          ]),
    `${mark(connections > 0)} ${t("cli.doctor.models", {
      connections: t("cli.doctor.connections", { n: String(connections), count: connections }),
      default:
        defaultTarget["model"] === undefined
          ? t("cli.doctor.noDefault")
          : t("cli.doctor.default", { model: `${String(defaultTarget["connectionId"])}/${String(defaultTarget["model"])}` }),
    })}`,
    ...lifecycleLines(recordOf(models["lifecycle"]), t),
    `${mark(onboarding["complete"] === true)} ${t(onboarding["complete"] === true ? "cli.doctor.setupDone" : "cli.doctor.setupOpen")}`,
    // A nested sandbox works, with less: degraded, not failed (as `tavi sandbox status` exits 0 for it).
    // The operator's off switch outranks the tier: shell commands are refused whatever the host could do.
    sandboxOptions["pinnedOff"] === true
      ? `– ${t("cli.doctor.sandboxOff", {
          flag: SANDBOX_OPTION_FLAGS.pinnedOff,
          tier: String(sandbox["tier"] ?? "?"),
          mechanism: String(sandbox["mechanism"] ?? "?"),
        })}`
      : `${sandbox["tier"] === "full" ? "✓" : sandbox["tier"] === "nested" ? "–" : "✗"} ${t("cli.doctor.sandbox", {
          tier: String(sandbox["tier"] ?? "?"),
          mechanism: String(sandbox["mechanism"] ?? "?"),
        })}`,
    ...(typeof sandbox["cause"] === "string" ? [`    ${sandbox["cause"]}`] : []),
    ...(typeof sandbox["fix"] === "string" && sandbox["tier"] === "unavailable" ? [fix(sandbox["fix"])] : []),
    ...(Array.isArray(sandbox["hardening"])
      ? sandbox["hardening"].map((hint) => `    ${t("cli.doctor.hint", { hint: String(hint) })}`)
      : []),
    ...(optIns.length === 0 ? [] : [`    ${t("cli.doctor.startedWith", { flags: optIns.join(", ") })}`]),
    ...Object.entries(workloads).map(([workload, limit]) => `    ${workload}: ${String(limit)}`),
    ...(typeof limits["detail"] === "string" ? [`    ${limits["detail"]}`] : []),
    // On without FFmpeg, every video call fails: that needs the person, like a missing bubblewrap.
    `${video["enabled"] !== true ? "–" : mark(typeof video["ffmpeg"] === "string" && video["ffmpeg"] !== "missing")} ${
      video["enabled"] === true ? t("cli.doctor.videoOn", { ffmpeg: String(video["ffmpeg"] ?? "missing") }) : t("cli.doctor.videoOff")
    }`,
    ...transcriptionLine(video, t),
    ...(typeof recordOf(report["taint"])["line"] === "string"
      ? [`  ${t("cli.doctor.taint", { line: String(recordOf(report["taint"])["line"]) })}`]
      : []),
    ...(typeof recordOf(report["webSearch"])["line"] === "string"
      ? [`  ${t("cli.doctor.webSearch", { line: String(recordOf(report["webSearch"])["line"]) })}`]
      : []),
    `${mark(disk["belowFloor"] !== true)} ${t("cli.doctor.disk", {
      free:
        typeof disk["freeBytes"] === "number"
          ? t("cli.doctor.diskFree", { n: String(Math.round(disk["freeBytes"] / 1024 ** 3)) })
          : t("cli.doctor.unknown"),
    })}`,
    "",
    t("cli.doctor.whole"),
  ];
  return `${lines.join("\n")}\n`;
}

/** Doctor's transcription line, for video speech and voice messages alike: ✓ ready, – with why none can run. */
function transcriptionLine(video: Record<string, unknown>, t: CoreT): string[] {
  const transcription = recordOf(video["analyzers"])["transcription"];
  if (video["enabled"] !== true || typeof transcription !== "string") return [];
  return [`${transcription === "ready" ? "✓" : "–"} ${t("cli.doctor.transcription", { state: transcription })}`];
}

/**
 * Doctor's model lifecycle lines: ✗ only when a model in use is retired; –
 * while one warns, one is unchecked, the check is stale or partial, nothing
 * was synced, or the rows could not be read; ✓ otherwise. Then a line per warning.
 */
function lifecycleLines(lifecycle: Record<string, unknown>, t: CoreT): string[] {
  if (typeof lifecycle["problem"] === "string") return [`– ${t("cli.doctor.lifecycle.unread", { problem: lifecycle["problem"] })}`];
  if (lifecycle["checkedAt"] === undefined) return [];
  if (lifecycle["checkedAt"] === null)
    return [`– ${t("cli.doctor.lifecycle.unchecked", { hint: String(lifecycle["hint"] ?? "tavi models sync") })}`];
  const warnings = Array.isArray(lifecycle["warnings"]) ? lifecycle["warnings"].map(recordOf) : [];
  const unchecked = Array.isArray(lifecycle["unchecked"]) ? lifecycle["unchecked"].map(String) : [];
  const unread = Array.isArray(lifecycle["unread"]) ? lifecycle["unread"].length : 0;
  const retired = warnings.some((warning) => warning["level"] === "error");
  const gaps = [
    ...(lifecycle["stale"] === true ? [t("cli.doctor.lifecycle.stale")] : []),
    ...(unchecked.length === 0 ? [] : [t("cli.doctor.lifecycle.notYet", { models: unchecked.join(", ") })]),
    ...(unread === 0 ? [] : [t("cli.doctor.lifecycle.sourcesUnread", { n: String(unread), count: unread })]),
  ];
  const head =
    warnings.length === 0
      ? t("cli.doctor.lifecycle.fine")
      : t(retired ? "cli.doctor.lifecycle.retired" : "cli.doctor.lifecycle.warnings", {
          n: String(warnings.length),
          count: warnings.length,
        });
  return [
    `${retired ? "✗" : warnings.length > 0 || gaps.length > 0 ? "–" : "✓"} ${t("cli.doctor.lifecycle.head", {
      head,
      date: String(lifecycle["checkedAt"]).slice(0, 10),
    })}`,
    ...gaps.map((gap) => `    ${gap}`),
    ...warnings.flatMap((warning) => {
      const replace = replacementsInWords(replacementsOf(warning["replacements"]));
      return [
        `    ${String(warning["connectionId"])}/${String(warning["model"])}: ${Array.isArray(warning["says"]) ? warning["says"].join("; ") : ""}`,
        ...(replace === undefined ? [] : [`      ${replace}`]),
      ];
    }),
  ];
}
