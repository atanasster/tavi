import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import { killLadder, requireJob, watchRss, type Watchdog } from "@tavi/child-kit";
import {
  LIMITS_ENTRY_FAILED_EXIT,
  PDF_FRAME,
  PDF_LIMITS,
  PdfChildResponseSchema,
  PdfOcrResponseSchema,
  maxFilledBytes,
  type PdfChildLimits,
  type PdfChildRequest,
  type PdfEnginePort,
  type PdfFailure,
  type PdfOcrAssets,
  type PdfOcrResult,
  type PdfOperation,
  type PdfRefusedLaunch,
  type PdfRunResult,
  type PdfSandbox,
} from "@tavi/contracts";
import { sha256Hex, systemChildEnv } from "@tavi/node-kit";

import { coreFont, pdfiumWasm } from "./assets.js";
import { readWithOcr } from "./ocr.js";
import { ChunkReader, encodeInit, encodeOcrRequest, encodeRequest, FrameError, readResponse } from "./protocol.js";

/**
 * The owner side of the PDF parser: one
 * single-use child per document, spawned through the owner's confinement
 * (srt's CLI, with no network and no writable path), bounded by an RSS
 * watchdog and a wall clock, its
 * answer read section by section within each section's cap and parsed as
 * untrusted. One child may wait warm, its wasm compiled and no document.
 */

export { coreFont, coreFontPath, pdfiumWasm, pdfiumWasmPath } from "./assets.js";

export interface PdfServiceOptions {
  readonly sandbox: PdfSandbox;
  readonly limits?: Partial<Record<keyof typeof PDF_LIMITS, number>>;
  /** Children at once; more calls wait (1 on the small-server preset). */
  readonly concurrency?: number;
  /** Keep one child warm between calls (off on the small-server preset). */
  readonly warm?: boolean;
  /** A warm child unused this long is stopped. */
  readonly idleMs?: number;
  /** How long a document that killed a child is refused. */
  readonly refuseKilledForMs?: number;
  /** The child's entry; the package's built one by default. */
  readonly childPath?: string;
  readonly now?: () => number;
  /**
   * The OCR add-on's files, when the owner found it installed: `ocr`
   * runs its Tesseract in a second single-use child, which may read their
   * directory. This package never looks for the add-on itself.
   */
  readonly ocr?: PdfOcrAssets;
  /** The OCR child's entry; the package's built one by default. */
  readonly ocrChildPath?: string;
  /** Told when a child starts and ends (for `doctor`, usage and tests). */
  readonly observe?: (event: { readonly kind: "spawn" | "exit"; readonly pid: number | undefined }) => void;
}

/** The built-in engine: the port's own `PdfEnginePort`, by the name this package has always given it. */
export type PdfService = PdfEnginePort;
export type {
  PdfFailure,
  PdfLaunch,
  PdfOcrAssets,
  PdfOcrResult,
  PdfOperation,
  PdfReadOcr,
  PdfRunResult,
  PdfSandbox,
} from "@tavi/contracts";

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

interface Spawned {
  readonly child: Child;
  readonly reader: ChunkReader;
  readonly exited: Promise<void>;
  /** Once exited: whether its cgroup ended it out of memory (Linux, with resource limits). */
  readonly outOfMemory: () => boolean;
  /** Once exited: whether it never ran, failing to enter its cgroup (the document is not to blame). */
  readonly unentered: () => boolean;
  /** Every process in its cgroup, where it has one: the kill ladder's last step. */
  readonly killGroup?: () => void;
}

/** The single-use child's entry: built next to this module, or, run from source, in the package's `dist/`. */
export function defaultChildPath(): string {
  return builtEntry("child.mjs");
}

/** The OCR child's entry, found as the parser child's is. */
export function defaultOcrChildPath(): string {
  return builtEntry("ocr-child.mjs");
}

function builtEntry(name: string): string {
  const beside = join(import.meta.dirname, name);
  return existsSync(beside) ? beside : join(import.meta.dirname, "..", "dist", name);
}

export function createPdfService(options: PdfServiceOptions): PdfEnginePort {
  const limits: Record<keyof typeof PDF_LIMITS, number> = { ...PDF_LIMITS, ...options.limits };
  const childLimits: PdfChildLimits = {
    maxPages: limits.maxPages,
    maxFields: limits.maxFields,
    maxPixelsPerPage: limits.maxPixelsPerPage,
    textPerCall: limits.textPerCall,
    pagesPerTextCall: limits.pagesPerTextCall,
  };
  const childPath = options.childPath ?? defaultChildPath();
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const warmEnabled = options.warm ?? true;
  const idleMs = options.idleMs ?? 5 * 60_000;
  const refuseFor = options.refuseKilledForMs ?? 24 * 60 * 60_000;
  const now = options.now ?? Date.now;
  const killed = new Map<string, { readonly until: number; readonly failure: PdfFailure }>();
  // The most a child may write: one answer's sections at their caps, and their prefixes.
  const maxAnswerBytes = PDF_FRAME.maxJsonBytes + PDF_FRAME.maxPngBytes + PDF_FRAME.maxDocumentBytes + 64 * 1024;
  /** Each child running, with its cgroup kill where it has one. */
  const running = new Map<Child, (() => void) | undefined>();
  let warm: { readonly spawned: Spawned; readonly timer: NodeJS.Timeout } | undefined;
  let active = 0;
  const queue: (() => void)[] = [];
  let closed = false;

  /** A child's launch: the parser, or the OCR child with the add-on's files as arguments and their directory to read. */
  const command = (
    entry: string,
    extra: readonly string[] = [],
    roots: readonly string[] = [],
  ):
    | {
        readonly command: string;
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string>>;
        readonly cwd: string;
        readonly onExit?: () => "oom" | undefined;
        readonly kill?: () => void;
      }
    | PdfRefusedLaunch => {
    const argv = [process.execPath, `--max-old-space-size=${limits.childHeapMb}`, entry, ...extra];
    const env: Record<string, string> = {
      ...systemChildEnv([dirname(process.execPath)]),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    const cwd = dirname(entry);
    if (options.sandbox.kind === "none") return { command: argv[0] as string, args: argv.slice(1), env, cwd };
    const wrapped = options.sandbox.wrap({ argv, env, readRoots: [dirname(dirname(entry)), ...roots] });
    return "refused" in wrapped ? wrapped : { ...wrapped, cwd };
  };

  /** `init` null: a child that reads no initialization frame (the OCR child). Refused by the confinement: nothing is spawned. */
  const spawnChild = (
    entry: string = childPath,
    extra: readonly string[] = [],
    init: Uint8Array | null = encodeInit(pdfiumWasm()),
    roots: readonly string[] = [],
  ): Spawned | PdfRefusedLaunch => {
    const launch = command(entry, extra, roots);
    if ("refused" in launch) return launch;
    const child = spawn(launch.command, [...launch.args], {
      env: { ...launch.env },
      cwd: launch.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own group to end whole; on Windows, its own Job Object.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    requireJob(child);
    running.set(child, launch.kill);
    options.observe?.({ kind: "spawn", pid: child.pid });
    const reader = new ChunkReader(maxAnswerBytes);
    child.stdout.on("data", (chunk: Buffer) => reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)));
    child.stdout.on("end", () => reader.end());
    // The child's diagnostics are its own and may quote the document: read and dropped.
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    // `close`, not `exit`: the last bytes of an answer may still be in the pipe at `exit`.
    let outOfMemory = false;
    let unentered = false;
    child.once("exit", (code) => {
      unentered = code === LIMITS_ENTRY_FAILED_EXIT;
    });
    const exited = new Promise<void>((resolve) => {
      const done = (): void => {
        if (!running.delete(child)) return;
        // Its cgroup (where there is one) is released, and says whether it ended the child.
        outOfMemory = launch.onExit?.() === "oom";
        reader.end();
        options.observe?.({ kind: "exit", pid: child.pid });
        resolve();
      };
      child.once("close", done);
      child.once("error", done);
    });
    if (init !== null) child.stdin.write(init);
    return {
      child,
      reader,
      exited,
      outOfMemory: () => outOfMemory,
      unentered: () => unentered,
      ...(launch.kill === undefined ? {} : { killGroup: launch.kill }),
    };
  };

  const stopWarm = (): Spawned | undefined => {
    const current = warm;
    warm = undefined;
    if (current === undefined) return undefined;
    clearTimeout(current.timer);
    return current.spawned;
  };

  const prewarm = (): void => {
    if (!warmEnabled || closed || warm !== undefined) return;
    let spawned: Spawned;
    try {
      const started = spawnChild();
      // Not allowed to run here (the sandbox is unavailable): no child waits, and each call is refused as it comes.
      if ("refused" in started) return;
      spawned = started;
    } catch {
      // No room for a warm child now (its cgroup would not fit): the next call starts its own.
      return;
    }
    const timer = setTimeout(() => {
      const idle = stopWarm();
      if (idle !== undefined) void killLadder(idle.child, undefined, idle.killGroup);
    }, idleMs);
    timer.unref();
    warm = { spawned, timer };
    void spawned.exited.then(() => {
      if (warm?.spawned === spawned) stopWarm();
    });
  };

  const acquire = async (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return;
    }
    // A woken call holds the slot it was handed; `close` wakes every waiter.
    await new Promise<void>((resolve) => queue.push(resolve));
  };

  const release = (): void => {
    const next = queue.shift();
    if (next !== undefined) next();
    else active -= 1;
  };

  const run = async (operation: PdfOperation, document: Uint8Array, fonts: readonly Uint8Array[] = []): Promise<PdfRunResult> => {
    if (closed) return { ok: false, failure: "crashed" };
    if (document.length > limits.maxInputBytes) return { ok: false, refused: "too-large" };
    // The request is the owner's own: one it cannot frame (too many fonts) fails this call, not the document.
    let frame: Uint8Array;
    try {
      frame = encodeRequest({ ...operation, limits: childLimits } as PdfChildRequest, document, fonts);
    } catch {
      return { ok: false, failure: "protocol" };
    }
    const sha256 = sha256Hex(document);
    const before = killed.get(sha256);
    if (before !== undefined && before.until > now()) return { ok: false, failure: before.failure };
    if (before !== undefined) killed.delete(sha256);
    await acquire();
    if (closed) {
      release();
      return { ok: false, failure: "crashed" };
    }
    const started = now();
    let spawned: Spawned;
    try {
      const launched = stopWarm() ?? spawnChild();
      // Refused by the confinement before any child: a refusal, not a failure, so the document is not refused for a day.
      if ("refused" in launched) {
        release();
        return { ok: false, refused: launched.refused };
      }
      spawned = launched;
    } catch (error) {
      // Refused before it ran (no room under the sandboxes' memory cap): the slot is given back, the document is not refused.
      release();
      throw error;
    }
    let why: PdfFailure | undefined;
    // Whether the document is refused for a day when this call fails: not for an answer past the owner's own estimate.
    let remember = true;
    const kill = (reason: PdfFailure): void => {
      why ??= reason;
      void killLadder(spawned.child, undefined, spawned.killGroup);
    };
    const pid = spawned.child.pid;
    const watchdog: Watchdog | undefined = pid === undefined ? undefined : watchRss(pid, limits.childRssMb * 1024, () => kill("memory"));
    const heavy = operation.op === "fill" || operation.op === "overlay" || operation.op === "render";
    const timer = setTimeout(() => kill("timeout"), heavy ? limits.heavyTimeoutMs : limits.timeoutMs);
    timer.unref();
    try {
      spawned.child.stdin.end(frame);
      const parts = await readResponse(
        spawned.reader,
        operation.op === "fill" || operation.op === "overlay" ? maxFilledBytes(document.length) : 0,
      ).finally(() => {
        // One answer per child: whatever it writes after it is not read, and not kept.
        spawned.child.stdout.destroy();
      });
      const parsed = PdfChildResponseSchema.safeParse(parts.json);
      if (!parsed.success) {
        kill("protocol");
        return { ok: false, failure: "protocol" };
      }
      await spawned.exited;
      if (why !== undefined) return { ok: false, failure: why };
      const answer = parsed.data;
      if (!answer.ok) return { ok: false, refused: answer.refused, ...(answer.field === undefined ? {} : { field: answer.field }) };
      return {
        ok: true,
        answer,
        pngs: parts.pngs,
        document: parts.document,
        peakKb: Math.max(watchdog?.peakKb() ?? 0, answer.maxRssKb),
        wallMs: now() - started,
      };
    } catch (error) {
      // A frame past a section's cap may be a filled copy larger than the owner's estimate: that call fails, the document is not refused.
      if (error instanceof FrameError) remember = false;
      kill(error instanceof FrameError ? "protocol" : "crashed");
      await spawned.exited;
      // A child its cgroup ended out of memory was over its cap, not crashed.
      if (spawned.outOfMemory()) why = "memory";
      // One that never ran (it could not enter its cgroup) says nothing about the document.
      if (spawned.unentered()) remember = false;
      return { ok: false, failure: why ?? "crashed" };
    } finally {
      clearTimeout(timer);
      watchdog?.stop();
      // Killed, crashed, or answering out of protocol (an answer of the wrong shape): refused for a day.
      if (why !== undefined && remember) {
        killed.set(sha256, { until: now() + refuseFor, failure: why });
        // Bounded: expired refusals go, then the oldest, past a thousand documents.
        if (killed.size > 1_000) for (const [key, entry] of killed) if (entry.until <= now() || killed.size > 1_000) killed.delete(key);
      }
      release();
      prewarm();
    }
  };

  // Absolute: the child requires the glue by path, and the sandbox is given the directory as a read root.
  const ocrAssets =
    options.ocr === undefined
      ? undefined
      : {
          directory: resolve(options.ocr.directory),
          core: resolve(options.ocr.core),
          wasm: resolve(options.ocr.wasm),
          eng: resolve(options.ocr.languages.eng),
        };
  const ocrChildPath = options.ocrChildPath ?? defaultOcrChildPath();

  const ocr = async (
    images: readonly { readonly page: number; readonly png: Uint8Array }[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PdfOcrResult> => {
    if (ocrAssets === undefined) return { ok: false, refused: "no-ocr" };
    if (images.length === 0) return { ok: true, pages: [], peakKb: 0, wallMs: 0 };
    if (images.length > limits.ocrPagesPerCall || images.reduce((sum, image) => sum + image.png.length, 0) > PDF_FRAME.maxPngBytes)
      return { ok: false, refused: "too-large" };
    if (closed) return { ok: false, failure: "crashed" };
    await acquire();
    if (closed) {
      release();
      return { ok: false, failure: "crashed" };
    }
    if (options.signal?.aborted === true) {
      release();
      return { ok: false, failure: "timeout" };
    }
    const started = now();
    // Its own child, never the warm parser: Tesseract's memory is kept apart from PDFium's.
    let spawned: Spawned;
    try {
      const launched = spawnChild(ocrChildPath, [ocrAssets.core, ocrAssets.wasm, ocrAssets.eng], null, [ocrAssets.directory]);
      if ("refused" in launched) {
        release();
        return { ok: false, refused: launched.refused };
      }
      spawned = launched;
    } catch (error) {
      release();
      throw error;
    }
    let why: PdfFailure | undefined;
    const kill = (reason: PdfFailure): void => {
      why ??= reason;
      void killLadder(spawned.child, undefined, spawned.killGroup);
    };
    const pid = spawned.child.pid;
    const watchdog: Watchdog | undefined = pid === undefined ? undefined : watchRss(pid, limits.childRssMb * 1024, () => kill("memory"));
    const timer = setTimeout(() => kill("timeout"), limits.heavyTimeoutMs);
    timer.unref();
    // A caller that gave up ends the child now, not at the engine's own cap.
    const givenUp = (): void => kill("timeout");
    options.signal?.addEventListener("abort", givenUp, { once: true });
    try {
      const requested = images.map((image) => image.page);
      spawned.child.stdin.end(encodeOcrRequest({ op: "ocr", language: "eng", pages: requested }, images));
      const parts = await readResponse(spawned.reader, 0).finally(() => spawned.child.stdout.destroy());
      const parsed = PdfOcrResponseSchema.safeParse(parts.json);
      if (!parsed.success) {
        kill("protocol");
        return { ok: false, failure: "protocol" };
      }
      await spawned.exited;
      if (why !== undefined) return { ok: false, failure: why };
      const answer = parsed.data;
      if (!answer.ok) return { ok: false, refused: answer.refused };
      // The child answers the pages it was sent, in order, or it is out of bounds.
      if (answer.pages.length !== requested.length || answer.pages.some((page, index) => page.page !== requested[index]))
        return { ok: false, failure: "protocol" };
      return { ok: true, pages: answer.pages, peakKb: Math.max(watchdog?.peakKb() ?? 0, answer.maxRssKb), wallMs: now() - started };
    } catch (error) {
      kill(error instanceof FrameError ? "protocol" : "crashed");
      await spawned.exited;
      if (spawned.outOfMemory()) why = "memory";
      return { ok: false, failure: why ?? "crashed" };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", givenUp);
      watchdog?.stop();
      release();
    }
  };

  const engine: PdfEnginePort = {
    run,
    readWithOcr: (document, read) => readWithOcr(engine, document, read),
    ocrAvailable: ocrAssets !== undefined,
    ocr,
    coreFonts: () => [coreFont()],
    prewarm,
    close: async () => {
      closed = true;
      stopWarm();
      for (const waiter of queue.splice(0)) {
        active += 1;
        waiter();
      }
      await Promise.all([...running].map(([child, killGroup]) => killLadder(child, undefined, killGroup)));
    },
  };
  return engine;
}

/** The fonts a fill sends: the core font, then any a font add-on adds (none is built yet). */
export function fillFonts(addOns: readonly Uint8Array[] = []): Uint8Array[] {
  return [coreFont(), ...addOns];
}
