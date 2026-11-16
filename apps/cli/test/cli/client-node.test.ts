import { connectToOwner, type TaviClient } from "@tavi/client/node";
import type { ClientEvent } from "@tavi/contracts";
import { needsPosix, waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { ATTACHED, turns, useAttachedOwners } from "../support/attached-owner.js";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

/**
 * `@tavi/client/node` against a real `tavi serve`: the
 * client finds the owner through its discovery files, follows a run, and after
 * a restart finds the new owner the same way and resumes from its cursor.
 */

const owners = useAttachedOwners("tavi-client-node-");
const clients: TaviClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()?.close();
});

describe.skipIf(posixOnly)("@tavi/client/node against tavi serve", () => {
  it("follows a run, and resumes from its cursor on the owner that replaced a restarted one", ATTACHED, async () => {
    const { handle, directory } = await owners.startOwner(turns([]));
    // The defaults: a restart is waited out for about 12 s.
    const client = await connectToOwner(directory);
    clients.push(client);
    expect(client.features).toEqual(expect.arrayContaining(["run", "subscribe", "approve"]));

    const events: ClientEvent[] = [];
    const ends: unknown[] = [];
    const { response, subscription } = await client.run(
      { prompt: "hello", workspaceId: "default", principal: "operator", operationKey: "client-node-1", approval: "client" },
      { onEvent: (event) => events.push(event), onEnd: (error) => ends.push(error) },
    );
    expect(response.ok).toBe(true);
    await waitFor(() => events.some((event) => event.kind === "task.completed"));
    expect(events[0]).toMatchObject({ kind: "run.started", epoch: handle.runtime.ownerSession, sequence: 0 });
    const cursor = subscription?.cursor;
    expect(cursor).toEqual({ epoch: handle.runtime.ownerSession, sequence: events.at(-1)?.sequence });
    expect(client.cursor(subscription?.taskId ?? "")).toEqual(cursor);

    // A restart: a new session and cookie, published afresh. The old events'
    // epoch is gone, so the resumed subscription begins with a resync.
    const states: string[] = [];
    client.onState((state) => states.push(state));
    await owners.stopLatest("restart for the client test");
    const restarted = await owners.startOwner(turns([]), { directory });
    expect(restarted.handle.runtime.ownerSession).not.toBe(handle.runtime.ownerSession);

    const before = events.length;
    await waitFor(() => events.some((event) => event.kind === "resync.required"), 15_000);
    // What follows the restart is the new owner's answer to the old cursor, and
    // nothing from before it again.
    const after = events.slice(before);
    expect(after).toEqual([
      expect.objectContaining({
        kind: "resync.required",
        epoch: restarted.handle.runtime.ownerSession,
        reason: "the owner restarted; events from the previous session cannot be replayed",
      }),
    ]);
    expect(states).toEqual(["reconnecting", "ready"]);
    expect(subscription?.ended).toBe(false);
    expect(ends).toEqual([]);
  });
});
