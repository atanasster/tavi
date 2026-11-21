import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { AnalyzerConfigSchema, type VoiceSetupStatus } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { writeFileAtomic } from "@tavi/node-kit";

import { analyzerConfigPath } from "./host.js";

/**
 * Setting up voice messages, for onboarding's voice step and `tavi doctor`'s
 * advice: what is here (FFmpeg, whisper.cpp, a speech model, `analyzers.json`
 * naming it), and, when the person asks, the one job that adds what is
 * missing — Homebrew installs the tools as the person's own user (never
 * `sudo`, a fixed argument list), the model comes from one fixed address and
 * is kept only when its size and SHA-256 are the ones pinned here, and
 * `analyzers.json` gains the transcription entry without losing anything the
 * person wrote in it. Then the owner reloads its analysers: no restart.
 */

/** The download's words, its share added by whoever shows it. */
const DOWNLOADING = "Downloading Whisper's base model";

/** The speech model the step downloads: whisper.cpp's conversion of OpenAI's Whisper base (multilingual), MIT. */
export const VOICE_MODEL = {
  file: "ggml-base.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  bytes: 147_951_465,
  licence: "MIT",
} as const;

/** Where Homebrew lives: Apple silicon's prefix, then Intel's. */
const BREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;
/** A Homebrew install's longest wait: FFmpeg's dependencies take minutes on a fresh machine. */
const BREW_TIMEOUT_MS = 30 * 60_000;
/** A model download's longest wait. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export interface VoiceSetupOptions {
  readonly dataDirectory: string;
  readonly platform?: NodeJS.Platform;
  /** Whether the person's FFmpeg (and ffprobe) are found now. */
  readonly ffmpegFound: () => boolean;
  /** The whisper.cpp CLI found now, if any. */
  readonly whisperFound: () => Promise<boolean>;
  /** Whether the owner's transcription chain has an analyser ready now. */
  readonly transcriberReady: () => boolean;
  /** Reads `analyzers.json` again and rebuilds the chains. */
  readonly reload: () => Promise<void>;
  /** Homebrew, when it is installed; tests name another. */
  readonly brew?: () => string | undefined;
  /** Runs Homebrew: its exit code and the tail of its output. */
  readonly runBrew?: (brew: string, args: readonly string[]) => Promise<{ readonly code: number; readonly output: string }>;
  readonly fetch?: typeof globalThis.fetch;
  readonly model?: typeof VOICE_MODEL;
}

export interface VoiceSetup {
  status(): Promise<VoiceSetupStatus>;
  /** Starts the job that adds what is missing; answers at once, the job's progress in `status().job`. */
  start(): Promise<VoiceSetupStatus>;
}

function defaultBrew(): string | undefined {
  return BREW_PATHS.find((path) => existsSync(path));
}

/** Homebrew run with a fixed argument list, as the owner's own user, never through a shell. */
function defaultRunBrew(brew: string, args: readonly string[]): Promise<{ readonly code: number; readonly output: string }> {
  return new Promise((done) => {
    const child = execFile(
      brew,
      [...args],
      {
        timeout: BREW_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        // A service's PATH is short: Homebrew finds its own tools from its prefix; no hints, no analytics prompt.
        env: {
          ...process.env,
          PATH: `${dirname(brew)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOMEBREW_NO_ENV_HINTS: "1",
          HOMEBREW_NO_ANALYTICS: "1",
        },
        // Its own session, with no terminal: a password prompt (sudo reads the terminal, not stdin) fails at once
        // instead of waiting out the timeout on the terminal `tavi serve` runs in.
        detached: true,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
        done({ code, output: `${stdout}${stderr}`.slice(-2_000) });
      },
    );
    // Nothing is ever typed into it: a prompt on stdin reads end-of-input and fails.
    child.stdin?.end();
  });
}

/**
 * Why Homebrew failed, in its own last error line (`Error: …`), else its last line: what a person needs to act on,
 * such as Xcode's command-line tools missing. Empty when it said nothing.
 */
export function brewReason(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const reason = lines.findLast((line) => line.startsWith("Error:")) ?? lines.at(-1);
  return reason === undefined ? "" : `: ${reason.slice(0, 200)}`;
}

/** The commands that set voice messages up by hand, for where the step cannot (no Homebrew, Linux). */
export function voiceSetupCommands(platform: NodeJS.Platform, modelsDirectory: string, model: typeof VOICE_MODEL = VOICE_MODEL): string[] {
  const tools =
    platform === "darwin"
      ? "brew install whisper-cpp ffmpeg"
      : "sudo apt install ffmpeg   # and build whisper.cpp (https://github.com/ggml-org/whisper.cpp), with whisper-cli on PATH";
  return [tools, `curl -L -o ${join(modelsDirectory, model.file)} ${model.url}`];
}

/** The model the transcription entry names, when `analyzers.json` names one for the built-in whisper.cpp. */
function configuredModel(dataDirectory: string): { readonly path?: string; readonly error?: string } {
  const path = analyzerConfigPath(dataDirectory);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { error: `${path} is not JSON` };
  }
  const parsed = AnalyzerConfigSchema.safeParse(raw);
  if (!parsed.success) return { error: `${path} is not a valid analyser configuration` };
  const entry = parsed.data.transcribe.find((candidate) => candidate.type === "builtin" && candidate.id === "whisper-cpp");
  return entry?.type === "builtin" && entry.model !== undefined ? { path: entry.model.path } : {};
}

/**
 * `analyzers.json` with the built-in whisper.cpp on `modelFile` first in its transcription chain, everything else in
 * it as the person wrote it; an entry for whisper.cpp already there gains the model if it named none.
 */
export function withVoiceEntry(raw: unknown, modelFile: string, licence: string): Record<string, unknown> {
  const config = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const chain = Array.isArray(config["transcribe"]) ? [...(config["transcribe"] as unknown[])] : [];
  const at = chain.findIndex(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>)["type"] === "builtin" &&
      (entry as Record<string, unknown>)["id"] === "whisper-cpp",
  );
  const ours = { type: "builtin", id: "whisper-cpp", model: { path: modelFile, licence } };
  if (at < 0) chain.unshift(ours);
  else if ((chain[at] as Record<string, unknown>)["model"] === undefined) chain[at] = ours;
  return { ...config, transcribe: chain.slice(0, 4) };
}

export function createVoiceSetup(options: VoiceSetupOptions): VoiceSetup {
  const platform = options.platform ?? process.platform;
  const model = options.model ?? VOICE_MODEL;
  const modelsDirectory = join(options.dataDirectory, "video", "models");
  const brewOf = options.brew ?? defaultBrew;
  const runBrew = options.runBrew ?? defaultRunBrew;
  const fetchOf = options.fetch ?? globalThis.fetch;
  let job: VoiceSetupStatus["job"];

  /** Whether the model the configuration names, or else the one this step downloads, is in the models directory. */
  const modelPresent = (): boolean => {
    const named = configuredModel(options.dataDirectory).path ?? model.file;
    const path = named.startsWith("/") ? named : join(modelsDirectory, named);
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };

  const status = async (): Promise<VoiceSetupStatus> => {
    const supported = platform === "darwin" || platform === "linux";
    const ffmpeg = options.ffmpegFound();
    const whisper = await options.whisperFound();
    const configured = configuredModel(options.dataDirectory);
    const hasModel = modelPresent();
    const ready = ffmpeg && options.transcriberReady();
    const missing = [
      ...(ffmpeg ? [] : ["FFmpeg"]),
      ...(whisper ? [] : ["whisper.cpp"]),
      ...(hasModel ? [] : ["a speech model"]),
      ...(configured.error !== undefined ? [configured.error] : hasModel && whisper && !ready ? ["analyzers.json naming the model"] : []),
    ];
    const brew = platform === "darwin" ? brewOf() !== undefined : false;
    return {
      supported,
      ready,
      ffmpeg,
      whisper,
      model: hasModel,
      // Homebrew installs the tools; the model and the configuration need no tool at all.
      automatic: supported && configured.error === undefined && (brew || (ffmpeg && whisper)),
      missing: ready ? [] : missing,
      commands: ready ? [] : voiceSetupCommands(platform, modelsDirectory, model),
      modelInfo: { file: model.file, megabytes: Math.round(model.bytes / 1_000_000), licence: model.licence },
      ...(job === undefined ? {} : { job }),
    };
  };

  const download = async (): Promise<void> => {
    mkdirSync(modelsDirectory, { recursive: true, mode: 0o700 });
    const final = join(modelsDirectory, model.file);
    const partial = `${final}.download`;
    const response = await fetchOf(model.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || response.body === null) throw new Error(`the model download answered HTTP ${String(response.status)}`);
    const hash = createHash("sha256");
    const out = createWriteStream(partial, { mode: 0o600 });
    let received = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || value === undefined) break;
        received += value.byteLength;
        // Never more than the pinned size is kept: a longer answer is not the model.
        if (received > model.bytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error("the download is larger than the model it should be");
        }
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((resume) => out.once("drain", resume));
        job = { state: "running", phase: "download", message: DOWNLOADING, received, total: model.bytes };
      }
      await new Promise<void>((closed, failed) => out.end((error?: Error | null) => (error ? failed(error) : closed())));
      if (received !== model.bytes || hash.digest("hex") !== model.sha256)
        throw new Error("the downloaded model is not the one expected (its size or checksum differs), so it was not kept");
      renameSync(partial, final);
    } catch (error) {
      out.destroy();
      rmSync(partial, { force: true });
      throw error;
    }
  };

  const configure = (): void => {
    const path = analyzerConfigPath(options.dataDirectory);
    let raw: unknown = {};
    if (existsSync(path)) {
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        throw new Error(`${path} is not JSON: fix it, or add the transcription entry yourself (docs/VIDEO.md, Analysers)`);
      }
    }
    const next = withVoiceEntry(raw, model.file, model.licence);
    // Written only as a configuration the owner reads: anything else is the person's to fix, never overwritten.
    if (!AnalyzerConfigSchema.safeParse(next).success)
      throw new Error(`${path} is not a valid analyser configuration: fix it, or add the transcription entry yourself`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  };

  const run = async (): Promise<void> => {
    try {
      const before = await status();
      const formulae = [...(before.whisper ? [] : ["whisper-cpp"]), ...(before.ffmpeg ? [] : ["ffmpeg"])];
      if (formulae.length > 0) {
        const brew = platform === "darwin" ? brewOf() : undefined;
        if (brew === undefined)
          throw new Error(`install ${formulae.join(" and ")} yourself: ${voiceSetupCommands(platform, modelsDirectory, model)[0]}`);
        job = { state: "running", phase: "install", message: `Installing ${formulae.join(" and ")} with Homebrew` };
        const installed = await runBrew(brew, ["install", ...formulae]);
        if (installed.code !== 0)
          throw new Error(
            `Homebrew could not install ${formulae.join(" and ")} (exit ${String(installed.code)})${brewReason(installed.output)}`,
          );
      }
      if (!modelPresent()) {
        job = { state: "running", phase: "download", message: DOWNLOADING, received: 0, total: model.bytes };
        await download();
      }
      job = { state: "running", phase: "configure", message: "Naming the model in analyzers.json" };
      configure();
      await options.reload();
      const after = await status();
      job = after.ready
        ? { state: "done", phase: "configure", message: "Voice messages are transcribed on this computer" }
        : { state: "failed", phase: "configure", message: `still missing: ${after.missing.join(", ") || "a ready transcriber"}` };
    } catch (error) {
      job = { state: "failed", phase: job?.phase ?? "install", message: errorMessage(error).slice(0, 300) };
    }
  };

  return {
    status,
    start: async () => {
      if (job?.state !== "running") {
        job = { state: "running", phase: "install", message: "Starting" };
        // The job outlives the request: its progress is read with status().
        void run();
      }
      return await status();
    },
  };
}
