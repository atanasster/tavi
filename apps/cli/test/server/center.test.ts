import { fixturePromptPolicy } from "../support/prompt-policy.js";

import { CENTER_SUMMARY_DEFAULT_DAYS, type AgendaAnswer, type CenterSummaryAnswer, type CenterWatchAnswer } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** The `center` command on a live owner: the summary and the long-poll change feed. */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function owner(): Promise<{ readonly handle: ServeHandle; readonly client: IpcClient }> {
  const directory = directories.create("tavi-center-");
  const handle = await serve(
    fixtureServeOptions(directory),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client };
}

/** Admit a task straight into the owner's store, as a chat message or schedule would. */
async function admit(handle: ServeHandle, taskId: string): Promise<void> {
  await handle.runtime.store.asPort().repositories.tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: "default",
    principalId: "operator",
    operationKey: `op-${taskId}`,
    kind: "start",
    intent: { prompt: "hi" },
    checkpointNamespace: "",
    newTaskId: taskId,
    newAdmissionId: `adm-${taskId}`,
    newThreadId: `thread-${taskId}`,
    now: nowTimestamp(),
  });
}

describe("center on a live owner", () => {
  it("names the workspace's language, so the canvas speaks it from its first screen", async () => {
    const { client } = await owner();
    await client.request("workspace-settings", { action: "set", key: "locale", value: "bg" }, "language");
    const summary = await client.request("center", { action: "summary" }, "summary");
    expect((summary.result as CenterSummaryAnswer).locale).toBe("bg");
  });

  it("answers a summary in the workspace zone, and refuses a workspace it does not serve", async () => {
    const { handle, client } = await owner();
    await client.request("workspace-settings", { action: "set", key: "timezone", value: "Asia/Tokyo" }, "zone");
    await admit(handle, "task-1");

    const summary = await client.request("center", { action: "summary" }, "summary");
    expect(summary.ok).toBe(true);
    const answer = summary.result as CenterSummaryAnswer;
    expect(answer).toMatchObject({
      workspaceId: "default",
      timezone: "Asia/Tokyo",
      locale: "en",
      people: { operator: "operator" },
      next: [],
    });
    expect(answer.perDay).toHaveLength(CENTER_SUMMARY_DEFAULT_DAYS);
    expect(answer.perDay.at(-1)).toEqual({ date: answer.today, tasks: 1 });
    expect(answer.counts).toMatchObject({ runningTasks: 1, approvals: 0, schedules: 0 });

    const short = await client.request("center", { action: "summary", days: 3 }, "short");
    expect((short.result as CenterSummaryAnswer).perDay).toHaveLength(3);
    const foreign = await client.request("center", { action: "summary", workspaceId: "elsewhere" }, "foreign");
    expect(foreign.error?.code).toBe("NOT_FOUND");
    const invalid = await client.request("center", { action: "summary", days: 32 }, "invalid");
    expect(invalid.error?.code).toBe("INVALID_INPUT");
  });

  it("answers schedules agenda in the workspace zone, with center summary next as its head", async () => {
    const { client } = await owner();
    await client.request("workspace-settings", { action: "set", key: "timezone", value: "Europe/Berlin" }, "zone");
    const added = await client.request(
      "schedules",
      { action: "add", name: "pills", at: "21:00", timezone: "Europe/Berlin", prompt: "remind me" },
      "add",
    );
    expect(added.ok, added.error?.message).toBe(true);
    // Eight days out, not the default seven: a week holding a fall-back clock change is 7×24h + 1h, so
    // the default window can end just before the seventh 21:00.
    const agenda = await client.request(
      "schedules",
      { action: "agenda", until: new Date(Date.now() + 8 * 86_400_000).toISOString() },
      "agenda",
    );
    expect(agenda.ok, agenda.error?.message).toBe(true);
    const answer = agenda.result as AgendaAnswer;
    expect(answer.timezone).toBe("Europe/Berlin");
    expect(answer).toMatchObject({ truncated: false, skipped: [] });
    // Eight days hold at least seven 21:00s.
    expect(answer.items.length).toBeGreaterThanOrEqual(7);
    expect(answer.items.every((item) => item.kind === "schedule" && item.title === "pills")).toBe(true);
    const summary = (await client.request("center", { action: "summary" }, "summary")).result as CenterSummaryAnswer;
    expect(summary.next).toEqual(answer.items.slice(0, 3).map(({ kind, id, title, at }) => ({ kind, id, title, at })));

    const limited = await client.request("schedules", { action: "agenda", limit: 2 }, "limited");
    expect((limited.result as AgendaAnswer).items).toEqual(answer.items.slice(0, 2));
    expect((limited.result as AgendaAnswer).truncated).toBe(true);
    const wide = await client.request(
      "schedules",
      { action: "agenda", until: new Date(Date.now() + 40 * 86_400_000).toISOString() },
      "wide",
    );
    expect(wide.error?.code).toBe("INVALID_INPUT");
  });

  it("long-polls for a change without holding other requests, and answers the same cursor when nothing changed", async () => {
    const { handle, client } = await owner();
    const first = await client.request("center", { action: "watch" }, "first");
    const { cursor, changed } = first.result as CenterWatchAnswer;
    expect(changed).toEqual([]);

    const quiet = await client.request("center", { action: "watch", cursor, timeoutMs: 1_000 }, "quiet", { timeoutMs: 10_000 });
    expect(quiet.result).toEqual({ cursor, changed: [] });

    const waiting = client.request("center", { action: "watch", cursor, timeoutMs: 20_000 }, "waiting", { timeoutMs: 30_000 });
    // Another request on the same connection answers while the watch waits.
    const started = Date.now();
    expect((await client.request("workspace-settings", { action: "get" }, "meanwhile")).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    await admit(handle, "task-2");
    const woke = (await waiting).result as CenterWatchAnswer;
    expect(woke.changed).toContain("task");
    expect(woke.changed).not.toContain("routine");
    expect(woke.cursor).not.toBe(cursor);

    const stale = await client.request("center", { action: "watch", cursor: "bm90LWEtY3Vyc29y" }, "stale");
    expect(stale.error?.code).toBe("INVALID_INPUT");
  }, 30_000);

  it("ends a waiting watch as soon as the owner starts to shut down", async () => {
    const { handle, client } = await owner();
    const { cursor } = (await client.request("center", { action: "watch" }, "first")).result as CenterWatchAnswer;
    const waiting = client.request("center", { action: "watch", cursor, timeoutMs: 25_000 }, "waiting", { timeoutMs: 30_000 });
    const started = Date.now();
    const stopping = handle.shutdown("test");
    // Either the empty answer or the disconnect: never the full 25 s.
    await waiting.catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(5_000);
    await stopping;
    handles.pop();
  }, 30_000);
});
