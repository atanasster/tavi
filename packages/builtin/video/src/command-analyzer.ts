import type { ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  ANALYZER_ERRORS,
  ANALYZER_FALLBACK_ERRORS,
  ANALYZER_RESULT_SCHEMAS,
  CAPABILITY_OUTPUT,
  LIMITS_ENTRY_FAILED_EXIT,
  VIDEO_LIMITS,
  type AnalyzeOutcome,
  type AnalyzeRequest,
  type AnalyzeResult,
  type AnalyzerEntry,
  type AnalyzerErrorCode,
  type AnalyzerManifest,
  type VideoAnalyzerPort,
  type VideoCapability,
  type VideoSandbox,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { z } from "zod";

import { readOutputFile } from "./decoder.js";
import { sizeOf, supervise } from "./supervise.js";
import { systemChildEnv } from "@tavi/node-kit";

/**
 * The command analyser: a
 * command the owner configured in `analyzers.json` (the person's own
 * MediaPipe script, a whisper build, anything), run once per request under
 * the same confinement as the decoder, inside the request's run directory.
 *
 * - Its arguments come from the owner's template; a placeholder is a whole
 *   argument (`{{framesDir}}`, `{{audio}}`, `{{outDir}}`, `{{options}}`),
 *   never interpolated into another, and there is no shell.
 * - It is handed decoded frames or audio by path, never the video: the
 *   frames' directory holds `frames.json`, each frame's file, time and size.
 * - It answers with one file, `{{outDir}}/result.json`:
 *   `{ "result": <its capability's result>, "model"?: "<name>" }`, or
 *   `{ "error": { "code": "<analyser error>", "message": "…" } }`; within the
 *   request's `maxOutputBytes`, parsed against its declared output.
 * - It is bounded by the request's time, the RSS watchdog, the run's write
 *   cap and the caller's signal; it reaches the network only as a remote
 *   analyser (`manifest.local: false`) with the owner's `domains`.
 */

export type CommandAnalyzerEntry = Extract<AnalyzerEntry, { readonly type: "command" }>;

export const COMMAND_PLACEHOLDERS = ["{{framesDir}}", "{{audio}}", "{{outDir}}", "{{options}}"] as const;
/** The one file a command answers in, in `{{outDir}}`. */
export const COMMAND_RESULT_FILE = "result.json";
/** What the frames' directory lists, for the command to read. */
export const COMMAND_FRAMES_INDEX = "frames.json";

export interface CommandAnalyzerOptions {
  readonly entry: CommandAnalyzerEntry;
  readonly sandbox: VideoSandbox;
  readonly now?: () => number;
  /** The watchdog's sampler (tests replace it). */
  readonly residentKb?: (pid: number) => Promise<number | undefined>;
}

const AnswerSchema = z.union([
  z.strictObject({ result: z.unknown(), model: z.string().min(1).max(100).optional() }),
  z.strictObject({ error: z.strictObject({ code: z.enum(ANALYZER_ERRORS), message: z.string().max(1_000) }) }),
]);

type Failed = Extract<AnalyzeOutcome<never>, { readonly ok: false }>;

function failed(code: AnalyzerErrorCode, message: string): Failed {
  return { ok: false, error: { code, retryable: ANALYZER_FALLBACK_ERRORS.includes(code), message } };
}

/** Placeholders are whole arguments: one that sits inside another argument is refused when the analyser is made. */
export function checkCommandArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (arg.includes("{{") && !(COMMAND_PLACEHOLDERS as readonly string[]).includes(arg))
      throw new RangeError(`an analyser argument is a placeholder or plain text, not both: ${arg}`);
  }
}

export function createCommandAnalyzer(options: CommandAnalyzerOptions): VideoAnalyzerPort {
  const { entry } = options;
  checkCommandArgs(entry.args);
  const now = options.now ?? Date.now;
  const manifest: AnalyzerManifest = entry.manifest;
  const running = new Set<{ readonly child: ChildProcess; readonly kill: () => Promise<void> }>();

  const analyze = async <C extends VideoCapability>(request: AnalyzeRequest<C>): Promise<AnalyzeOutcome<AnalyzeResult[C]>> => {
    // Refused before any work: no directory made, nothing started.
    const declared = manifest.capabilities.find((candidate) => candidate.capability === request.capability);
    if (declared === undefined || request.capability === "describe")
      return failed("unsupported", `${manifest.id} does not do ${request.capability}`);
    const capability = request.capability as Exclude<VideoCapability, "describe">;
    const runDirectory = resolve(request.runDirectory);
    const inside = (path: string): boolean => resolve(path).startsWith(runDirectory + sep);
    const frames = request.frames ?? [];
    const framesDirectory = frames.length === 0 ? undefined : dirname(resolve(frames[0]?.path ?? ""));
    // The frames are handed as one directory of the run's: every one in it.
    if (
      framesDirectory !== undefined &&
      (!inside(framesDirectory) || frames.some((frame) => dirname(resolve(frame.path)) !== framesDirectory))
    )
      return failed("bad-input", "the frames are not in one directory of the run");
    if (request.audio !== undefined && !inside(request.audio.path)) return failed("bad-input", "the audio is not in the run");
    if (request.signal.aborted) return failed("timeout", "the call was stopped");

    const before = new Set(readdirSync(runDirectory));
    const baseline = sizeOf(runDirectory);
    const work = mkdtempSync(join(runDirectory, "analyze-"));
    let handle: { readonly child: ChildProcess; readonly kill: () => Promise<void> } | undefined;
    try {
      const outDirectory = join(work, "out");
      mkdirSync(outDirectory, { mode: 0o700 });
      mkdirSync(join(work, "tmp"), { mode: 0o700 });
      const handed = framesDirectory ?? join(work, "frames");
      if (framesDirectory === undefined) mkdirSync(handed, { mode: 0o700 });
      // The child can write the frames' directory: whatever is under the index's name goes first, and the index is
      // made anew (`wx`, never following a link planted there by an earlier command).
      const index = join(handed, COMMAND_FRAMES_INDEX);
      rmSync(index, { recursive: true, force: true });
      writeFileSync(
        index,
        JSON.stringify({
          frames: frames.map((frame) => ({
            file: basename(frame.path),
            timeSec: frame.timeSec,
            width: frame.width,
            height: frame.height,
            format: frame.format,
          })),
        }),
        { mode: 0o600, flag: "wx" },
      );
      const values: Record<(typeof COMMAND_PLACEHOLDERS)[number], string> = {
        "{{framesDir}}": handed,
        "{{audio}}": request.audio?.path ?? "",
        "{{outDir}}": outDirectory,
        "{{options}}": JSON.stringify(request.options),
      };
      const args = entry.args.map((arg) => (arg in values ? values[arg as keyof typeof values] : arg));
      const env: Record<string, string> = {
        ...systemChildEnv(),
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: work,
        TMPDIR: join(work, "tmp"),
      };
      // A speech model needs more room than frames do: transcription has caps of its own.
      const transcribing = capability === "transcribe";
      const memoryMb = transcribing ? VIDEO_LIMITS.transcribeMemoryMb : VIDEO_LIMITS.childMemoryMb;
      let launch: {
        readonly command: string;
        readonly args: readonly string[];
        readonly env: Readonly<Record<string, string>>;
        readonly onExit?: () => "oom" | undefined;
        readonly kill?: () => void;
      };
      if (options.sandbox.kind === "none") launch = { command: entry.command, args, env };
      else {
        const wrapped = options.sandbox.wrap({
          argv: [entry.command, ...args],
          env,
          readRoots: entry.readRoots,
          runDirectory,
          workload: "video",
          limits: { memoryBytes: memoryMb * 1024 * 1024, processes: VIDEO_LIMITS.processes },
          // The network only for a remote analyser, whose every call is raised to external.
          domains: manifest.local ? [] : (entry.domains ?? []),
        });
        if ("refused" in wrapped) return failed("unavailable", "the sandbox is unavailable on this host, so the analyser was not run");
        launch = wrapped;
      }

      const started = now();
      let stopped = false;
      const outcome = await supervise(launch, {
        cwd: work,
        timeoutMs: request.limits.timeoutMs,
        signal: request.signal,
        // The child may write anywhere in the run: all of it is counted, less what was there before.
        written: () => sizeOf(runDirectory) - baseline,
        ...(options.residentKb === undefined ? {} : { residentKb: options.residentKb }),
        rssMb: transcribing ? VIDEO_LIMITS.transcribeRssMb : VIDEO_LIMITS.childRssMb,
        started: (child, kill) => {
          handle = { child, kill };
          running.add(handle);
        },
        ended: () => {
          if (handle !== undefined) running.delete(handle);
        },
      });
      stopped = outcome.why === "stopped";
      const wallMs = now() - started;
      if (outcome.why === "timeout" || stopped)
        return failed("timeout", stopped ? "the call was stopped" : `${manifest.id} ran past ${String(request.limits.timeoutMs)} ms`);
      if (outcome.why === "memory") return failed("memory", `${manifest.id} ran out of memory`);
      if (outcome.why === "protocol") return failed("protocol", `${manifest.id} wrote more than the run may hold`);
      if (outcome.error !== undefined) return failed("unavailable", `${manifest.id} could not be started: ${outcome.error.message}`);
      if (outcome.signal !== null) return failed("crashed", `${manifest.id} was ended by ${outcome.signal}`);
      const file = readOutputFile(join(outDirectory, COMMAND_RESULT_FILE), request.limits.maxOutputBytes);
      let answer: z.infer<typeof AnswerSchema> | undefined;
      try {
        answer = file === undefined ? undefined : AnswerSchema.parse(JSON.parse(Buffer.from(file.bytes).toString("utf8")));
      } catch {
        answer = undefined;
      }
      // Its own error, said in its answer, stands whatever it exited with.
      if (answer !== undefined && "error" in answer) return failed(answer.error.code, `${manifest.id}: ${answer.error.message}`);
      // Only a launch placed in a cgroup can fail to enter one.
      if (outcome.code === LIMITS_ENTRY_FAILED_EXIT && launch.onExit !== undefined)
        return failed("unavailable", `${manifest.id} could not be started in its cgroup`);
      // Its diagnostics may quote the media it read, so they are never passed on.
      if (outcome.code !== 0) return failed("crashed", `${manifest.id} exited ${String(outcome.code)}`);
      if (answer === undefined)
        return failed(
          "protocol",
          `${manifest.id} left no ${COMMAND_RESULT_FILE} within ${String(request.limits.maxOutputBytes)} bytes, or one that is not its answer`,
        );
      const parsed = ANALYZER_RESULT_SCHEMAS[CAPABILITY_OUTPUT[capability]].safeParse(answer.result);
      if (!parsed.success) return failed("protocol", `${manifest.id} answered outside ${CAPABILITY_OUTPUT[capability]}`);
      return {
        ok: true,
        result: parsed.data as AnalyzeResult[C],
        model: answer.model ?? manifest.models[0]?.name ?? manifest.id,
        peakKb: outcome.peakKb,
        wallMs,
      };
    } catch (error) {
      // The run changed under the owner (an index it could not make anew): no answer.
      return failed("internal", `${manifest.id} could not be run: ${errorMessage(error)}`);
    } finally {
      // What it left anywhere in the run goes: its scratch, and anything new beside it.
      for (const name of readdirSync(runDirectory))
        if (!before.has(name)) rmSync(join(runDirectory, name), { recursive: true, force: true });
      // The frames' index is the owner's file in the caller's directory: removed with the answer, when it is still a file.
      if (framesDirectory !== undefined) {
        const index = join(framesDirectory, COMMAND_FRAMES_INDEX);
        try {
          if (lstatSync(index).isFile()) rmSync(index, { force: true });
        } catch {
          // Already gone.
        }
      }
    }
  };

  return {
    manifest: () => manifest,
    analyze,
    close: async () => {
      await Promise.all([...running].map(async (handle) => handle.kill()));
    },
  };
}
