import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { scrubCredentialText } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

import { cleanServerText } from "./results.js";
import type { McpSupervisor, McpSupervisorEvent } from "./supervisor.js";

/**
 * Each MCP server's log:
 * `<data>/mcp/<id>/server.log`, one rotation kept. Spawn, connect, era,
 * call, drift and login events, and the server's stderr — cleaned, scrubbed,
 * and with every credential value given to that server masked exactly. A
 * call is logged by tool, a digest of its input, outcome and duration, never
 * its arguments.
 */

const MAX_LOG_BYTES = 512 * 1024;
const MASK = "[credential]";

function serverLogPath(dataDirectory: string, pluginId: string): string {
  return join(dataDirectory, "mcp", pluginId, "server.log");
}

/** A line made safe to keep: cleaned of control text, credential shapes scrubbed, and each of `secrets` masked wherever it appears. */
export function scrubLogLine(line: string, secrets: readonly string[]): string {
  let text = scrubCredentialText(cleanServerText(line));
  for (const secret of [...secrets].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length))
    text = text.split(secret).join(MASK);
  return text;
}

/** A short digest of a call's input, so a log ties calls together without holding their arguments. */
export function inputDigest(input: unknown): string {
  return sha256Hex(JSON.stringify(input) ?? "").slice(0, 12);
}

export class McpServerLog {
  readonly #dataDirectory: string;
  readonly #secrets: (pluginId: string) => readonly string[];
  #queue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string, secrets: (pluginId: string) => readonly string[] = () => []) {
    this.#dataDirectory = dataDirectory;
    this.#secrets = secrets;
  }

  /** Appends one line (each line written in order; a failure to write is dropped, never thrown). */
  write(pluginId: string, line: string, at = new Date()): Promise<void> {
    const path = serverLogPath(this.#dataDirectory, pluginId);
    const text = `${at.toISOString()} ${scrubLogLine(line, this.#secrets(pluginId)).replace(/\n/g, "\n  ")}\n`;
    this.#queue = this.#queue
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const size = await stat(path).then(
          (info) => info.size,
          () => 0,
        );
        // Best effort: an unrotated log only grows past its bound until the next write rotates it.
        if (size + text.length > MAX_LOG_BYTES) await rename(path, `${path}.1`).catch(() => undefined);
        await appendFile(path, text, { mode: 0o600 });
        // Best effort: a server's log is a diagnostic; a write that fails loses a line, never the call.
      })
      .catch(() => undefined);
    return this.#queue;
  }

  /** Every supervisor event, as a line in its server's log. */
  follow(supervisor: McpSupervisor): () => void {
    return supervisor.subscribe((event) => {
      const line = lineOf(event);
      if (line !== undefined) void this.write(event.pluginId, line);
    });
  }
}

function lineOf(event: McpSupervisorEvent): string | undefined {
  switch (event.kind) {
    case "state":
      return `state ${event.state}${event.reason === undefined ? "" : `: ${event.reason}`}`;
    case "call":
      return `call ${event.tool} ${event.outcome} ${String(event.ms)} ms${event.digest === undefined ? "" : ` input ${event.digest}`}`;
    case "killed":
      return `killed: ${event.reason}`;
    case "era":
      return `protocol ${event.prior.kind === "modern" ? "2026-07-28" : "2025"}`;
    case "client":
      if (event.event.kind === "stderr") return `stderr: ${event.event.text.replace(/\s+$/, "")}`;
      if (event.event.kind === "connect") return `connected (${event.event.era}) in ${String(event.event.ms)} ms`;
      if (event.event.kind === "error") return `error (${event.event.where}): ${event.event.message}`;
      if (event.event.kind === "tools-changed") return "said its tools changed (tools/list_changed)";
      return "connection closed";
  }
}

/** The last `lines` lines of a server's log, across its rotation. */
export async function readServerLog(dataDirectory: string, pluginId: string, lines = 100): Promise<readonly string[]> {
  const path = serverLogPath(dataDirectory, pluginId);
  const read = async (file: string): Promise<string[]> =>
    (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
  const all = [...(await read(`${path}.1`)), ...(await read(path))];
  return all.slice(-lines);
}
