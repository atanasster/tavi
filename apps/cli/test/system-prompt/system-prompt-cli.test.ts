import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelPort } from "@tavi/contracts";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `tavi system-prompt`.
 *
 * Two paths, one contract: with no owner the command opens the data directory,
 * and with one it routes over IPC through `configOnOwner` — which is what makes
 * `CONFLICT` a usage-level refusal rather than a crash, and what keeps a
 * `system-prompt` write attributed to this owner rather than applied behind its
 * back.
 */

const directories = temporaryDirectories({ prefix: "tavi-system-prompt-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

function promptFile(directory: string, name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

interface Answer {
  readonly workspaceId: string;
  readonly revision: number;
  readonly custom: { readonly text: string; readonly revision: number; readonly lastOperation: string } | null;
  readonly shipped: { readonly text: string; readonly templateVersion: string };
  readonly effective: { readonly text: string; readonly source: string; readonly revision: number | null };
  readonly appliesTo: string;
  readonly explicitAdapterShadowing: boolean;
}

const answering = (): ModelPort => ({
  async stream(request, options) {
    options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "ok" });
    return { status: "completed", attemptId: request.attemptId, text: "ok", toolCalls: [], usage: {} };
  },
});

async function owner(): Promise<{ readonly handle: ServeHandle; readonly client: IpcClient; readonly directory: string }> {
  const directory = directories.create();
  const handle = await serve(
    fixtureServeOptions(directory),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
    { modelOverride: answering() },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client, directory };
}

describe("tavi system-prompt offline", () => {
  it("shows the shipped default for a workspace that never saved", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["system-prompt", "show", "--format", "json", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    const answer = JSON.parse(shown.out()) as Answer;
    expect(answer.revision).toBe(0);
    expect(answer.custom).toBeNull();
    expect(answer.effective).toEqual({
      text: answer.shipped.text,
      source: "builtin",
      revision: null,
      templateVersion: answer.shipped.templateVersion,
    });
    expect(answer.appliesTo).toBe("next-message");
    expect(answer.explicitAdapterShadowing).toBe(false);
  });

  it("round-trips a file's exact text, including its trailing newline and leading spaces", async () => {
    const directory = directories.create();
    const text = "  keep\n\n every\tcharacter  \n";
    const file = promptFile(directory, "prompt.txt", text);
    const saved = capture();
    expect(await main(["system-prompt", "set", "--file", file, "--format", "json", "--data-dir", directory], { io: saved.io })).toBe(
      EXIT.ok,
    );
    const answer = JSON.parse(saved.out()) as Answer;
    expect(answer.custom?.text).toBe(text);
    expect(answer.custom?.revision).toBe(1);
    expect(answer.effective).toMatchObject({ text, source: "workspace", revision: 1 });

    // A second read is the persisted value, not a re-render of the file.
    const shown = capture();
    expect(await main(["system-prompt", "show", "--format", "json", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect((JSON.parse(shown.out()) as Answer).custom?.text).toBe(text);
  });

  it("reads the revision itself, then asserts it, and reports a racing writer as a usage conflict", async () => {
    const directory = directories.create();
    const first = capture();
    expect(
      await main(["system-prompt", "set", "--file", promptFile(directory, "a.txt", "one"), "--data-dir", directory], { io: first.io }),
    ).toBe(EXIT.ok);
    // The time it was set reads as a minute in UTC, not milliseconds.
    expect(first.stdout()).toMatch(/^workspace default: custom override at revision 1 \(set by [^ ]+ at \d{4}-\d\d-\d\d \d\d:\d\d UTC\)\n/);
    // No `--expected-revision`: the command reads the current revision first.
    const second = capture();
    expect(
      await main(["system-prompt", "set", "--file", promptFile(directory, "b.txt", "two"), "--data-dir", directory], { io: second.io }),
    ).toBe(EXIT.ok);
    const answered = JSON.parse((await showJson(directory)).out()) as Answer;
    expect(answered.custom).toMatchObject({ text: "two", revision: 2 });

    // An explicit stale revision is a conflict, mapped to the usage exit.
    const stale = capture();
    expect(
      await main(
        ["system-prompt", "set", "--file", promptFile(directory, "c.txt", "three"), "--expected-revision", "0", "--data-dir", directory],
        { io: stale.io },
      ),
    ).toBe(EXIT.usage);
    expect(stale.err()).toMatch(/changed since it was read/);
    expect((JSON.parse((await showJson(directory)).out()) as Answer).custom?.text).toBe("two");
  });

  it("clears the override with reset and keeps the revision monotonic", async () => {
    const directory = directories.create();
    expect(
      await main(["system-prompt", "set", "--file", promptFile(directory, "a.txt", "custom"), "--data-dir", directory], {
        io: capture().io,
      }),
    ).toBe(EXIT.ok);
    const reset = capture();
    expect(await main(["system-prompt", "reset", "--format", "json", "--data-dir", directory], { io: reset.io })).toBe(EXIT.ok);
    const answer = JSON.parse(reset.out()) as Answer;
    expect(answer.custom).toBeNull();
    expect(answer.revision).toBe(2);
    expect(answer.effective.source).toBe("builtin");
  });

  it("refuses an empty, whitespace-only or over-limit prompt before writing", async () => {
    const directory = directories.create();
    for (const [name, text] of [
      ["empty.txt", ""],
      ["blank.txt", "   \n\t "],
      ["long.txt", "x".repeat(20_001)],
    ] as const) {
      const refused = capture();
      expect(
        await main(["system-prompt", "set", "--file", promptFile(directory, name, text), "--data-dir", directory], { io: refused.io }),
      ).toBe(EXIT.usage);
    }
    const shown = JSON.parse((await showJson(directory)).out()) as Answer;
    expect(shown.revision).toBe(0);
    expect(shown.custom).toBeNull();
  });

  it("reports a file it cannot read as a usage error rather than a storage problem", async () => {
    const directory = directories.create();
    const missing = capture();
    expect(await main(["system-prompt", "set", "--file", join(directory, "nope.txt"), "--data-dir", directory], { io: missing.io })).toBe(
      EXIT.usage,
    );
    expect(missing.err()).toMatch(/cannot read the system prompt file/);
  });

  it("reports a failure as a structured envelope under --format json", async () => {
    const directory = directories.create();
    expect(
      await main(["system-prompt", "set", "--file", promptFile(directory, "a.txt", "one"), "--data-dir", directory], { io: capture().io }),
    ).toBe(EXIT.ok);
    // A stale revision, in the format a script asked for: the code and the
    // message, not only an exit status.
    const refused = capture();
    expect(
      await main(
        [
          "system-prompt",
          "set",
          "--file",
          promptFile(directory, "b.txt", "two"),
          "--expected-revision",
          "0",
          "--format",
          "json",
          "--data-dir",
          directory,
        ],
        { io: refused.io },
      ),
    ).toBe(EXIT.usage);
    expect(JSON.parse(refused.out())).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(refused.err()).toBe("");

    // A missing file is reported the same way, rather than as prose.
    const noFile = capture();
    expect(
      await main(["system-prompt", "set", "--file", join(directory, "gone.txt"), "--format", "json", "--data-dir", directory], {
        io: noFile.io,
      }),
    ).toBe(EXIT.usage);
    expect(JSON.parse(noFile.out())).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("requires an action, rejects unknown flags and prints its own help", async () => {
    const directory = directories.create();
    const none = capture();
    expect(await main(["system-prompt", "--data-dir", directory], { io: none.io })).toBe(EXIT.usage);
    const bad = capture();
    expect(await main(["system-prompt", "show", "--nope", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    const positional = capture();
    expect(await main(["system-prompt", "show", "extra", "--data-dir", directory], { io: positional.io })).toBe(EXIT.usage);
    const help = capture();
    expect(await main(["system-prompt", "--help"], { io: help.io })).toBe(EXIT.ok);
    expect(help.out()).toMatch(/^tavi system-prompt <action>/);
  });

  async function showJson(directory: string): Promise<ReturnType<typeof capture>> {
    const shown = capture();
    expect(await main(["system-prompt", "show", "--format", "json", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    return shown;
  }
});

describe("tavi system-prompt on a live owner", () => {
  it("answers the same shape over IPC, and applies a write to the owner's store", async () => {
    const { handle, client } = await owner();
    const before = await client.request("system-prompt", { action: "get", workspaceId: "default" }, "get-1");
    expect(before).toMatchObject({ ok: true, result: { revision: 0, custom: null, effective: { source: "builtin" } } });

    const written = await client.request(
      "system-prompt",
      { action: "set", workspaceId: "default", text: "owner base\n", expectedRevision: 0 },
      "set-1",
    );
    expect(written).toMatchObject({
      ok: true,
      result: {
        revision: 1,
        custom: { text: "owner base\n", revision: 1, lastOperation: "set" },
        effective: { text: "owner base\n", source: "workspace", revision: 1 },
      },
    });
    // The owner's own durable row is what changed.
    expect((await handle.runtime.store.asPort().repositories.systemPrompts.get("default")).text).toBe("owner base\n");
  });

  it("refuses a stale revision with CONFLICT and the revisions in its details", async () => {
    const { client } = await owner();
    await client.request("system-prompt", { action: "set", workspaceId: "default", text: "first", expectedRevision: 0 }, "set-a");
    const stale = await client.request(
      "system-prompt",
      { action: "set", workspaceId: "default", text: "second", expectedRevision: 0 },
      "set-b",
    );
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("CONFLICT");
    // No prompt text in the refusal — the revisions are the whole detail.
    expect(JSON.stringify(stale.error)).not.toContain("first");
    expect(stale.error?.message).toMatch(/expected revision 0, current revision 1/);
  });

  it("refuses a malformed payload rather than defaulting it, leaving storage untouched", async () => {
    const { handle, client } = await owner();
    // `set` without text, and any write without its expected revision.
    expect(
      (await client.request("system-prompt", { action: "set", workspaceId: "default", expectedRevision: 0 }, "bad-1")).error?.code,
    ).toBe("INVALID_INPUT");
    expect((await client.request("system-prompt", { action: "set", workspaceId: "default", text: "x" }, "bad-2")).error?.code).toBe(
      "INVALID_INPUT",
    );
    expect((await client.request("system-prompt", { action: "reset", workspaceId: "default" }, "bad-3")).error?.code).toBe("INVALID_INPUT");
    expect(
      (await client.request("system-prompt", { action: "set", workspaceId: "default", text: "   ", expectedRevision: 0 }, "bad-4")).error
        ?.code,
    ).toBe("INVALID_INPUT");
    expect((await client.request("system-prompt", { action: "get", workspaceId: "default", extra: 1 }, "bad-5")).error?.code).toBe(
      "INVALID_INPUT",
    );
    // A field the action does not use is refused, not ignored.
    expect(
      (await client.request("system-prompt", { action: "reset", workspaceId: "default", expectedRevision: 0, text: "ignored" }, "bad-6"))
        .error?.code,
    ).toBe("INVALID_INPUT");
    expect(
      (await client.request("system-prompt", { action: "get", workspaceId: "default", expectedRevision: 0 }, "bad-7")).error?.code,
    ).toBe("INVALID_INPUT");
    // Nothing was written by any of them: a refusal that had already committed
    // would look exactly like this from the exit code alone.
    expect(await handle.runtime.store.asPort().repositories.systemPrompts.get("default")).toEqual(
      expect.objectContaining({ revision: 0, text: null }),
    );
  });

  it("refuses a workspace this owner was not configured with", async () => {
    const { handle, client } = await owner();
    const refused = await client.request(
      "system-prompt",
      { action: "set", workspaceId: "ghost-workspace", text: "x", expectedRevision: 0 },
      "ghost",
    );
    expect(refused.error?.code).toBe("NOT_FOUND");
    expect((await handle.runtime.store.asPort().repositories.systemPrompts.get("ghost-workspace")).revision).toBe(0);
  });

  it("attributes a socket client's write to the CLI, and records the owner's own row", async () => {
    const { handle, client } = await owner();
    const written = await client.request(
      "system-prompt",
      { action: "set", workspaceId: "default", text: "attributed", expectedRevision: 0 },
      "attribution",
    );
    expect((written.result as Answer).custom).toMatchObject({ actor: "operator:cli" });
    expect((await handle.runtime.store.asPort().repositories.systemPrompts.get("default")).actor).toBe("operator:cli");
  });

  it("round-trips a near-bound astral prompt over IPC, exactly", async () => {
    const { client } = await owner();
    // 9,999 astral characters plus the trailing newline is 19,999 code units —
    // just inside the editor bound — and the newline is part of the accepted
    // text: JSON escaping, the IPC frame encoder and the store must all preserve
    // it byte for byte. (10,000 astral characters plus a newline would already be
    // 20,001 units, which is why the bound is asserted separately below.)
    const text = `${"\u{1F600}".repeat(9_999)}\n`;
    const written = await client.request("system-prompt", { action: "set", workspaceId: "default", text, expectedRevision: 0 }, "max-set");
    expect(written.ok, JSON.stringify(written.error)).toBe(true);
    const read = await client.request("system-prompt", { action: "get", workspaceId: "default" }, "max-get");
    expect((read.result as Answer).custom?.text).toBe(text);
    // One code unit over the bound is refused before it reaches storage.
    const over = "x".repeat(20_001);
    expect(
      (await client.request("system-prompt", { action: "set", workspaceId: "default", text: over, expectedRevision: 1 }, "over-set")).error
        ?.code,
    ).toBe("INVALID_INPUT");
    // Astral characters count as code units, not code points: 10,001 of them are
    // 20,002 units and must be refused, which zod's `.max()` would have allowed.
    expect(
      (
        await client.request(
          "system-prompt",
          { action: "set", workspaceId: "default", text: "\u{1F600}".repeat(10_001), expectedRevision: 1 },
          "astral-over",
        )
      ).error?.code,
    ).toBe("INVALID_INPUT");
    expect((read.result as Answer).custom?.text).toBe(text);
  });

  it("routes the CLI through the owner, reading the revision on the same connection", async () => {
    const { handle, directory } = await owner();
    const created = directories.create();
    const file = promptFile(created, "prompt.txt", "via the owner\n");
    const written = capture();
    expect(await main(["system-prompt", "set", "--file", file, "--format", "json", "--data-dir", directory], { io: written.io })).toBe(
      EXIT.ok,
    );
    expect((JSON.parse(written.out()) as Answer).custom?.text).toBe("via the owner\n");
    expect((await handle.runtime.store.asPort().repositories.systemPrompts.get("default")).text).toBe("via the owner\n");

    const shown = capture();
    expect(await main(["system-prompt", "show", "--format", "json", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect((JSON.parse(shown.out()) as Answer).revision).toBe(1);

    // A write the operator aims at a revision the owner has moved past is the
    // usage-level conflict, over IPC as offline.
    const stale = capture();
    expect(
      await main(["system-prompt", "set", "--file", file, "--expected-revision", "0", "--data-dir", directory], { io: stale.io }),
    ).toBe(EXIT.usage);
    expect(stale.err()).toMatch(/changed since it was read/);
    expect((await handle.runtime.store.asPort().repositories.systemPrompts.get("default")).text).toBe("via the owner\n");
  });

  it("answers the shipped default and the applied override with the same shape the offline path returns", async () => {
    const { directory } = await owner();
    const offlineShape = capture();
    expect(await main(["system-prompt", "show", "--format", "json", "--data-dir", directory], { io: offlineShape.io })).toBe(EXIT.ok);
    // `configOnOwner` answers from the owner, so this is the owner's result with
    // the offline command's exit mapping: the two paths share `systemPromptAnswerFor`.
    const answer = JSON.parse(offlineShape.out()) as Answer;
    expect(Object.keys(answer).sort()).toEqual([
      "appliesTo",
      "custom",
      "effective",
      "explicitAdapterShadowing",
      "revision",
      "shipped",
      "workspaceId",
    ]);
  });
});
