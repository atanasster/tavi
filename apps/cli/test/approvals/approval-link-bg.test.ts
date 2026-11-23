import type { InboundEvent } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { createApprovalLinkHandler } from "../../src/features/approvals/links.js";
import { OAuthFlows, oauthCallbackPage } from "../../src/features/oauth/flow.js";
import { commandsIn } from "../../src/features/plugins/command-words.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { fixtureRuntimeOptions, askingForMemoryProposals } from "../support/serve-fixture.js";

/**
 * The pages a person opens from a phone, in a Bulgarian workspace: an email's
 * approval link and an OAuth sign-in's callback speak the workspace's
 * language, with `lang` set; an English workspace's are as before.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const BASE = "https://mail.example.test/tavi";
const propose = { toolCall: { id: "c1", name: "memory.propose", input: { kind: "fact", body: "the sky is blue" } } } as const;

/** A page as a request listener writes it. */
function recorder() {
  const page = { status: 0, html: "" };
  const res = {
    set statusCode(value: number) {
      page.status = value;
    },
    setHeader: () => undefined,
    on: () => undefined,
    end: (body: string) => {
      page.html = body;
    },
  };
  return { page, res };
}

describe("an approval link's page in Bulgarian", () => {
  it("says the round, its choice, its refusals and the page's own words in the workspace's language", async () => {
    const directory = directories.create("tavi-approval-link-bg-");
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, {
        workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
        approvalRequiredFor: ["mutating", "external"],
      }),
      {
        modelOverride: createFixtureModel({ turns: [propose, { text: "done" }] }),
        approvalLinkBase: (connectionId) => (connectionId === "mail" ? BASE : undefined),
        approvalEmailConnection: (connectionId) => connectionId === "mail",
      },
    );
    try {
      await askingForMemoryProposals(runtime);
      const repositories = runtime.store.asPort().repositories;
      const current = await repositories.workspaceSettings.get("default");
      await repositories.workspaceSettings.set({
        workspaceId: "default",
        settings: { ...current.settings, locale: "bg" },
        expectedRevision: current.revision,
        actor: "operator",
        now: "2026-01-01T00:00:00.000Z",
      });
      const instances: FixtureMessagingConnectorInstance[] = [];
      runtime.messaging.registerConnector({
        ...createFixtureMessagingConnectorDefinition({
          sendOutcome: () => ({
            status: "accepted",
            retryable: false,
            parts: [{ index: 0, status: "accepted", providerMessageId: "<m-1@mail>" }],
          }),
          onInstanceCreated: (instance) => instances.push(instance),
        }),
        destinationFromInbound: (replyTo) => ({ to: replyTo.externalSenderId }),
      });
      await runtime.messaging.openConnection({
        connection: {
          connectionId: "mail",
          providerId: "fixture",
          accountIdentity: "tavi@mail.example.test",
          workspaceId: "default",
          configRevision: 1,
          enabled: true,
        },
        config: {},
      });
      await repositories.messagingIdentityBindings.bind({
        connectionId: "mail",
        externalSenderId: "alice@example.test",
        workspaceId: "default",
        principalId: "alice",
        approvedBy: "operator",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const inbound: InboundEvent = {
        connectionId: "mail",
        providerEventId: "<e-1@example.test>",
        kind: "message",
        externalSenderId: "alice@example.test",
        externalConversationId: "tavi@mail.example.test",
        externalMessageId: "<e-1@example.test>",
        occurredAt: "2026-01-01T00:00:00.000Z",
        receivedAt: "2026-01-01T00:00:00.000Z",
        content: "remember that the sky is blue",
        senderAuthentication: "pass",
      };
      await runtime.messaging.ingest(inbound);
      const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
      const round = await repositories.approvalRounds.get(taskId, 1);
      const text = (instances[0]?.sent ?? []).map((message) => (message.parts[0] as { content?: string }).content ?? "").join("\n");
      const links = [...text.matchAll(/https:\/\/mail\.example\.test\/tavi\/i\/([A-Za-z0-9_-]+)/g)].map((match) => match[1] ?? "");
      expect(links.length).toBeGreaterThan(0);
      const bg = coreIn("bg");

      const described = await runtime.channelApprovals.describeLink(links[0] ?? "");
      expect(described).toMatchObject({
        ok: true,
        locale: "bg",
        view: { title: `Искане ${round?.token} на задача ${taskId}`, choiceLabel: bg("channel.approval.link.once") },
      });

      const handler = createApprovalLinkHandler(runtime.channelApprovals, { publicUrl: BASE });
      const shown = recorder();
      await handler({ method: "GET", url: `/tavi/i/${links[0]}` } as never, shown.res as never);
      expect(shown.page.html).toContain('<html lang="bg">');
      expect(shown.page.html).toContain("Потвърди: <strong>");
      expect(shown.page.html).toContain("Тази връзка работи веднъж. Нищо не се случва, докато не натиснеш бутона.");

      expect(await runtime.channelApprovals.useLink(links[0] ?? "", {})).toMatchObject({ ok: true, locale: "bg" });
      expect(await runtime.channelApprovals.useLink(links[0] ?? "", {})).toEqual({
        ok: false,
        message: "Тази връзка вече е използвана.",
        locale: "bg",
      });
      // A token that names no link: the default workspace's language.
      expect(await runtime.channelApprovals.describeLink("not-a-real-token-at-all")).toEqual({
        ok: false,
        message: "Тази връзка не е валидна.",
        locale: "bg",
      });
      const refused = recorder();
      await handler({ method: "PUT", url: `/tavi/i/${links[0]}` } as never, refused.res as never);
      expect(refused.page.status).toBe(405);
      expect(refused.page.html).toContain('<html lang="bg">');
      expect(refused.page.html).toContain("Отвори връзката от имейла.");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("keeps an English page as it was, with lang en", async () => {
    const shown = recorder();
    const handler = createApprovalLinkHandler({
      describeLink: async () => ({ ok: false, message: "This link is not valid." }),
      useLink: async () => ({ ok: false, message: "unused" }),
    });
    await handler({ method: "GET", url: "/i/unknown-token-00000" } as never, shown.res as never);
    expect(shown.page.html).toContain('<html lang="en">');
    expect(shown.page.html).toContain("<title>Nothing to do</title>");
  });
});

describe("an OAuth callback page in Bulgarian", () => {
  it("speaks the workspace's language for a sign-in link that is no longer valid", async () => {
    const flows = new OAuthFlows({
      dataDirectory: directories.create("tavi-oauth-bg-"),
      fetch: globalThis.fetch,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      descriptorOf: () => undefined,
      connected: async () => true,
      localeOf: async () => "bg",
    });
    const outcome = await flows.callback({ state: "no-such-state-0000000" });
    expect(outcome).toEqual({
      ok: false,
      message: "This sign-in link is no longer valid. Start again from Settings → Channels.",
      locale: "bg",
      said: `Тази връзка за вход вече не е валидна. Започни отново от ${coreIn("bg")("nav.route.settings")} → ${coreIn("bg")("nav.settings.channels")}.`,
    });
    const page = oauthCallbackPage(outcome);
    expect(page.body).toContain('<html lang="bg">');
    expect(page.body).toContain("<h1>Няма връзка</h1>");
    expect(page.body).toContain("Можеш да затвориш този прозорец и да се върнеш в Tavi.");
    expect(page.body).not.toContain("no longer valid");
  });

  it("keeps the English page, and never trusts a language this build does not speak", () => {
    const english = oauthCallbackPage({ ok: true, message: "Connected as a@example.test." });
    expect(english.body).toContain('<html lang="en">');
    expect(english.body).toContain(
      "<h1>Connected</h1><p>Connected as a@example.test.</p><p>You can close this window and go back to Tavi.</p>",
    );
    const unknown = oauthCallbackPage({ ok: true, message: "Connected.", locale: "xx" as never, said: "?" });
    expect(unknown.body).toContain('<html lang="en">');
    expect(unknown.body).toContain("<p>Connected.</p>");
  });
});

describe("Tavi's own slash commands in Bulgarian", () => {
  it("describes the built-ins in the workspace's language and leaves another plugin's words alone", () => {
    const commands = [
      { name: "remember", pluginId: "tavi.memory", description: coreEnglish("command.memory.remember") },
      { name: "tavi.heartbeat:heartbeat", pluginId: "tavi.heartbeat", description: coreEnglish("command.heartbeat.heartbeat") },
      { name: "weather", pluginId: "acme.weather", description: "The forecast." },
    ];
    expect(commandsIn(commands, coreIn("bg")).map((command) => command.description)).toEqual([
      "Запази свои думи в паметта: /remember <текст>, с --chat само за този чат.",
      "Пулсът ти: състоянието му, pause [2h], resume или now за проверка веднага.",
      "The forecast.",
    ]);
    expect(commandsIn(commands, coreEnglish)).toEqual(commands);
  });
});
