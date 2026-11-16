import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ANALYZER_FALLBACK_ERRORS,
  ANALYZER_RESULT_SCHEMAS,
  CAPABILITY_OUTPUT,
  VIDEO_LIMITS,
  type AnalyzeOutcome,
  type AnalyzeRequest,
  type AnalyzeResult,
  type AnalyzerCaller,
  type AnalyzerErrorCode,
  type AnalyzerManifest,
  type VideoAnalyzerPort,
  type VideoCapability,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { SerialLock } from "@tavi/node-kit";

import { readOutputFile } from "./decoder.js";

/**
 * The MCP analyser: an MCP
 * server's tool the owner named in `analyzers.json`, called through the
 * owner's MCP client. It never sees the video, only what the decoder made of
 * it, and is handed it one of two ways:
 *
 * - **By path**, to a stdio server: the owner copies the frames or audio into
 *   a fresh, randomly named directory inside the server's exchange directory,
 *   `<data>/video/mcp/<pluginId>/`, the one place inside the denied data
 *   directory its sandbox may read (and never write), calls the tool, and
 *   empties the exchange again. One call per server at a time, each with its
 *   own paths, so a call never sees another's frames.
 * - **Inline**, base64, to a server that reads no files of the owner's (an
 *   HTTP one), within `MCP_INLINE_MAX_BYTES`.
 *
 * The tool's arguments are `{ capability, frames?, audio?, options }`, each
 * frame `{ path | data, timeSec, width, height, format }`, the audio
 * `{ path | data, seconds, format: "wav" }`. Its answer is the capability's
 * result itself, as `structuredContent` or as JSON text, parsed here against
 * the capability's schema: the client's own output-schema check only logs.
 */

/** The most frames and audio an inline call carries, base64 before encoding. */
export const MCP_INLINE_MAX_BYTES = 8 * 1024 * 1024;

/** A tool call's answer as the MCP client gives it, or why it gave none, in the analyser's own words. */
export type McpAnalyzerAnswer =
  | { readonly ok: true; readonly content: unknown; readonly text?: string; readonly structured?: true }
  | { readonly ok: false; readonly code: "unavailable" | "crashed" | "timeout"; readonly message: string };

export interface McpAnalyzerOptions {
  /** As the host resolved it: the tool's own (`_meta["tavi/analyzer"]`) or the owner's pin, never local when the server can reach the network. */
  readonly manifest: AnalyzerManifest;
  /**
   * Calls the tool, for the request's caller. The host checks the tool is still approved as it was when the chain
   * was built, and that the caller may use the server, refusing a call that names no one.
   */
  readonly call: (
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number; readonly caller?: AnalyzerCaller },
  ) => Promise<McpAnalyzerAnswer>;
  /** A stdio server's exchange: its directory, and the lock its server's analysers share. Absent, media goes inline. */
  readonly exchange?: { readonly directory: string; readonly lock: SerialLock };
  readonly now?: () => number;
}

type Failed = Extract<AnalyzeOutcome<never>, { readonly ok: false }>;

function failed(code: AnalyzerErrorCode, message: string): Failed {
  return { ok: false, error: { code, retryable: ANALYZER_FALLBACK_ERRORS.includes(code), message } };
}

/** Everything in a directory removed, the directory kept: the owner's, made again when it is gone. */
function emptied(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(directory)) rmSync(join(directory, name), { recursive: true, force: true });
}

export function createMcpAnalyzer(options: McpAnalyzerOptions): VideoAnalyzerPort {
  const { manifest } = options;
  const now = options.now ?? Date.now;
  const inFlight = new Set<AbortController>();

  /** The call's media as the tool reads it: copied into the exchange, or inline; a refusal when it cannot be. */
  const media = (
    request: AnalyzeRequest<VideoCapability>,
    directory: string | undefined,
  ): { readonly frames?: unknown[]; readonly audio?: unknown } | Failed => {
    let inline = 0;
    const handed = (path: string, name: string): { readonly path: string } | { readonly data: string } | Failed => {
      // The decoder's own output, read as any of its outputs is: no link followed, within the run's cap.
      const read = readOutputFile(path, VIDEO_LIMITS.runDirMaxBytes);
      if (read === undefined) return failed("bad-input", "a frame or the audio could not be read");
      if (directory !== undefined) {
        const target = join(directory, name);
        writeFileSync(target, read.bytes, { mode: 0o600, flag: "wx" });
        return { path: target };
      }
      inline += read.bytes.length;
      if (inline > MCP_INLINE_MAX_BYTES)
        return failed(
          "too-large",
          `${manifest.id} is sent its media inline, at most ${String(MCP_INLINE_MAX_BYTES / 1024 / 1024)} MiB a call`,
        );
      return { data: Buffer.from(read.bytes).toString("base64") };
    };
    const frames: unknown[] = [];
    for (const [index, frame] of (request.frames ?? []).entries()) {
      // Named by position, never by what the run called it: one name per frame however the run's were made.
      const given = handed(frame.path, `frame-${String(index).padStart(4, "0")}.${frame.format === "png" ? "png" : "raw"}`);
      if ("ok" in given) return given;
      frames.push({ ...given, timeSec: frame.timeSec, width: frame.width, height: frame.height, format: frame.format });
    }
    let audio: unknown;
    if (request.audio !== undefined) {
      const given = handed(request.audio.path, "audio.wav");
      if ("ok" in given) return given;
      audio = { ...given, seconds: request.audio.seconds, format: "wav" };
    }
    return { ...(frames.length === 0 ? {} : { frames }), ...(audio === undefined ? {} : { audio }) };
  };

  /** Why a call stopped: the caller's signal, or its time. */
  const ended = (request: AnalyzeRequest<VideoCapability>): Failed =>
    failed("timeout", request.signal.aborted ? "the call was stopped" : `${manifest.id} ran past ${String(request.limits.timeoutMs)} ms`);

  const once = async <C extends VideoCapability>(
    request: AnalyzeRequest<C>,
    capability: Exclude<VideoCapability, "describe">,
    controller: AbortController,
    started: number,
  ): Promise<AnalyzeOutcome<AnalyzeResult[C]>> => {
    // Reached after its time while it waited for the server: nothing copied, nothing called.
    if (controller.signal.aborted) return ended(request);
    const directory = options.exchange?.directory;
    // Each call's media in a directory of its own, named afresh: a call abandoned at its time and still read by the
    // server finds its paths gone, never the next call's frames under the same names.
    const handedDirectory = directory === undefined ? undefined : join(directory, randomBytes(8).toString("hex"));
    try {
      if (directory !== undefined && handedDirectory !== undefined) {
        emptied(directory);
        mkdirSync(handedDirectory, { mode: 0o700 });
      }
      const handed = media(request, handedDirectory);
      if ("ok" in handed) return handed;
      const stopped = new Promise<McpAnalyzerAnswer>((resolve) => {
        const said = (): void => resolve({ ok: false, code: "timeout", message: "" });
        if (controller.signal.aborted) said();
        else controller.signal.addEventListener("abort", said, { once: true });
      });
      const remaining = Math.max(1, request.limits.timeoutMs - (now() - started));
      const answer = await Promise.race([
        options.call(
          { capability, ...handed, options: request.options },
          { signal: controller.signal, timeoutMs: remaining, ...(request.caller === undefined ? {} : { caller: request.caller }) },
        ),
        stopped,
      ]);
      const wallMs = now() - started;
      if (!answer.ok) {
        if (answer.code === "timeout" || controller.signal.aborted) return ended(request);
        // The host says only Tavi's own words; a tool's error, which may quote the media, as just that.
        return failed(
          answer.code,
          answer.code === "crashed" ? `${manifest.id} answered with an error` : `${manifest.id} could not be reached: ${answer.message}`,
        );
      }
      let value: unknown;
      try {
        value = answer.structured === true ? answer.content : JSON.parse(answer.text ?? "");
      } catch {
        return failed("protocol", `${manifest.id} answered with neither structured content nor JSON`);
      }
      if (Buffer.byteLength(JSON.stringify(value) ?? "") > request.limits.maxOutputBytes)
        return failed("protocol", `${manifest.id} answered with more than ${String(request.limits.maxOutputBytes)} bytes`);
      const parsed = ANALYZER_RESULT_SCHEMAS[CAPABILITY_OUTPUT[capability]].safeParse(value);
      if (!parsed.success) return failed("protocol", `${manifest.id} answered outside ${CAPABILITY_OUTPUT[capability]}`);
      return { ok: true, result: parsed.data as AnalyzeResult[C], model: manifest.models[0]?.name ?? manifest.id, wallMs };
    } catch (error) {
      // The exchange could not be emptied or written (a name taken under the owner): no call made, or no answer kept.
      return failed("internal", `${manifest.id} could not be called: ${errorMessage(error)}`);
    } finally {
      // The server reads the media only during its call.
      if (directory !== undefined) {
        try {
          emptied(directory);
        } catch {
          // Emptied again before the next call, which fails rather than hand on another call's frames.
        }
      }
    }
  };

  return {
    manifest: () => manifest,
    analyze: async <C extends VideoCapability>(request: AnalyzeRequest<C>): Promise<AnalyzeOutcome<AnalyzeResult[C]>> => {
      // Refused before any work: nothing copied, nothing called.
      const declared = manifest.capabilities.some((candidate) => candidate.capability === request.capability);
      if (!declared || request.capability === "describe") return failed("unsupported", `${manifest.id} does not do ${request.capability}`);
      const capability = request.capability as Exclude<VideoCapability, "describe">;
      if (request.signal.aborted) return ended(request);
      // The request's time runs from now, while it waits for its server too: the client's own timeout is the
      // backstop, this one answers first.
      const controller = new AbortController();
      inFlight.add(controller);
      const started = now();
      const stop = (): void => controller.abort();
      request.signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, Math.max(1, request.limits.timeoutMs));
      timer.unref();
      try {
        const exchange = options.exchange;
        if (exchange === undefined) return await once(request, capability, controller, started);
        // Queued behind the server's other calls, it still ends at its time: the queued task then does nothing.
        const gaveUp = new Promise<Failed>((resolve) => {
          if (controller.signal.aborted) resolve(ended(request));
          else controller.signal.addEventListener("abort", () => resolve(ended(request)), { once: true });
        });
        return await Promise.race([exchange.lock(async () => once(request, capability, controller, started)), gaveUp]);
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", stop);
        inFlight.delete(controller);
      }
    },
    close: async () => {
      for (const controller of inFlight) controller.abort();
    },
  };
}
