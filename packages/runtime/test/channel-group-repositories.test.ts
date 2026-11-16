import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { SqliteStore } from "../src/persistence/store.js";

/**
 * The group-chat seam's records: listed rooms and the backfill that keeps every group from
 * before the seam working; where each approval round was delivered; purges
 * scheduled, cancelled and finished; and a principal's sender on a connection.
 */

const AT = "2026-10-17T08:00:00.000Z";
const LATER = "2026-10-18T08:00:00.000Z";

const directories = temporaryDirectories();
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

function fixture(): SqliteStore {
  const directory = directories.create("tavi-channel-groups-");
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  stores.push(store);
  return store;
}

const room = {
  connectionId: "conn-1",
  conversationId: "room-1",
  workspaceId: "default",
  label: "Game night",
  trigger: ["mention", "reply"] as ("mention" | "reply")[],
  members: "bound" as const,
  context: "off" as const,
  introState: "pending" as const,
  createdAt: AT,
  updatedAt: AT,
};

describe("channelRooms", () => {
  it("adds a room, keeps its creation time when changed, and removes one or all of a connection's", async () => {
    const { channelRooms } = fixture().asPort().repositories;
    await channelRooms.upsert(room);
    await channelRooms.upsert({ ...room, conversationId: "room-2" });
    await channelRooms.upsert({ ...room, label: "Games", members: "operator-only", createdAt: LATER, updatedAt: LATER });
    expect(await channelRooms.get("conn-1", "room-1")).toEqual({ ...room, label: "Games", members: "operator-only", updatedAt: LATER });
    expect(await channelRooms.setIntroState("conn-1", "room-1", "sent", LATER)).toBe(true);
    expect((await channelRooms.get("conn-1", "room-1"))?.introState).toBe("sent");
    expect((await channelRooms.listForConnection("conn-1")).map((listed) => listed.conversationId)).toEqual(["room-1", "room-2"]);
    expect(await channelRooms.remove("conn-1", "room-2")).toBe(true);
    expect(await channelRooms.remove("conn-1", "room-2")).toBe(false);
    expect(await channelRooms.removeForConnection("conn-1")).toBe(1);
    expect(await channelRooms.listForConnection("conn-1")).toEqual([]);
  });

  it("keeps a room's autoThread, and none once it is off", async () => {
    const { channelRooms } = fixture().asPort().repositories;
    await channelRooms.upsert({ ...room, autoThread: true });
    expect((await channelRooms.get("conn-1", "room-1"))?.autoThread).toBe(true);
    await channelRooms.upsert(room);
    expect(await channelRooms.get("conn-1", "room-1")).not.toHaveProperty("autoThread");
  });

  it("keeps a connection's grants, one per scope and tool, revokes one, refuses a room's allow, and goes with its connection", async () => {
    const repositories = fixture().asPort().repositories;
    const { messagingGrants } = repositories;
    const grant = {
      grantId: "grant-1",
      workspaceId: "default",
      connectionId: "conn-1",
      scopeKind: "contact" as const,
      scopeId: "u-bob",
      toolId: "fs.write",
      mode: "allow" as const,
      createdBy: "operator",
      createdAt: AT,
    };
    await messagingGrants.put(grant);
    await messagingGrants.put({ ...grant, grantId: "grant-2", scopeKind: "room", scopeId: "room-1", toolId: "web_search", mode: "deny" });
    expect(await messagingGrants.listForScope("conn-1", "contact", "u-bob")).toEqual([grant]);
    expect(await messagingGrants.revoke("grant-1", LATER)).toBe(true);
    expect(await messagingGrants.revoke("grant-1", LATER)).toBe(false);
    expect((await messagingGrants.get("grant-1"))?.revokedAt).toBe(LATER);
    // The same scope and tool again replaces it, in force once more.
    await messagingGrants.put({ ...grant, grantId: "grant-3", mode: "deny", expiresAt: LATER });
    expect(await messagingGrants.listForScope("conn-1", "contact", "u-bob")).toEqual([
      { ...grant, grantId: "grant-3", mode: "deny", expiresAt: LATER },
    ]);
    // Refused as it is saved (this store answers in place; the owner's port, as a rejection).
    await expect(
      Promise.resolve().then(() =>
        messagingGrants.put({ ...grant, grantId: "grant-4", scopeKind: "room", scopeId: "room-1", toolId: "fs.write", mode: "allow" }),
      ),
    ).rejects.toThrow(/never be allowed fs.write/);
    expect((await messagingGrants.listForConnection("conn-1")).map((record) => record.grantId)).toEqual(["grant-2", "grant-3"]);
    // Forgetting the person forgets their contact grants; the room's stay.
    await repositories.channelPurges.forgetSender("conn-1", "u-bob");
    expect((await messagingGrants.listForConnection("conn-1")).map((record) => record.grantId)).toEqual(["grant-2"]);
    expect(await messagingGrants.removeForConnection("conn-1")).toBe(1);
    expect(await messagingGrants.listForConnection("conn-1")).toEqual([]);
  });

  it("refuses a trigger that is no trigger", async () => {
    const { channelRooms } = fixture().asPort().repositories;
    await expect(
      (async () => {
        await channelRooms.upsert({ ...room, trigger: [] });
      })(),
    ).rejects.toThrow(/at least|>=1/);
  });
});

describe("approvalRoundDeliveries", () => {
  it("records a round's card and notice, replaces a repeat, and goes with its round", async () => {
    const store = fixture();
    const { approvalRoundDeliveries } = store.asPort().repositories;
    store.handle
      .prepare(
        "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at) VALUES('task-1','default','operator','t','','running',?,?)",
      )
      .run(AT, AT);
    store.handle
      .prepare(
        "INSERT INTO tavi_approval_rounds(task_id, steps, token, workspace_id, connection_id, conversation_id, message_ids_json, created_at) VALUES('task-1', 3, 'abcdefgh', 'default', 'conn-1', 'room-1', '[]', ?)",
      )
      .run(AT);
    const card = {
      taskId: "task-1",
      steps: 3,
      connectionId: "conn-1",
      role: "card" as const,
      destination: { dmUserId: "7" },
      messageIds: ["m1"],
      text: "card",
      createdAt: AT,
    };
    await approvalRoundDeliveries.record(card);
    await approvalRoundDeliveries.record({
      ...card,
      role: "notice",
      destination: { channelId: "room-1" },
      messageIds: ["m2"],
      text: "notice",
    });
    await approvalRoundDeliveries.record({ ...card, messageIds: ["m1", "m3"] });
    expect(await approvalRoundDeliveries.listForRound("task-1", 3)).toEqual([
      { ...card, messageIds: ["m1", "m3"] },
      { ...card, role: "notice", destination: { channelId: "room-1" }, messageIds: ["m2"], text: "notice" },
    ]);
    store.handle.prepare("DELETE FROM tavi_approval_rounds WHERE task_id = 'task-1'").run();
    expect(await approvalRoundDeliveries.listForRound("task-1", 3)).toEqual([]);
  });

  it("removes a connection's deliveries", async () => {
    const store = fixture();
    const { approvalRoundDeliveries } = store.asPort().repositories;
    store.handle
      .prepare(
        "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at) VALUES('task-1','default','operator','t','','running',?,?)",
      )
      .run(AT, AT);
    store.handle
      .prepare(
        "INSERT INTO tavi_approval_rounds(task_id, steps, token, workspace_id, message_ids_json, created_at) VALUES('task-1', 1, 'abcdefgh', 'default', '[]', ?)",
      )
      .run(AT);
    await approvalRoundDeliveries.record({
      taskId: "task-1",
      steps: 1,
      connectionId: "conn-1",
      role: "card",
      destination: null,
      messageIds: [],
      text: "",
      createdAt: AT,
    });
    expect(await approvalRoundDeliveries.removeForConnection("conn-1")).toBe(1);
  });
});

describe("channelPurges", () => {
  it("schedules a purge, cancels it when the account comes back, and finishes a due one with its counts", async () => {
    const { channelPurges } = fixture().asPort().repositories;
    const purge = {
      connectionId: "conn-1",
      workspaceId: "default",
      providerId: "parrot",
      accountRef: "bot-1",
      requestedAt: AT,
      purgeAfter: LATER,
    };
    await expect(
      (async () => {
        await channelPurges.schedule({ ...purge, accountRef: "" });
      })(),
    ).rejects.toThrow();
    await channelPurges.schedule(purge);
    // A scheduled purge is not pushed back by a second removal of the same connection.
    await channelPurges.schedule({ ...purge, purgeAfter: "2026-12-01T00:00:00.000Z" });
    expect((await channelPurges.get("conn-1"))?.purgeAfter).toBe(LATER);
    expect(await channelPurges.listDue(AT)).toEqual([]);
    expect(await channelPurges.cancelForAccount("parrot", "bot-1", AT)).toEqual(["conn-1"]);
    expect((await channelPurges.get("conn-1"))?.state).toBe("cancelled");
    expect(await channelPurges.listDue(LATER)).toEqual([]);

    await channelPurges.schedule(purge);
    expect((await channelPurges.listDue(LATER)).map((due) => due.connectionId)).toEqual(["conn-1"]);
    expect(await channelPurges.finish("conn-1", { messages: 1 }, LATER)).toBe(false);
    expect(await channelPurges.markRunning("conn-1")).toBe(true);
    // A stopped owner's running purge is due again, whatever the time.
    expect((await channelPurges.listDue(AT)).map((due) => due.connectionId)).toEqual(["conn-1"]);
    await expect(
      (async () => {
        await channelPurges.finish("conn-1", { messages: -1 }, LATER);
      })(),
    ).rejects.toThrow();
    expect(await channelPurges.finish("conn-1", { messages: 3, rooms: 1 }, LATER)).toBe(true);
    expect(await channelPurges.get("conn-1")).toEqual({ ...purge, state: "done", counts: { messages: 3, rooms: 1 }, finishedAt: LATER });
    expect(await channelPurges.cancelForAccount("parrot", "bot-1", LATER)).toEqual([]);
  });

  it("is cancelled only within its grace, and only by the removed connection or one added since its removal", async () => {
    const { channelPurges } = fixture().asPort().repositories;
    const MIDWAY = "2026-10-17T20:00:00.000Z";
    const purge = {
      connectionId: "conn-1",
      workspaceId: "default",
      providerId: "parrot",
      accountRef: "bot-1",
      requestedAt: AT,
      purgeAfter: LATER,
    };
    await channelPurges.schedule(purge);
    // Another connection of the account that was there all along: nothing.
    expect(
      await channelPurges.cancelForAccount("parrot", "bot-1", MIDWAY, { connectionId: "conn-old", createdAt: "2026-10-01T00:00:00.000Z" }),
    ).toEqual([]);
    // Overdue, the sweep not yet run: it still runs.
    expect(
      await channelPurges.cancelForAccount("parrot", "bot-1", "2026-10-18T09:00:00.000Z", { connectionId: "conn-new", createdAt: MIDWAY }),
    ).toEqual([]);
    expect((await channelPurges.get("conn-1"))?.state).toBe("scheduled");
    // The removed connection itself (its plugin reinstalled), or one added since: cancelled.
    expect(await channelPurges.cancelForAccount("parrot", "bot-1", MIDWAY, { connectionId: "conn-1" })).toEqual(["conn-1"]);
    await channelPurges.schedule(purge);
    expect(await channelPurges.cancelForAccount("parrot", "bot-1", MIDWAY, { connectionId: "conn-new", createdAt: MIDWAY })).toEqual([
      "conn-1",
    ]);
  });
});

describe("channelPurges.inventory and erase", () => {
  it("reads what a connection brought in, then erases every row naming it and the targets on it, once", async () => {
    const store = fixture();
    const db = store.handle;
    const { channelPurges } = store.asPort().repositories;
    const inbox = db.prepare(
      "INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at) VALUES (?, ?, 'message', ?, 'processed', ?)",
    );
    inbox.run("conn-1", "evt-1", JSON.stringify({ content: "hi", attachments: [{ artifactId: "art-1" }, { artifactId: "art-2" }] }), AT);
    inbox.run("conn-1", "evt-2", JSON.stringify({ content: "again", attachments: [{ artifactId: "art-1" }] }), AT);
    inbox.run("conn-2", "evt-3", JSON.stringify({ content: "other", attachments: [{ artifactId: "art-9" }] }), AT);
    db.prepare(
      "INSERT INTO tavi_messaging_identity_bindings (connection_id, external_sender_id, workspace_id, principal_id, approved_by, created_at) VALUES (?, ?, 'default', 'operator', 'operator', ?)",
    ).run("conn-1", "7", AT);
    db.prepare("INSERT INTO tavi_routine_delivery_targets VALUES (?, 'default', 'operator', ?)").run(
      "t-1",
      JSON.stringify({ targetId: "t-1", connectionId: "conn-1", chatId: "7" }),
    );
    db.prepare("INSERT INTO tavi_routine_delivery_targets VALUES (?, 'default', 'operator', ?)").run(
      "t-2",
      JSON.stringify({ targetId: "t-2", connectionId: "conn-2", chatId: "8" }),
    );
    db.prepare(
      "INSERT INTO tavi_heartbeats (workspace_id, principal_id, enabled, config_json, created_at, updated_at) VALUES ('default', 'operator', 1, ?, ?, ?)",
    ).run(
      JSON.stringify({
        tellMe: "urgent",
        targets: [
          { connectionId: "conn-1", to: "7" },
          { connectionId: "conn-2", to: "8" },
        ],
      }),
      AT,
      AT,
    );
    await channelPurges.schedule({
      connectionId: "conn-1",
      workspaceId: "default",
      providerId: "parrot",
      accountRef: "bot-1",
      requestedAt: AT,
      purgeAfter: LATER,
    });

    // A frame a video tool made from one of its videos goes with it.
    store.putArtifact({
      artifactId: "art-frame",
      workspaceId: "default",
      runId: "agent-task",
      contentType: "image/jpeg",
      body: "jpg",
      extension: "jpg",
      preview: "video-frame",
      derivedFrom: "art-2",
    });
    store.putArtifact({
      artifactId: "art-unrelated",
      workspaceId: "default",
      runId: "agent-task",
      contentType: "image/jpeg",
      body: "jpg",
      extension: "jpg",
      preview: "video-frame",
      derivedFrom: "art-9",
    });
    expect(await channelPurges.inventory("conn-1")).toEqual({
      taskIds: [],
      artifactIds: ["art-1", "art-2", "art-frame"],
      conversations: 0,
      messages: 2,
      routineTargets: ["t-1"],
      heartbeats: [{ workspaceId: "default", principalId: "operator" }],
    });
    const erased = await channelPurges.erase("conn-1", []);
    expect(erased.counts).toMatchObject({ inbox: 2, bindings: 1, routineTargets: 1, heartbeatTargets: 1 });
    expect(erased.routineTargets).toEqual(["t-1"]);
    expect(erased.heartbeats).toEqual([{ workspaceId: "default", principalId: "operator" }]);
    // The other connection's rows and targets stay; the heartbeat keeps its other target.
    expect((db.prepare("SELECT COUNT(*) AS n FROM tavi_messaging_inbox WHERE connection_id = 'conn-2'").get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare("SELECT target_id FROM tavi_routine_delivery_targets").all() as { target_id: string }[]).map((row) => row.target_id),
    ).toEqual(["t-2"]);
    expect(JSON.parse((db.prepare("SELECT config_json FROM tavi_heartbeats").get() as { config_json: string }).config_json)).toMatchObject({
      tellMe: "urgent",
      targets: [{ connectionId: "conn-2", to: "8" }],
    });
    // Its purge row is kept: it is the counts-only record of what went.
    expect((await channelPurges.get("conn-1"))?.state).toBe("scheduled");
    // Idempotent: a resumed purge erases nothing more.
    expect((await channelPurges.erase("conn-1", [])).counts).toMatchObject({
      inbox: 0,
      bindings: 0,
      routineTargets: 0,
      heartbeatTargets: 0,
    });
  });
});

describe("channelPurges.forgetSender", () => {
  it("erases one sender's messages, held or not, and binding; answers their files and where they spoke, a topic under its group", async () => {
    const store = fixture();
    const db = store.handle;
    const { channelPurges } = store.asPort().repositories;
    const inbox = db.prepare(
      "INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at) VALUES (?, ?, 'message', ?, ?, ?)",
    );
    inbox.run(
      "conn-1",
      "e-1",
      JSON.stringify({ externalSenderId: "bob", externalConversationId: "-100", content: "x", attachments: [{ artifactId: "art-1" }] }),
      "processed",
      AT,
    );
    inbox.run("conn-1", "e-2", JSON.stringify({ externalSenderId: "bob", externalConversationId: "bob", content: "held" }), "received", AT);
    inbox.run(
      "conn-1",
      "e-3",
      JSON.stringify({ externalSenderId: "ann", externalConversationId: "-100", content: "mine", attachments: [{ artifactId: "art-2" }] }),
      "processed",
      AT,
    );
    inbox.run(
      "conn-2",
      "e-4",
      JSON.stringify({ externalSenderId: "bob", externalConversationId: "-100", content: "elsewhere" }),
      "processed",
      AT,
    );
    // Ann picking Bob's message where Bob never spoke to the agent, and replying to one whose words the platform withheld.
    inbox.run(
      "conn-1",
      "e-5",
      JSON.stringify({
        externalSenderId: "ann",
        externalConversationId: "-200",
        content: "Tavi, is this right?",
        referenced: { externalSenderId: "bob", externalMessageId: "m-9", content: "bob's own words", via: "picked" },
      }),
      "processed",
      AT,
    );
    inbox.run(
      "conn-1",
      "e-6",
      JSON.stringify({
        externalSenderId: "ann",
        externalConversationId: "-300",
        content: "agreed",
        referenced: { externalSenderId: "bob", externalMessageId: "m-10", via: "reply" },
      }),
      "processed",
      AT,
    );
    for (const [conversation, task] of [
      ["-100", "task-room"],
      ["-100#topic:7", "task-topic"],
      ["-1000", "task-other"],
      ["-200", "task-picked"],
      ["-300", "task-withheld"],
    ] as const) {
      db.prepare(
        "INSERT INTO tavi_tasks (task_id, workspace_id, principal_id, thread_id, status, created_at, updated_at) VALUES (?, 'default', 'operator', ?, 'completed', ?, ?)",
      ).run(task, `thread-${task}`, AT, AT);
      db.prepare(
        "INSERT INTO tavi_messaging_conversation_tasks (connection_id, external_conversation_id, epoch, active, task_id, created_at) VALUES ('conn-1', ?, 0, 1, ?, ?)",
      ).run(conversation, task, AT);
    }
    db.prepare(
      "INSERT INTO tavi_messaging_identity_bindings (connection_id, external_sender_id, workspace_id, principal_id, approved_by, created_at) VALUES ('conn-1', 'bob', 'default', 'bob', 'operator', ?)",
    ).run(AT);

    store.putArtifact({
      artifactId: "art-bob-sheet",
      workspaceId: "default",
      runId: "task-room",
      contentType: "image/jpeg",
      body: "jpg",
      extension: "jpg",
      preview: "video-sheet",
      derivedFrom: "art-1",
    });
    const footprint = await channelPurges.senderFootprint("conn-1", "bob");
    // Their video's sheet is theirs too, though no task of theirs is forgotten.
    expect(footprint).toMatchObject({ messages: 2, artifactIds: ["art-1", "art-bob-sheet"], principalId: "bob" });
    // Where Ann's message quoted Bob's words holds them too; where none were carried, nothing of his is there.
    expect(footprint.conversations).toEqual(
      expect.arrayContaining([
        { conversationId: "-100", taskIds: ["task-room", "task-topic"] },
        { conversationId: "bob", taskIds: [] },
        { conversationId: "-200", taskIds: ["task-picked"] },
      ]),
    );
    expect(footprint.conversations.map((conversation) => conversation.conversationId)).not.toContain("-300");
    // Reading takes nothing away.
    expect((db.prepare("SELECT COUNT(*) AS n FROM tavi_messaging_inbox").get() as { n: number }).n).toBe(6);
    expect(await channelPurges.forgetSender("conn-1", "bob")).toEqual({ messages: 2, quoted: 1, bindingRemoved: true });
    const left = (
      db.prepare("SELECT provider_event_id FROM tavi_messaging_inbox ORDER BY provider_event_id").all() as { provider_event_id: string }[]
    ).map((row) => row.provider_event_id);
    expect(left).toEqual(["e-3", "e-4", "e-5", "e-6"]);
    // Ann's message stays, her words and whose message she picked with it; Bob's words are gone from it.
    const picked = JSON.parse(
      (db.prepare("SELECT payload_json FROM tavi_messaging_inbox WHERE provider_event_id = 'e-5'").get() as { payload_json: string })
        .payload_json,
    ) as Record<string, unknown>;
    expect(picked).toEqual({
      externalSenderId: "ann",
      externalConversationId: "-200",
      content: "Tavi, is this right?",
      referenced: { externalSenderId: "bob", externalMessageId: "m-9", via: "picked" },
    });
    expect(await channelPurges.forgetSender("conn-1", "bob")).toEqual({ messages: 0, quoted: 0, bindingRemoved: false });
    expect(await channelPurges.senderFootprint("conn-1", "bob")).toEqual({ messages: 0, artifactIds: [], conversations: [] });
  });
});

describe("messagingIdentityBindings.senderOf", () => {
  it("answers the earliest sender bound to a principal on a connection, and none elsewhere", async () => {
    const { messagingIdentityBindings } = fixture().asPort().repositories;
    const binding = { connectionId: "conn-1", workspaceId: "default", principalId: "operator", approvedBy: "operator" };
    await messagingIdentityBindings.bind({ ...binding, externalSenderId: "200", createdAt: LATER });
    await messagingIdentityBindings.bind({ ...binding, externalSenderId: "100", createdAt: AT });
    expect(await messagingIdentityBindings.senderOf("conn-1", "operator")).toBe("100");
    expect(await messagingIdentityBindings.senderOf("conn-2", "operator")).toBeUndefined();
    expect(await messagingIdentityBindings.senderOf("conn-1", "someone")).toBeUndefined();
  });
});
