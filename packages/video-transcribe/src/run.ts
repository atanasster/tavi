import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Transcript } from "@tavi/contracts";

/**
 * One transcription, in the add-on's child: the person's whisper.cpp CLI on the audio the owner extracted (16 kHz
 * mono WAV), one thread, its JSON read back and written as the command
 * analyser's `result.json` in `Transcript@1`. Every failure is said there by
 * kind. The words are the video's: the owner labels them as it.
 */

export interface TranscribeRun {
  readonly audio: string;
  readonly outDir: string;
  readonly whisper: string;
  readonly model: string;
  /** The spoken language asked for, or detected when absent. */
  readonly language?: string;
}

/** How the child runs a program: its exit code (or the signal that ended it), the program's own diagnostics kept short. */
export type Exec = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly code: number | null; readonly signal?: string | null; readonly stderr: string }>;

/** The language a request's options ask for: an ISO 639 code, or none (detected). */
export function languageOf(options: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(options ?? "{}") as { readonly language?: unknown };
    return typeof parsed.language === "string" && /^[a-z]{2,3}$/.test(parsed.language) ? parsed.language : undefined;
  } catch {
    return undefined;
  }
}

/** The most segments a transcript gives, as `Transcript@1` takes them. */
export const MAX_SEGMENTS = 2_000;

function answer(outDir: string, body: unknown): void {
  writeFileSync(join(outDir, "result.json"), JSON.stringify(body));
}

export function fail(outDir: string, code: "unavailable" | "model-load" | "bad-input" | "crashed" | "internal", message: string): void {
  answer(outDir, { error: { code, message: message.slice(0, 1_000) } });
}

/** whisper.cpp's `HH:MM:SS,mmm` (or a millisecond offset), in seconds. */
function seconds(stamp: unknown, offsetMs: unknown): number | undefined {
  if (typeof offsetMs === "number" && Number.isFinite(offsetMs) && offsetMs >= 0) return offsetMs / 1000;
  if (typeof stamp !== "string") return undefined;
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(stamp.trim());
  if (match === null) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] ?? "0").padEnd(3, "0")) / 1000;
}

/** whisper.cpp's `-oj` output as `Transcript@1`: its segments with their times, its detected language unless one was asked for. */
export function transcriptOf(json: unknown, asked: string | undefined): Transcript | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const { result, transcription } = json as { readonly result?: { readonly language?: unknown }; readonly transcription?: unknown };
  if (!Array.isArray(transcription)) return undefined;
  const detected = typeof result?.language === "string" && /^[a-z]{2,3}$/.test(result.language) ? result.language : undefined;
  const segments = transcription.slice(0, MAX_SEGMENTS).flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return [];
    const { timestamps, offsets, text } = entry as {
      readonly timestamps?: { readonly from?: unknown; readonly to?: unknown };
      readonly offsets?: { readonly from?: unknown; readonly to?: unknown };
      readonly text?: unknown;
    };
    const startSec = seconds(timestamps?.from, offsets?.from);
    const endSec = seconds(timestamps?.to, offsets?.to);
    const words = typeof text === "string" ? text.trim().slice(0, 2_000) : "";
    return startSec === undefined || endSec === undefined || endSec < startSec || words === "" ? [] : [{ startSec, endSec, text: words }];
  });
  return { language: asked ?? detected ?? "en", segments };
}

export async function runTranscribe(request: TranscribeRun, exec: Exec): Promise<void> {
  const base = join(request.outDir, "whisper");
  let outcome: Awaited<ReturnType<Exec>>;
  try {
    // One thread, no prints, on the CPU (the sandbox reaches no GPU: Metal cannot allocate there and whisper.cpp
    // aborts), JSON beside the answer; the language asked for, or detected.
    outcome = await exec(request.whisper, [
      "-m",
      request.model,
      "-f",
      request.audio,
      "-l",
      request.language ?? "auto",
      "-t",
      "1",
      "-np",
      "-ng",
      "-oj",
      "-of",
      base,
    ]);
  } catch (error) {
    fail(request.outDir, "unavailable", `whisper.cpp could not be started: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (outcome.code === null && outcome.signal !== undefined && outcome.signal !== null) {
    fail(request.outDir, "crashed", `whisper.cpp was ended by ${outcome.signal}`);
    return;
  }
  if (outcome.code !== 0) {
    // Only the kind of failure is said: a model it could not load (with `-np`, whisper-cli says only that it could
    // not initialise its context) lets the chain try the next analyser.
    fail(
      request.outDir,
      /failed to initiali[sz]e whisper context|failed to (?:load|initialize|read) model|invalid model|not a ggml/i.test(outcome.stderr)
        ? "model-load"
        : "internal",
      `whisper.cpp exited ${String(outcome.code)}`,
    );
    return;
  }
  let json: unknown;
  try {
    // whisper.cpp's JSON writer escapes quotes and backslashes only: a control character in a segment's words would
    // make the whole file unreadable, so each is a space before it is parsed.
    json = JSON.parse(readFileSync(`${base}.json`, "utf8").replace(/[\u0000-\u001f]/g, " "));
  } catch {
    fail(request.outDir, "internal", "whisper.cpp left no JSON transcript");
    return;
  }
  const transcript = transcriptOf(json, request.language);
  if (transcript === undefined) {
    fail(request.outDir, "internal", "whisper.cpp's JSON is not a transcript");
    return;
  }
  answer(request.outDir, { result: transcript });
}
