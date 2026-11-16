import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANALYZER_RESULT_SCHEMAS,
  AnalyzerManifestSchema,
  CAPABILITY_OUTPUT,
  VIDEO_CAPABILITIES,
  type AnalyzeRequest,
  type AnalyzerCaller,
  type DecodedFrame,
  type VideoAnalyzerPort,
  type VideoCapability,
} from "@tavi/contracts";

/**
 * The one suite every video analyser runs: its manifest is valid; it refuses a capability it
 * does not declare with `unsupported` before doing any work; it honours the
 * request's time and the caller's signal; each declared capability answers
 * within `maxOutputBytes` and its result schema; it writes only inside the
 * run directory; and, when local, it never opens the network.
 *
 * It answers each case's verdict rather than asserting, so a test can show a
 * bad analyser fails exactly its own case. `make` is handed a local port
 * that counts connections: an analyser told to reach it (a bad fixture)
 * shows up there, a conforming one never does.
 */

export const CONFORMANCE_CASES = ["manifest", "unsupported", "timeout", "signal", "output", "writes", "network"] as const;
export type ConformanceCase = (typeof CONFORMANCE_CASES)[number];

export interface ConformanceProbe {
  /** A local TCP port whose connections are counted. */
  readonly port: number;
}

interface ConformanceMedia {
  readonly frames?: readonly DecodedFrame[];
  readonly audio?: { readonly path: string; readonly seconds: number };
}

export interface ConformanceOptions {
  /** The media a capability's request carries, written into `directory` (default: a small PNG per frame, a short WAV). */
  readonly media?: (capability: VideoCapability, directory: string) => ConformanceMedia;
  /** Time for an answer that should succeed. */
  readonly timeoutMs?: number;
  /** Whom each request is for: an MCP analyser refuses a call that names no one. */
  readonly caller?: AnalyzerCaller;
}

export type ConformanceReport = Readonly<Record<ConformanceCase, { readonly pass: boolean; readonly detail?: string }>>;

/** One opaque 1×1 PNG: enough for an analyser that only lists what it is handed. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000000000200015e2ab2a90000000049454e44ae426082",
  "hex",
);

function defaultMedia(capability: VideoCapability, directory: string): ConformanceMedia {
  if (capability === "transcribe") {
    const path = join(directory, "audio.wav");
    // A 44-byte WAV header and no samples: present, typed, and empty.
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    writeFileSync(path, header);
    return { audio: { path, seconds: 1 } };
  }
  const frames = join(directory, "frames");
  mkdirSync(frames);
  return {
    frames: [0, 0.5].map((timeSec, index) => {
      const path = join(frames, `${String(index).padStart(4, "0")}.png`);
      writeFileSync(path, PNG);
      return { timeSec, path, width: 1, height: 1, format: "png" as const };
    }),
  };
}

function request<C extends VideoCapability>(
  capability: C,
  runDirectory: string,
  media: ConformanceMedia,
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number },
  signal: AbortSignal,
  caller?: AnalyzerCaller,
): AnalyzeRequest<C> {
  const options = (
    capability === "transcribe" ? { language: "en" } : capability === "ocr" ? { language: "eng" } : {}
  ) as AnalyzeRequest<C>["options"];
  return { capability, ...media, runDirectory, options, limits, signal, ...(caller === undefined ? {} : { caller }) };
}

export async function runAnalyzerConformance(
  make: (probe: ConformanceProbe) => VideoAnalyzerPort,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  // The run directory sits alone in its own parent, so anything written beside it shows.
  const root = mkdtempSync(join(tmpdir(), "tavi-analyzer-conformance-"));
  const analyzer = make({ port });
  const media = options.media ?? defaultMedia;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const report: Partial<Record<ConformanceCase, { readonly pass: boolean; readonly detail?: string }>> = {};
  const fresh = (name: string): string => {
    const directory = join(root, name);
    mkdirSync(directory, { mode: 0o700 });
    return directory;
  };
  try {
    const parsed = AnalyzerManifestSchema.safeParse(analyzer.manifest());
    report.manifest = parsed.success ? { pass: true } : { pass: false, detail: parsed.error.issues[0]?.message ?? "invalid" };
    const declared = analyzer
      .manifest()
      .capabilities.map((entry) => entry.capability)
      .filter((capability): capability is Exclude<VideoCapability, "describe"> => capability !== "describe");

    // A capability it does not declare: `unsupported`, with nothing written.
    const undeclared = VIDEO_CAPABILITIES.find((capability) => !declared.includes(capability as never)) ?? "describe";
    {
      const run = fresh("unsupported");
      const before = readdirSync(run).length;
      const outcome = await analyzer.analyze(
        request(undeclared, run, {}, { timeoutMs, maxOutputBytes: 64 * 1024 }, new AbortController().signal, options.caller),
      );
      const untouched = readdirSync(run).length === before;
      report.unsupported =
        !outcome.ok && outcome.error.code === "unsupported" && untouched
          ? { pass: true }
          : { pass: false, detail: outcome.ok ? "it answered" : `${outcome.error.code}${untouched ? "" : ", and wrote in the run"}` };
    }

    const first = declared[0];
    if (first === undefined) {
      for (const name of ["timeout", "signal", "output", "writes", "network"] as const)
        report[name] = { pass: false, detail: "no capability declared" };
      return report as ConformanceReport;
    }

    // Its time: a millisecond is never enough, and it says `timeout`.
    {
      const run = fresh("timeout");
      const started = Date.now();
      const outcome = await analyzer.analyze(
        request(first, run, media(first, run), { timeoutMs: 1, maxOutputBytes: 64 * 1024 }, new AbortController().signal, options.caller),
      );
      const quick = Date.now() - started < 10_000;
      report.timeout =
        !outcome.ok && outcome.error.code === "timeout" && quick
          ? { pass: true }
          : { pass: false, detail: outcome.ok ? "it answered past its time" : outcome.error.code };
    }

    // The caller's signal: stopped a moment in, it stops.
    {
      const run = fresh("signal");
      const controller = new AbortController();
      const started = Date.now();
      const pending = analyzer.analyze(
        request(first, run, media(first, run), { timeoutMs, maxOutputBytes: 64 * 1024 }, controller.signal, options.caller),
      );
      setTimeout(() => controller.abort(), 5);
      const outcome = await pending;
      const quick = Date.now() - started < 10_000;
      report.signal =
        !outcome.ok && quick
          ? { pass: true }
          : { pass: false, detail: outcome.ok ? "it answered after the call was stopped" : "it took too long to stop" };
    }

    // Each declared capability answers within its size and schema, writing only in its run, never reaching the port.
    const outputs: string[] = [];
    const strays: string[] = [];
    const reached = connections;
    for (const capability of declared) {
      const run = fresh(`answer-${capability}`);
      const maxOutputBytes = 16 * 1024;
      const outcome = await analyzer.analyze(
        request(capability, run, media(capability, run), { timeoutMs, maxOutputBytes }, new AbortController().signal, options.caller),
      );
      if (!outcome.ok) outputs.push(`${capability}: ${outcome.error.code} ${outcome.error.message}`);
      else {
        const valid = ANALYZER_RESULT_SCHEMAS[CAPABILITY_OUTPUT[capability]].safeParse(outcome.result).success;
        if (!valid) outputs.push(`${capability}: outside ${CAPABILITY_OUTPUT[capability]}`);
        else if (Buffer.byteLength(JSON.stringify(outcome.result)) > maxOutputBytes)
          outputs.push(`${capability}: over ${String(maxOutputBytes)} bytes`);
      }
      const known = new Set(["unsupported", "timeout", "signal", ...declared.map((name) => `answer-${name}`)]);
      for (const entry of readdirSync(root)) if (!known.has(entry)) strays.push(entry);
    }
    report.output = outputs.length === 0 ? { pass: true } : { pass: false, detail: outputs.join("; ") };
    report.writes =
      strays.length === 0 ? { pass: true } : { pass: false, detail: `wrote beside its run: ${[...new Set(strays)].join(", ")}` };
    const opened = connections - reached;
    report.network =
      !analyzer.manifest().local || opened === 0 ? { pass: true } : { pass: false, detail: `opened ${String(opened)} connection(s)` };
    return report as ConformanceReport;
  } finally {
    await analyzer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}
