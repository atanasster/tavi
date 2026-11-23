import { join } from "node:path";

import {
  TRUSTED_PUBLIC,
  evaluateGate,
  labelledResult,
  toolResultLabel,
  seededReminderRule,
  trustedLabel,
  untrustedLabel,
  type ContentLabel,
  type InvocationContext,
} from "@tavi/contracts";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { registerReminderTools } from "../../src/features/reminders/tools.js";
import { SqliteStore } from "../support/database-fixture.js";

/** The context an assessor is given with a call; these tools do not read it. */
const assessContext = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };

/**
 * The agent's reminder tools: idempotent, scoped to the asking
 * person, delivered where the task came from, answered with a read-back, and
 * asking when a tainted conversation would start a task or change a reminder.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const NOW = new Date("2026-10-01T10:00:00.000Z"); // Thursday

async function fixture() {
  const directory = directories.create("tavi-reminder-tools-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const repositories = store.asPort().repositories;
  await repositories.workspaceSettings.set({
    workspaceId: "default",
    settings: { timezone: "Europe/Berlin" },
    expectedRevision: 0,
    actor: "operator",
    now: NOW.toISOString(),
  });
  await repositories.tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: "default",
    principalId: "alice",
    operationKey: "op-chat",
    kind: "start",
    intent: { prompt: "hi" },
    checkpointNamespace: "",
    newTaskId: "t-chat",
    newAdmissionId: "adm-chat",
    newThreadId: "thread-chat",
    now: NOW.toISOString(),
  });
  await repositories.messagingConversations.record({
    connectionId: "telegram-main",
    externalConversationId: "chat-1",
    taskId: "t-chat",
    createdAt: NOW.toISOString(),
    replyTo: { connectionId: "telegram-main", externalConversationId: "chat-1", externalSenderId: "user-1" },
  });
  const registry = new ToolRegistry();
  let serial = 0;
  registerReminderTools(registry, {
    repositories,
    isLocalConnection: (connectionId) => connectionId.startsWith("local:"),
    now: () => NOW,
    newId: () => `id-${(serial += 1)}`,
  });
  const context = (principalId: string, runId: string): InvocationContext => ({
    workspaceId: "default",
    principalId,
    runId,
    caller: "test",
  });
  const call = (name: string, input: unknown, invocation: InvocationContext, contextLabel?: ContentLabel) =>
    registry.get(`reminders.${name}`)?.handler({
      input,
      context: invocation,
      signal: AbortSignal.timeout(5_000),
      ...(contextLabel === undefined ? {} : { contextLabel }),
    });
  return { store, repositories, registry, context, call };
}

const dentist = { text: "Dentist appointment", when: { kind: "event", at: "2026-10-05T10:00+02:00" }, operationKey: "dentist" } as const;

describe("reminders.create", () => {
  it("names every repeat there is, and tells the model to say so when asked for another, promising no one-off that reschedules itself", async () => {
    const { registry, store } = await fixture();
    try {
      const description = registry.get("reminders.create")?.description ?? "";
      expect(description).toMatch(/The only repeats are days of the week, monthly and yearly/);
      expect(description).toMatch(/every two weeks.*every three months/);
      expect(description).toMatch(/say plainly that a reminder can't repeat that, and offer the nearest/);
      expect(description).toMatch(/one-off never reschedules itself/);
    } finally {
      store.close();
    }
  });

  it("fills in the default notices, delivers to the task's chat and reads the time back", async () => {
    const { call, context, repositories, store } = await fixture();
    try {
      const answer = await call("create", dentist, context("alice", "t-chat"));
      expect(answer).toMatchObject({
        text: "Dentist appointment",
        status: "active",
        created: true,
        skippedNotices: [],
        deliveredTo: "this conversation",
        readBack: "Mon 5 Oct 10:00 Europe/Berlin; I'll remind you Sun 20:00 and Mon 09:00",
      });
      const stored = await repositories.reminders.get((answer as { reminderId: string }).reminderId);
      expect(stored).toMatchObject({
        principalId: "alice",
        createdBy: "agent",
        originTaskId: "t-chat",
        timezone: "Europe/Berlin",
        when: { kind: "event", notify: ["-1d@20:00", "-1h"] },
        deliverTo: { kind: "conversation", connectionId: "telegram-main", conversationId: "chat-1" },
      });
    } finally {
      await store.close();
    }
  });

  it("is idempotent on its operation key, answers a duplicate with the first, and delivers a task without a chat in the app", async () => {
    const { call, context, store } = await fixture();
    try {
      const first = (await call("create", dentist, context("alice", "t-chat"))) as { reminderId: string };
      expect(await call("create", dentist, context("alice", "t-chat"))).toMatchObject({ reminderId: first.reminderId, created: false });
      expect(await call("create", { ...dentist, operationKey: "again" }, context("alice", "t-chat"))).toMatchObject({
        reminderId: first.reminderId,
        created: false,
        duplicate: true,
      });
      expect(
        await call(
          "create",
          { text: "Stretch", when: { kind: "repeat", times: ["08:00", "20:00"] }, operationKey: "k" },
          context("alice", "t-web"),
        ),
      ).toMatchObject({
        deliveredTo: "the app",
        readBack: "every day at 08:00 and 20:00 Europe/Berlin; next Thu 1 Oct 20:00",
      });
      await expect(
        call("create", { text: "Late", when: { kind: "once", at: "2026-09-30T10:00Z" }, operationKey: "past" }, context("alice", "t-chat")),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "That time is in the past" });
    } finally {
      await store.close();
    }
  });

  it("delivers a reminder asked in the person's Home into Home, as a notice", async () => {
    const { call, context, repositories, store } = await fixture();
    try {
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "alice",
        operationKey: "op-home",
        kind: "start",
        intent: { prompt: "hi" },
        checkpointNamespace: "",
        chatKind: "home",
        newTaskId: "t-home",
        newAdmissionId: "adm-home",
        newThreadId: "thread-home",
        now: NOW.toISOString(),
      });
      const answer = (await call(
        "create",
        { text: "Stretch", when: { kind: "once", at: "2026-10-02T10:00+02:00" }, operationKey: "home" },
        {
          ...context("alice", "t-home"),
          messagingReplyTo: { connectionId: "local:default", externalConversationId: "home:alice", externalSenderId: "alice" },
        },
      )) as { reminderId: string; deliveredTo: string };
      expect(answer.deliveredTo).toBe("Home");
      expect(await repositories.reminders.get(answer.reminderId)).toMatchObject({ deliverTo: { kind: "home" } });
    } finally {
      await store.close();
    }
  });

  it("reads a time without an offset in the reminder's zone on its own date, past a daylight-saving change", async () => {
    const { call, context, repositories, store } = await fixture();
    try {
      // Berlin is at +02:00 today and at +01:00 after 25 October.
      const winter = (await call(
        "create",
        { text: "Boiler service", when: { kind: "once", at: "2026-11-02T10:00" }, operationKey: "boiler" },
        context("alice", "t-chat"),
      )) as { reminderId: string; readBack: string };
      expect(winter.readBack).toBe("Mon 2 Nov 10:00 Europe/Berlin; I'll remind you then");
      expect(await repositories.reminders.get(winter.reminderId)).toMatchObject({ when: { kind: "once", at: "2026-11-02T09:00:00.000Z" } });
      // In a zone the model names, and changed by an update in the reminder's own zone.
      const tokyo = (await call(
        "create",
        { text: "Call", when: { kind: "event", at: "2026-10-05T10:00" }, timezone: "Asia/Tokyo", operationKey: "call" },
        context("alice", "t-chat"),
      )) as { reminderId: string };
      expect(await repositories.reminders.get(tokyo.reminderId)).toMatchObject({ when: { kind: "event", at: "2026-10-05T01:00:00.000Z" } });
      await call("update", { reminderId: tokyo.reminderId, when: { kind: "once", at: "2026-10-06T09:30" } }, context("alice", "t-chat"));
      expect(await repositories.reminders.get(tokyo.reminderId)).toMatchObject({ when: { kind: "once", at: "2026-10-06T00:30:00.000Z" } });
      // A time with an offset is taken as given; a date that does not exist is refused.
      const given = (await call(
        "create",
        { text: "Given", when: { kind: "once", at: "2026-11-02T10:00+02:00" }, operationKey: "given" },
        context("alice", "t-chat"),
      )) as { reminderId: string };
      expect(await repositories.reminders.get(given.reminderId)).toMatchObject({ when: { kind: "once", at: "2026-11-02T08:00:00.000Z" } });
      await expect(
        call(
          "create",
          { text: "Never", when: { kind: "once", at: "2026-02-30T10:00" }, operationKey: "never" },
          context("alice", "t-chat"),
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      await store.close();
    }
  });

  it("records a delegated worker's reminder as asked in the delegation root, which is where it is delivered", async () => {
    const { call, context, repositories, store } = await fixture();
    try {
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "alice",
        operationKey: "op-worker",
        kind: "start",
        intent: { prompt: "remind her" },
        checkpointNamespace: "",
        newTaskId: "t-worker",
        newAdmissionId: "adm-worker",
        newThreadId: "thread-worker",
        now: NOW.toISOString(),
      });
      await repositories.agentDelegations.recordSpawn({
        operationKey: "spawn",
        workspaceId: "default",
        principalId: "alice",
        workerTaskId: "t-worker",
        workerAgentId: "helper",
        parentTaskId: "t-chat",
        rootTaskId: "t-chat",
        depth: 1,
        createdAt: NOW.toISOString(),
      });
      const answer = (await call("create", dentist, context("alice", "t-worker"))) as { reminderId: string; deliveredTo: string };
      expect(answer.deliveredTo).toBe("this conversation");
      expect(await repositories.reminders.get(answer.reminderId)).toMatchObject({
        originTaskId: "t-chat",
        deliverTo: { kind: "conversation", connectionId: "telegram-main", conversationId: "chat-1" },
      });
    } finally {
      await store.close();
    }
  });
});

describe("a reminder made or changed under taint", () => {
  it("keeps the creating call's label, a text-only one too; a clean call stores none; a change under taint joins its own", async () => {
    const { call, context, repositories, store } = await fixture();
    try {
      const page = untrustedLabel("web", {
        principal: "host:sale.example",
        ref: { ref: "call-1", host: "sale.example", at: NOW.toISOString() },
      });
      const tainted = (await call(
        "create",
        { text: "Sale ends", prompt: "Check the sale page", when: { kind: "once", at: "2026-10-03T09:00" }, operationKey: "sale" },
        context("alice", "t-chat"),
        page,
      )) as { reminderId: string };
      expect((await repositories.reminders.get(tainted.reminderId))?.label).toEqual(page);
      const textOnly = (await call(
        "create",
        { text: "Sale ends soon", when: { kind: "once", at: "2026-10-03T08:00" }, operationKey: "sale-text" },
        context("alice", "t-chat"),
        page,
      )) as { reminderId: string };
      expect((await repositories.reminders.get(textOnly.reminderId))?.label).toEqual(page);
      const clean = (await call("create", dentist, context("alice", "t-chat"), TRUSTED_PUBLIC)) as { reminderId: string };
      expect((await repositories.reminders.get(clean.reminderId))?.label).toBeUndefined();
      // Made from private data, though trusted: kept, so its task starts as private,
      // and a list that shows it, from a clean chat, is private too — though not untrusted.
      const personal = (await call(
        "create",
        { text: "Pay the rent", when: { kind: "once", at: "2026-10-03T07:00" }, operationKey: "rent" },
        context("carol", "t-carol"),
        trustedLabel("personal"),
      )) as { reminderId: string };
      expect((await repositories.reminders.get(personal.reminderId))?.label).toEqual(trustedLabel("personal"));
      const rent = labelledResult(await call("list", {}, context("carol", "t-carol"), TRUSTED_PUBLIC));
      expect(rent.untrusted).toBe(false);
      expect(
        toolResultLabel(
          { builtIn: true },
          { id: "c-list", input: {} },
          { untrusted: rent.untrusted, ...(rent.label === undefined ? {} : { label: rent.label }) },
          NOW.toISOString(),
        ),
      ).toMatchObject({ integrity: "trusted", confidentiality: "personal" });
      // A clean change keeps what it holds; one under taint joins its label.
      await call("update", { reminderId: tainted.reminderId, text: "Sale ends Friday" }, context("alice", "t-chat"), TRUSTED_PUBLIC);
      expect((await repositories.reminders.get(tainted.reminderId))?.label).toEqual(page);
      const search = untrustedLabel("search", { ref: { ref: "call-2", at: NOW.toISOString() } });
      await call("update", { reminderId: clean.reminderId, prompt: "Book the dentist" }, context("alice", "t-chat"), search);
      expect((await repositories.reminders.get(clean.reminderId))?.label).toEqual(search);
      await call("update", { reminderId: tainted.reminderId, text: "Sale ends Saturday" }, context("alice", "t-chat"), search);
      expect((await repositories.reminders.get(tainted.reminderId))?.label?.sources).toEqual(["web", "search"]);
      // Its words come back labelled to a clean chat that lists or changes it; a clean reminder's answer is not.
      const listed = labelledResult(await call("list", {}, context("alice", "t-chat"), TRUSTED_PUBLIC));
      expect(listed.label).toMatchObject({
        untrusted: true,
        source: "web",
        stored: { integrity: "untrusted", sources: ["web", "search"] },
      });
      expect(
        labelledResult(
          await call("update", { reminderId: tainted.reminderId, text: "Sale ends Sunday" }, context("alice", "t-chat"), TRUSTED_PUBLIC),
        ).label,
      ).toMatchObject({ untrusted: true });
      expect(
        labelledResult(
          await call(
            "create",
            { text: "Water the plants", when: { kind: "once", at: "2026-10-04T09:00" }, operationKey: "plants" },
            context("alice", "t-chat"),
            TRUSTED_PUBLIC,
          ),
        ).label,
      ).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

describe("one person's reminders", () => {
  it("creates a monthly repeat, pages a long list with its cursor, and takes a snooze of up to a week", async () => {
    const { call, context, registry, store } = await fixture();
    try {
      const rent = await call(
        "create",
        { text: "Pay rent", when: { kind: "repeat", times: ["09:00"], monthly: { nth: -1, weekday: 5 } }, operationKey: "rent" },
        context("alice", "t-chat"),
      );
      expect((rent as { readBack: string }).readBack).toMatch(/last Fri/);
      for (let index = 0; index < 54; index += 1)
        await call(
          "create",
          { text: `Water plant ${index}`, when: { kind: "repeat", times: ["08:00"] }, operationKey: `p${index}` },
          context("alice", "t-chat"),
        );
      const first = (await call("list", {}, context("alice", "t-chat"))) as { reminders: unknown[]; nextCursor?: string };
      expect(first.reminders).toHaveLength(50);
      expect(first.nextCursor).toBeDefined();
      const rest = (await call("list", { cursor: first.nextCursor }, context("alice", "t-chat"))) as {
        reminders: unknown[];
        nextCursor?: string;
      };
      expect(rest.reminders).toHaveLength(5);
      expect(rest.nextCursor).toBeUndefined();
      const snooze = registry.inputSchemaOf("reminders.snooze");
      expect(snooze?.safeParse({ reminderId: "r", minutes: 1_440 }).success).toBe(true);
      expect(snooze?.safeParse({ reminderId: "r", minutes: 10_081 }).success).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("lists, updates, snoozes and cancels only the asking person's reminders", async () => {
    const { call, context, store } = await fixture();
    try {
      const alice = (await call("create", dentist, context("alice", "t-chat"))) as { reminderId: string };
      await call(
        "create",
        { text: "Bob's pills", when: { kind: "repeat", times: ["21:00"] }, operationKey: "bob" },
        context("bob", "t-bob"),
      );
      expect(
        ((await call("list", {}, context("alice", "t-chat"))) as { reminders: { text: string }[] }).reminders.map(
          (reminder) => reminder.text,
        ),
      ).toEqual(["Dentist appointment"]);

      for (const [name, input] of [
        ["cancel", { reminderId: alice.reminderId }],
        ["update", { reminderId: alice.reminderId, text: "x" }],
        ["snooze", { reminderId: alice.reminderId, minutes: 10 }],
      ] as const) {
        await expect(call(name, input, context("bob", "t-bob"))).rejects.toMatchObject({ code: "NOT_FOUND" });
      }

      const moved = await call(
        "update",
        { reminderId: alice.reminderId, when: { kind: "event", at: "2026-10-06T10:00+02:00" } },
        context("alice", "t-chat"),
      );
      expect(moved).toMatchObject({ changed: true, readBack: "Tue 6 Oct 10:00 Europe/Berlin; I'll remind you Mon 20:00 and Tue 09:00" });
      // The same change again, as a retried call: nothing changes.
      expect(
        await call(
          "update",
          { reminderId: alice.reminderId, when: { kind: "event", at: "2026-10-06T10:00+02:00" } },
          context("alice", "t-chat"),
        ),
      ).toMatchObject({ changed: false });
      expect(await call("cancel", { reminderId: alice.reminderId }, context("alice", "t-chat"))).toMatchObject({ status: "cancelled" });
    } finally {
      await store.close();
    }
  });
});

describe("the gate", () => {
  it("runs by the seeded rule, but asks when a tainted conversation would start a task or change a reminder", async () => {
    const { registry, store } = await fixture();
    try {
      const gate = (name: string, input: unknown, tainted: boolean) => {
        const tool = registry.get(`reminders.${name}`);
        const assessment = tool?.assess?.(input, assessContext);
        return evaluateGate({
          toolId: `reminders.${name}`,
          effect: tool?.effect ?? "mutating",
          ...(assessment === undefined ? {} : { assessment }),
          rules: [seededReminderRule("default", NOW.toISOString())],
          sessionGrants: [],
          gatedEffects: new Set(["mutating", "external"]),
          tainted,
        }).decision;
      };
      const withTask = { ...dentist, prompt: "Check the train" };
      expect(registry.get("reminders.create")?.assess?.(dentist, assessContext)).toMatchObject({
        risk: "low",
        display: { title: "Remind: Dentist appointment" },
      });
      expect(gate("create", dentist, false)).toBe("allow");
      expect(gate("create", dentist, true)).toBe("allow");
      expect(gate("create", withTask, false)).toBe("allow");
      expect(gate("create", withTask, true)).toBe("ask");
      expect(gate("update", { reminderId: "r", text: "x" }, true)).toBe("ask");
      expect(gate("cancel", { reminderId: "r" }, true)).toBe("ask");
      expect(gate("cancel", { reminderId: "r" }, false)).toBe("allow");
      expect(gate("snooze", { reminderId: "r", minutes: 10 }, true)).toBe("allow");
      for (const tool of registry.list()) expect(registry.inputJsonSchemaOf(tool.id)).toMatchObject({ type: "object" });
      expect(registry.get("reminders.create")?.description).toMatch(/evening before at 20:00 and one hour before/);
    } finally {
      await store.close();
    }
  });

  it("writes its cards in the workspace's language, and in English as before", async () => {
    const { registry, store } = await fixture();
    try {
      const card = (name: string, input: unknown, locale?: "bg") =>
        registry.get(`reminders.${name}`)?.assess?.(input, locale === undefined ? assessContext : { ...assessContext, locale });
      const withTask = { ...dentist, prompt: "Check the train" };
      expect(card("create", withTask, "bg")).toMatchObject({
        display: { title: "Напомни: Dentist appointment", detail: "Пуска и задача: Check the train" },
        reasons: ["пуска задача, когато се задейства"],
      });
      expect(card("create", withTask)).toMatchObject({
        display: { title: "Remind: Dentist appointment", detail: "Also starts a task: Check the train" },
        reasons: ["starts a task when it fires"],
      });
      expect(card("create", {}, "bg")?.display.title).toBe("Създай напомняне");
      expect(card("update", { reminderId: "r1", text: "x" }, "bg")).toMatchObject({
        display: { title: "Промени напомнянето r1" },
        reasons: ["променя съществуващо напомняне"],
      });
      expect(card("update", { reminderId: "r1", text: "x" })?.display.title).toBe("Change reminder r1");
      expect(card("cancel", { reminderId: "r1" }, "bg")).toMatchObject({
        display: { title: "Отмени напомнянето r1" },
        reasons: ["отменя съществуващо напомняне"],
      });
      expect(card("cancel", { reminderId: "r1" })).toMatchObject({
        display: { title: "Cancel reminder r1" },
        reasons: ["cancels an existing reminder"],
      });
      expect(card("snooze", { reminderId: "r1", minutes: 10 }, "bg")?.display.title).toBe("Отложи напомнянето r1 с 10 минути");
      expect(card("snooze", { reminderId: "r1", minutes: 10 })?.display.title).toBe("Snooze reminder r1 for 10 minutes");
    } finally {
      await store.close();
    }
  });
});
