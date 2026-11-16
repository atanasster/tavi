/**
 * What the run-and-maintain guides' walks share: a made-up model server in a
 * process of its own (`tests/guides/fixtures/model-server/server.mjs`), standing
 * in for a local server or a provider's API, and key files the walk writes
 * itself. Owned by one writer; ask before adding to it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { onTestFinished } from "vitest";

import { root } from "../../../scripts/docs/browser.mjs";

const directories = temporaryDirectories({ prefix: "tavi-guide-keys-", leftovers: "warn" });

/** Where a file the walk writes goes: a folder of its own, deleted when the walk ends. */
function place(name: string): string {
  const directory = directories.create();
  if (directories.paths.length === 1) onTestFinished(() => directories.cleanup());
  return join(directory, name);
}

/**
 * A key file only you can read (`0600`), as a reader saves a provider's key before `tavi credentials set`: `value`
 * (a made-up key, never a real one) or, with `from`, a copy of that file. It is deleted when the walk ends.
 */
export function writeKeyFile(name: string, value: string | { readonly from: string }): string {
  const file = place(name);
  if (typeof value === "string") writeFileSync(file, value, { mode: 0o600 });
  else copyFileSync(value.from, file);
  chmodSync(file, 0o600);
  return file;
}

/** A file the reader writes for a command (`router.json`, say), holding `text`. It is deleted when the walk ends. */
export function writeWalkFile(name: string, text: string): string {
  const file = place(name);
  writeFileSync(file, text);
  return file;
}

/** The first 12 hex of a key's SHA-256: how the model server names the key a request bore, never the key itself. */
export const keyHash = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 12);

export interface ModelServer {
  /** `http://127.0.0.1:<port>/v1`, what a connection's `--base-url` is given. */
  readonly baseUrl: string;
  /** Each request it answered, oldest first: its method and path, and `keyHash` of the key it bore (`-` for none). */
  readonly requests: readonly { readonly line: string; readonly key: string }[];
}

/**
 * Starts the made-up model server in a process of its own (so it answers while the walk waits in a synchronous
 * `tavi`), on `port` when that is free so the pictures keep one address, listing `models`. With `acceptKeyFile`, a
 * request must bear the key that file holds when it arrives: rewrite the file to rotate it. Stopped when the walk ends.
 */
export async function startModelServer(options: {
  readonly port: number;
  readonly models: readonly string[];
  readonly acceptKeyFile?: string;
}): Promise<ModelServer> {
  const args = [
    join(root, "tests/guides/fixtures/model-server/server.mjs"),
    "--port",
    String(options.port),
    ...options.models.flatMap((model) => ["--model", model]),
    ...(options.acceptKeyFile === undefined ? [] : ["--key-file", options.acceptKeyFile]),
  ];
  const child: ChildProcess = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  const requests: { line: string; key: string }[] = [];
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    child.once("exit", (code) => reject(new Error(`the model server exited ${code}`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += String(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("http://")) resolve(line.trim());
        const request = /^request (\S+ \S+) key=(\S+)$/.exec(line.trim());
        if (request !== null) requests.push({ line: request[1] as string, key: request[2] as string });
      }
    });
  });
  return { baseUrl, requests };
}
