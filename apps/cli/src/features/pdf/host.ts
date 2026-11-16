import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  PDF_LIMITS,
  type ConfinementPort,
  type PdfEnginePort,
  type PdfLaunch,
  type PdfOcrAssets,
  type PdfSandbox,
  type ResourceLimitPort,
  type SandboxHostPort,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import { createPdfService } from "@tavi/plugin-pdf/host";

/**
 * Where the owner puts the PDF modules together: the engine (`@tavi/plugin-pdf`, or an override), its confinement
 * (the owner's `ConfinementPort`, from `features/sandbox/host.ts`), and the OCR add-on (`@tavi/pdf-ocr`) when it is
 * installed. This module alone names more than one of them: the engine never
 * imports the sandbox or the add-on, and the PDF tools use the engine only
 * through `PdfEnginePort`.
 */

export interface PdfHostOptions {
  /** `serve --pdf-allow-unconfined`: on a host whose sandbox is unavailable, run the PDF children bare rather than refuse. */
  readonly allowUnconfined?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly host?: SandboxHostPort;
  readonly limits?: ResourceLimitPort;
}

/**
 * How the engine's children are confined:
 * under srt, with no network, nothing writable, and the person's home and
 * Tavi's data unreadable but for Node, the engine's package and, for the OCR
 * child, the add-on's directory. On macOS always; on Linux whenever the host's
 * tier lets a sandbox run (srt's nested mode where the owner runs nested).
 * While it is `unavailable` (and on a platform srt cannot confine at all), a
 * launch is refused (`unconfined`) before any child starts, unless the owner
 * started `serve` with `--pdf-allow-unconfined`, when it runs bare (`doctor`
 * says which, with the sandbox's fix). Each set of read roots, in each mode,
 * has its own policy file (the confinement writes it whole): the parser and
 * the OCR child each get theirs.
 */
export function pdfSandbox(dataDirectory: string, confinement: ConfinementPort, options: PdfHostOptions = {}): PdfSandbox {
  const platform = options.platform ?? process.platform;
  // Where srt cannot confine at all (neither macOS nor Linux), a launch is as unconfinable as on Linux without a sandbox.
  const confines = platform === "darwin" || platform === "linux";
  const denied = [homedir(), dataDirectory];
  const policyDirectory = join(dataDirectory, "pdf");
  return {
    kind: "wrapped",
    wrap: (launch: PdfLaunch) => {
      const tier = !confines ? "unavailable" : platform === "linux" ? (options.host?.current().tier ?? "unavailable") : "full";
      // Read at each launch: a host fixed (or broken) since start is followed without a restart.
      if (tier === "unavailable" && options.allowUnconfined !== true) return { refused: "unconfined" };
      const wrapped =
        tier === "unavailable"
          ? { command: launch.argv[0] ?? process.execPath, args: launch.argv.slice(1), env: launch.env }
          : (() => {
              const nested = tier === "nested";
              const roots = [...new Set(launch.readRoots)].sort();
              const key = sha256Hex(JSON.stringify({ roots, nested })).slice(0, 16);
              mkdirSync(policyDirectory, { recursive: true, mode: 0o700 });
              return confinement.wrap({
                argv: launch.argv,
                env: launch.env,
                policyFile: join(policyDirectory, `srt-${key}.json`),
                policy: { denyRead: denied, allowRead: roots, allowWrite: [], domains: [], nested },
              });
            })();
      // Its own cgroup, confined or bare: the RSS watchdog's cap with room for page cache, and 64 pids.
      const limits = options.limits;
      if (limits === undefined) return wrapped;
      const { argv, groupId } = limits.place([wrapped.command, ...wrapped.args], "pdf", {
        memoryBytes: (PDF_LIMITS.childRssMb + 64) * 1024 * 1024,
      });
      return {
        command: argv[0] as string,
        args: argv.slice(1),
        env: wrapped.env,
        ...(groupId === undefined
          ? {}
          : {
              onExit: () => {
                const outcome = limits.outcome(groupId);
                limits.release(groupId);
                return outcome;
              },
              // The kill ladder's SIGKILL reaches the whole cgroup (`cgroup.kill`), not only the process group.
              kill: () => limits.kill(groupId),
            }),
      };
    },
  };
}

/**
 * How the PDF children run on this host now (`doctor`): confined by srt, refused while the sandbox is unavailable
 * here, or bare by the owner's choice (`serve --pdf-allow-unconfined`).
 */
export function pdfConfinement(options: Omit<PdfHostOptions, "limits"> = {}): "srt" | "refused" | "unconfined" {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return "srt";
  // As the wrap decides: srt unless the tier is `unavailable` (a call waits for the first answer; past that wait, srt is tried).
  if (platform === "linux" && options.host !== undefined && options.host.current().tier !== "unavailable") return "srt";
  return options.allowUnconfined === true ? "unconfined" : "refused";
}

/**
 * The OCR add-on's files (`@tavi/pdf-ocr`) when it is installed beside
 * Tavi; undefined when it is not, and `pdf.read` leaves scans as images.
 */
export async function pdfOcrAssets(): Promise<PdfOcrAssets | undefined> {
  let addOn: { readonly ocrAssets: () => PdfOcrAssets };
  try {
    addOn = await import("@tavi/pdf-ocr");
  } catch (error) {
    // Not installed is the ordinary case; anything else (a broken install) is the owner's to see.
    if ((error as { readonly code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
  return addOn.ocrAssets();
}

/** The owner's PDF engine: the built-in one, confined, with the OCR add-on when it is installed. */
export function createPdfEngine(
  dataDirectory: string,
  ocr: PdfOcrAssets | undefined,
  confinement: ConfinementPort,
  options: Omit<PdfHostOptions, "platform"> = {},
): PdfEnginePort {
  const engine = createPdfService({
    sandbox: pdfSandbox(dataDirectory, confinement, options),
    ...(ocr === undefined ? {} : { ocr }),
  });
  return options.host === undefined ? engine : settledPdfEngine(engine, options.host);
}

/** How long a PDF call waits for the sandbox's first answer before it goes ahead as the tier then stands. */
const SETTLE_WAIT_MS = 20_000;

/**
 * The engine, holding a call that would start a child until the sandbox's first answer on Linux. While the host is
 * still `checking`, the wrap tries srt: on a host whose sandbox does not work the child fails as a crash, and the
 * document is refused for a day, though `--pdf-allow-unconfined` would have run it. Every call that arrives meanwhile
 * waits for one shared probe, at most `waitMs`; elsewhere, and once settled, calls go straight through.
 */
export function settledPdfEngine(
  engine: PdfEnginePort,
  host: SandboxHostPort,
  options: { readonly platform?: NodeJS.Platform; readonly waitMs?: number } = {},
): PdfEnginePort {
  if ((options.platform ?? process.platform) !== "linux") return engine;
  const waitMs = options.waitMs ?? SETTLE_WAIT_MS;
  let settling: Promise<void> | undefined;
  let closed = false;
  const settled = async (): Promise<void> => {
    if (host.current().tier !== "checking") return;
    settling ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A probe that throws settles `unavailable` in the host; one that hangs leaves `checking`, and srt is tried.
        await Promise.race([
          host.check().catch(() => undefined),
          new Promise<void>((done) => {
            timer = setTimeout(done, waitMs);
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
        settling = undefined;
      }
    })();
    await settling;
  };
  return {
    get ocrAvailable() {
      return engine.ocrAvailable;
    },
    run: async (operation, document, fonts) => {
      await settled();
      return await engine.run(operation, document, fonts);
    },
    readWithOcr: async (document, readOptions) => {
      await settled();
      return await engine.readWithOcr(document, readOptions);
    },
    ocr: async (images, ocrOptions) => {
      await settled();
      return await engine.ocr(images, ocrOptions);
    },
    coreFonts: () => engine.coreFonts(),
    prewarm: () => {
      if (host.current().tier !== "checking") return engine.prewarm();
      // Warmed once the tier is known, unless the engine was closed meanwhile.
      void settled().then(() => {
        if (!closed) engine.prewarm();
      });
    },
    close: async () => {
      closed = true;
      await engine.close();
    },
  };
}
