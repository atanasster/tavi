import type { InboundEvent, MessagingIngestReceipt } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { destinationAllowed } from "../../src/features/channels/destination.js";
import { saveChannelConnection } from "../support/saved-channel.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The local connection, composed: one
 * per workspace, inbound through the connector to the messaging service's one
 * path, and never a destination a model may name.
 */

const directories = temporaryDirectories({ prefix: "tavi-local-" });
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

async function compose(options: { readonly allow?: readonly string[]; readonly answers?: readonly string[] } = {}): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directories.create(), {
      workspaces: [
        { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
        { workspaceId: "team", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
      ],
      approvalRequiredFor: [],
      ...(options.allow === undefined ? {} : { messagingAllowedDestinations: options.allow }),
    }),
    { modelOverride: createFixtureModel({ turns: (options.answers ?? ["hello back"]).map((text) => ({ text })) }) },
  );
  runtimes.push(runtime);
  return runtime;
}

const inbound = (overrides: Partial<Omit<InboundEvent, "connectionId">> = {}): Omit<InboundEvent, "connectionId"> => ({
  providerEventId: "message-1",
  kind: "message",
  externalSenderId: "operator",
  externalConversationId: "op-run-1",
  externalMessageId: "message-1",
  occurredAt: "2026-09-19T00:00:00.000Z",
  receivedAt: "2026-09-19T00:00:00.000Z",
  content: "hello",
  ...overrides,
});

describe("the local connection, composed", () => {
  it("opens one per workspace with the runtime, and closes them with it", async () => {
    const runtime = await compose();
    expect(runtime.localMessaging.connectionFor("default")).toBe("local-default");
    expect(runtime.localMessaging.connectionFor("team")).toBe("local-team");
    expect(runtime.localMessaging.connectionFor("elsewhere")).toBeUndefined();
    await runtime.close();
    runtimes.pop();
    expect(runtime.localMessaging.connectionFor("default")).toBeUndefined();
  });

  it("takes a message in through the connector to the service's one path: recorded, answered, then admitted", async () => {
    const runtime = await compose();
    // The sender binds as any chat's sender does; an IPC run binds its own.
    await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "local-default",
      externalSenderId: "operator",
      workspaceId: "default",
      principalId: "operator",
      approvedBy: "test",
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    const recorded: MessagingIngestReceipt[] = [];
    const receipt = await runtime.localMessaging.deliver("default", inbound(), {
      onRecorded: (answer) => {
        recorded.push(answer);
      },
    });
    expect(recorded).toEqual([{ accepted: true, duplicate: false, resolvedPrincipalId: "operator" }]);
    expect(receipt).toEqual(recorded[0]);
    const taskId = (await runtime.store.asPort().repositories.messagingConversations.get("local-default", "op-run-1"))?.taskId ?? "";
    expect(await runtime.store.asPort().repositories.tasks.get(taskId)).toMatchObject({ status: "completed", origin: "messaging" });
    expect((await runtime.store.asPort().repositories.messagingInbox.get("local-default", "message-1"))?.state).toBe("processed");

    // The same message again — a retried reply — is a duplicate, and admits nothing.
    const again = await runtime.localMessaging.deliver("default", inbound());
    expect(again.duplicate).toBe(true);
    expect(await runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).toHaveLength(1);
  });

  it("takes no keyword decision on the local connection: a reply there is text", async () => {
    const runtime = await compose({ answers: ["noted"] });
    await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "local-default",
      externalSenderId: "operator",
      workspaceId: "default",
      principalId: "operator",
      approvedBy: "test",
      createdAt: "2026-09-19T00:00:00.000Z",
    });
    await runtime.localMessaging.deliver("default", inbound({ content: "approve" }));
    const taskId = (await runtime.store.asPort().repositories.messagingConversations.get("local-default", "op-run-1"))?.taskId ?? "";
    // A task was started with the word as its prompt: nothing was decided.
    expect((await runtime.store.asPort().repositories.tasks.get(taskId))?.status).toBe("completed");
  });

  it("is never a destination a model may name, even through a bare allowlist entry", async () => {
    const runtime = await compose({ allow: ["42"] });
    const sendTo = runtime.tools.get("messaging.send_to");
    if (sendTo === undefined) throw new Error("messaging.send_to is not registered");
    await expect(
      sendTo.handler({
        input: { kind: "text", connectionId: "local-default", chatId: "42", content: "exfiltrated" },
        context: { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/local-default is a local connection, which is no destination/);
    // The rule itself: a bare entry, one known connection — that connection
    // matches (a single-Telegram deployment's bare entry keeps working), the
    // local one never does.
    expect(destinationAllowed("telegram-default", "42", ["42"], ["telegram-default"])).toBe(true);
    expect(destinationAllowed("local-default", "42", ["42"], ["telegram-default"])).toBe(false);
    expect(destinationAllowed("local-default", "42", ["local-default:42"], ["telegram-default", "local-default"])).toBe(false);
  });

  it("holds a message from a sender nobody bound, as any chat does, and admits nothing", async () => {
    const runtime = await compose();
    const receipt = await runtime.localMessaging.deliver(
      "default",
      inbound({ providerEventId: "message-unbound", externalSenderId: "stranger" }),
    );
    expect(receipt).toEqual({ accepted: true, duplicate: false });
    expect(await runtime.store.asPort().repositories.messagingConversations.get("local-default", "op-run-1")).toBeUndefined();
    expect((await runtime.store.asPort().repositories.messagingInbox.get("local-default", "message-unbound"))?.state).toBe("received");
    // Only a workspace's own connection: there is no other to hand it to.
    await expect(runtime.localMessaging.deliver("elsewhere", inbound())).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("refuses to compose another connection under the local connections' prefix", async () => {
    const directory = directories.create();
    await saveChannelConnection(directory, {
      connectionId: "local-bot",
      providerId: "telegram",
      workspaceId: "default",
      accountIdentity: "bot",
      settings: {},
      credentialRefs: { token: "telegram.botToken" },
    });
    await expect(
      composeTaviRuntime(
        fixtureRuntimeOptions(directory, {
          workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
          openSavedChannels: true,
        }),
        { requireModelTransport: false },
      ),
    ).rejects.toThrow(/connection id local-bot is reserved/);
  });
});
