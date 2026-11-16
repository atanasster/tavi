import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InboundEvent } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * A plugin's status line, notice and published value belong to the task's own
 * stream: a channel turn's reply carries none of them, and the
 * transcript keeps none.
 */

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});
const temp = () => {
  const path = dirs.create("tavi-plugin-status-channel-");
  return path;
};

const MARK = "STATUS-MARK";

function writePlugin(folder: string): void {
  writeFileSync(
    join(folder, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.narrator",
      version: "0.1.0",
      name: "Narrator",
      description: "Says what the turn is doing.",
      entry: "index.mjs",
      mods: { abi: "tavi.mods/1", hooks: [{ event: "turn.start", disclosure: "Shows a status line as each turn starts." }] },
    }),
  );
  writeFileSync(
    join(folder, "index.mjs"),
    `export default {
  register({ hooks, ui }) {
    hooks.on("turn.start", async (e, next) => {
      ui.status(e.envelope, "${MARK} line");
      ui.notice(e.envelope, "${MARK} notice");
      ui.publish(e.envelope, "progress", { text: "${MARK} value" });
      return next(e);
    });
  },
};
`,
  );
}

async function compose(dataDirectory: string, turns: readonly ScriptedTurn[] = []): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureServeOptions(dataDirectory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
    }),
    { modelOverride: createFixtureModel({ turns }) },
  );
  runtimes.push(runtime);
  return runtime;
}

const inbound: InboundEvent = {
  connectionId: "conn-a",
  providerEventId: "evt-1",
  kind: "message",
  externalSenderId: "user-1",
  externalConversationId: "chat-1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  receivedAt: "2026-01-01T00:00:00.000Z",
  content: "hi there",
};

describe("a plugin's status, notices and values in a channel chat", () => {
  it("reach the task's stream, and never the channel or the transcript", async () => {
    const dataDir = temp();
    const source = temp();
    writePlugin(source);
    const setup = await compose(dataDir);
    await setup.plugins.registry.install(source, "operator");
    await setup.plugins.registry.decide("acme.narrator", "0.1.0", "approved", "operator");
    await setup.plugins.registry.enable("acme.narrator", "operator");
    runtimes.splice(runtimes.indexOf(setup), 1);
    await setup.close();

    // A channel chat replies through `messaging.send`.
    const runtime = await compose(dataDir, [
      { toolCall: { id: "c1", name: "messaging.send", input: { content: "the reply" } } },
      { text: "sent" },
    ]);
    expect(runtime.plugins.status("acme.narrator").phase).toBe("ready");
    const instances: FixtureMessagingConnectorInstance[] = [];
    runtime.messaging.registerConnector({
      ...createFixtureMessagingConnectorDefinition({
        sendOutcome: () => ({ status: "accepted", retryable: false, parts: [] }),
        onInstanceCreated: (instance) => instances.push(instance),
      }),
      destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
    });
    await runtime.messaging.openConnection({
      connection: {
        connectionId: "conn-a",
        providerId: "fixture",
        accountIdentity: "acct-a",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    const repositories = runtime.store.asPort().repositories;
    await repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-1",
      workspaceId: "default",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await runtime.messaging.ingest(inbound);
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    expect((await repositories.tasks.get(taskId))?.finalText).toBe("sent");

    // The task's own stream has all three.
    const { replayed } = runtime.runEventBus.subscribe({ taskId, from: "beginning", deliver: () => {} });
    const kinds = replayed.filter((event) => event.kind.startsWith("plugin.")).map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(["plugin.status", "plugin.notice", "plugin.state"]));

    // The channel was sent the reply and nothing of the plugin's.
    const sent = JSON.stringify(instances.flatMap((instance) => instance.sent));
    expect(sent).toContain("the reply");
    expect(sent).not.toContain(MARK);
    // Nor did the transcript keep any of it.
    const transcript = JSON.stringify(await repositories.transcripts.page(taskId, { limit: 100 }));
    expect(transcript).toContain("sent");
    expect(transcript).not.toContain(MARK);
  });
});
