import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseClientEvent, type ClientEvent } from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { startOpenAiStub, textChunk, type OpenAiStubReply } from "@tavi/test-support/openai-stub";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * Failover over real HTTP: role
 * `main` bound to a provider that answers 429 with a fallback to one that
 * answers the turn. Only the providers are stubs — the CLI, the resolution,
 * the composition, the AI SDK adapter and its error classification are the
 * production code.
 */

interface Endpoint {
  readonly baseUrl: string;
  /** Each call's model and credential, in order. */
  readonly requests: readonly { readonly model: unknown; readonly authorization: string | undefined }[];
  readonly close: () => Promise<void>;
}

/** A provider answering every call with `status` and `body`, with a streamed answer, or with raw stream chunks. */
async function endpoint(answer: OpenAiStubReply): Promise<Endpoint> {
  const stub = await startOpenAiStub({ reply: () => answer });
  return {
    baseUrl: stub.baseUrl,
    get requests() {
      return stub.requests.map((request) => ({
        model: (request.body as { readonly model?: unknown }).model,
        authorization: request.authorization,
      }));
    },
    close: stub.close,
  };
}

const directories = temporaryDirectories({ prefix: "tavi-failover-" });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  directories.cleanup();
});

/** A data directory whose role `main` is `limited/first-model`, falling back to `backup/second-model`. */
async function configured(limited: Endpoint, backup: Endpoint): Promise<string> {
  const directory = directories.create();
  for (const [reference, value] of [
    ["limited.key", "sk-limited"],
    ["backup.key", "sk-backup"],
  ] as const) {
    const file = join(directory, `${reference}.txt`);
    writeFileSync(file, `${value}\n`, { mode: 0o600 });
    expect(await main(["credentials", "set", reference, "--file", file, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
  }
  for (const [connection, url, reference] of [
    ["limited", limited.baseUrl, "limited.key"],
    ["backup", backup.baseUrl, "backup.key"],
  ] as const) {
    expect(
      await main(["models", "add", connection, "--base-url", url, "--credential", reference, "--local-only", "--data-dir", directory], {
        io: capture().io,
      }),
    ).toBe(EXIT.ok);
  }
  expect(
    await main(
      [
        "models",
        "set-role",
        "main",
        "--connection",
        "limited",
        "--model",
        "first-model",
        "--fallback",
        "backup/second-model",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    ),
  ).toBe(EXIT.ok);
  return directory;
}

const events = (stdout: string): ClientEvent[] =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseClientEvent(line));

describe("failover over real HTTP", () => {
  it("answers from the fallback when the first target is rate limited, announcing the new attempt", async () => {
    const limited = await endpoint({
      status: 429,
      body: JSON.stringify({ error: { message: "Rate limit reached", type: "requests" } }),
      headers: { "retry-after": "30" },
    });
    const backup = await endpoint({ says: "Answered by the backup." });
    cleanups.push(limited.close, backup.close);
    const directory = await configured(limited, backup);

    const run = capture();
    expect(await main(["run", "hello", "--format", "json", "--data-dir", directory], { io: run.io })).toBe(EXIT.ok);
    const stream = events(run.stdout());
    const replaced = stream.find((event) => event.kind === "attempt.replaced");
    expect(replaced).toMatchObject({
      kind: "attempt.replaced",
      discarded: true,
      reason: expect.stringContaining("limited/first-model answered rate_limit (retry after 30s); backup/second-model answers"),
    });
    expect(stream.at(-1)).toMatchObject({ kind: "task.completed", finalText: "Answered by the backup." });
    // Each provider called once, with its own credential and its own model.
    expect(limited.requests).toEqual([{ model: "first-model", authorization: "Bearer sk-limited" }]);
    expect(backup.requests).toEqual([{ model: "second-model", authorization: "Bearer sk-backup" }]);
    // The run said where it would fall back to.
    expect(run.stderr()).toContain("using the configured model target limited/first-model (role main)");
    expect(run.stderr()).toContain("falling back to backup/second-model");
  });

  it("does not fail over an exhausted quota: the run fails, and the fallback is never called", async () => {
    const limited = await endpoint({
      status: 429,
      body: JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } }),
    });
    const backup = await endpoint({ says: "never" });
    cleanups.push(limited.close, backup.close);
    const directory = await configured(limited, backup);

    const run = capture();
    expect(await main(["run", "hello", "--format", "json", "--data-dir", directory], { io: run.io })).not.toBe(EXIT.ok);
    expect(events(run.stdout()).some((event) => event.kind === "attempt.replaced")).toBe(false);
    expect(limited.requests).toHaveLength(1);
    expect(backup.requests).toEqual([]);
  });

  it("runs a schedule now on its stored connections, failing over as a run does", async () => {
    // `schedules run-now` composed with the target's options alone, so a stored
    // connection's endpoint and credential were dropped for TAVI_BASE_URL or the
    // OpenAI default; it composes them — and the fallback — as `run` does now.
    const limited = await endpoint({ status: 503, body: JSON.stringify({ error: { message: "overloaded" } }) });
    const backup = await endpoint({ says: "The brief, from the backup." });
    cleanups.push(limited.close, backup.close);
    const directory = await configured(limited, backup);
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "brief",
          "--at",
          "07:00",
          "--timezone",
          "UTC",
          "--prompt",
          "write the brief",
          "--data-dir",
          directory,
        ],
        { io: capture().io },
      ),
    ).toBe(EXIT.ok);
    const fired = capture();
    expect(await main(["schedules", "run-now", "brief", "--data-dir", directory], { io: fired.io })).toBe(EXIT.ok);
    expect(limited.requests).toEqual([{ model: "first-model", authorization: "Bearer sk-limited" }]);
    expect(backup.requests).toEqual([{ model: "second-model", authorization: "Bearer sk-backup" }]);
  });

  it("fails over a provider error after the first token, discarding what the failed call streamed", async () => {
    // One word of an answer, then the provider's own error inside the stream.
    const limited = await endpoint({
      streams: `data: ${JSON.stringify(textChunk("Half an", null))}\n\ndata: ${JSON.stringify({ error: { message: "The server is overloaded", type: "server_error", code: 503 } })}\n\n`,
    });
    const backup = await endpoint({ says: "A whole answer." });
    cleanups.push(limited.close, backup.close);
    const directory = await configured(limited, backup);

    const run = capture();
    expect(await main(["run", "hello", "--format", "json", "--data-dir", directory], { io: run.io })).toBe(EXIT.ok);
    const stream = events(run.stdout());
    const kinds = stream.map((event) => event.kind);
    const partial = stream.findIndex((event) => event.kind === "text.delta" && event.text === "Half an");
    const replaced = kinds.indexOf("attempt.replaced");
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(replaced).toBeGreaterThan(partial);
    expect(stream[replaced]).toMatchObject({ discarded: true, reason: expect.stringContaining("answered provider") });
    expect(stream.at(-1)).toMatchObject({ kind: "task.completed", finalText: "A whole answer." });
  });
});
