import { labelSummary, untrustedLabel, type ApprovalsHistoryResult, type PendingApprovalRow } from "@tavi/contracts";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { coreIn } from "@tavi/contracts/locales/core-server";

import { SqliteStore } from "../support/database-fixture.js";

import { approvalListRowOf, historyLine, offlineChannelNames, withChannels } from "../../src/features/approvals/inbox.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** The approvals inbox as the owner and the offline command both shape it. */

const row: PendingApprovalRow = {
  approvalId: "a1",
  taskId: "t1",
  toolId: "http.request",
  callId: "c1",
  steps: 1,
  createdAt: "2026-09-30T08:00:00.000Z",
  workspaceId: "default",
  principalId: "operator",
  taskStatus: "waiting",
  allowedScopes: ["once"],
  announcedIn: { connectionId: "telegram-default", conversationId: "chat-1" },
};

describe("approvals list rows", () => {
  it("names the chat a round was announced in as the owner names its connections", () => {
    const named = (id: string) => (id === "telegram-default" ? "Telegram" : undefined);
    expect(approvalListRowOf(row, named).announcedIn).toEqual({
      connectionId: "telegram-default",
      conversationId: "chat-1",
      channel: "Telegram",
    });
    // A connection the owner cannot name is shown by its id.
    expect(approvalListRowOf(row).announcedIn).toEqual({
      connectionId: "telegram-default",
      conversationId: "chat-1",
      channel: "telegram-default",
    });
    const { announcedIn: _announcedIn, ...unannounced } = row;
    expect(approvalListRowOf(unannounced, named)).not.toHaveProperty("announcedIn");
  });

  it("says where a round's chat read untrusted content, as the card and the channels do", () => {
    const label = labelSummary(untrustedLabel("web", { ref: { ref: "c1", host: "news.example", at: "2026-09-30T08:00:00.000Z" } }));
    expect(approvalListRowOf({ ...row, label })).toMatchObject({ label, provenance: "⚠ after reading news.example — once only" });
    expect(approvalListRowOf({ ...row, label, allowedScopes: ["once", "session"] }).provenance).toBe("⚠ after reading news.example");
    expect(approvalListRowOf(row)).not.toHaveProperty("provenance");
  });

  it("says the provenance and Tavi's own channels in the workspace's language", () => {
    const t = coreIn("bg");
    const label = labelSummary(untrustedLabel("web", { ref: { ref: "c1", host: "news.example", at: "2026-09-30T08:00:00.000Z" } }));
    const english = approvalListRowOf({ ...row, label }).provenance;
    const bulgarian = approvalListRowOf({ ...row, label }, undefined, t).provenance;
    expect(bulgarian).toContain("news.example");
    expect(bulgarian).toMatch(/\p{Script=Cyrillic}/u);
    expect(bulgarian).not.toBe(english);
    // A connection's own name stays as the owner names it; the terminal and the web interface are said in Bulgarian.
    const named = (id: string) => (id === "telegram-default" ? "Telegram" : undefined);
    expect(approvalListRowOf(row, named, t).announcedIn?.channel).toBe("Telegram");
    const history: ApprovalsHistoryResult = {
      items: [
        { kind: "approval", via: "cli" } as unknown as ApprovalsHistoryResult["items"][number],
        { kind: "approval", via: "bridge" } as unknown as ApprovalsHistoryResult["items"][number],
      ],
    } as unknown as ApprovalsHistoryResult;
    expect(withChannels(history, undefined, t).items.map((item) => (item as { channel?: string }).channel)).toEqual([
      t("approval.channel.terminal"),
      t("approval.channel.web"),
    ]);
    expect(t("approval.channel.terminal")).toBe("терминала");
  });
});

describe("approvals history without an owner", () => {
  it("names the channels' connections by the providers the data directory recorded for them", async () => {
    const directory = directories.create("tavi-approval-inbox-");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const repositories = store.asPort().repositories;
    let offlineChannelName: (connectionId: string) => string | undefined;
    try {
      await repositories.messagingConnections.save(
        {
          connectionId: "telegram-default",
          providerId: "telegram",
          workspaceId: "default",
          accountIdentity: "tavi-bot",
          settings: {},
          credentialRefs: {},
          enabled: false,
          authState: "none",
        },
        "2026-09-30T00:00:00.000Z",
      );
      await repositories.messagingConnections.save(
        {
          connectionId: "mailgun-team",
          providerId: "mailgun",
          workspaceId: "team",
          accountIdentity: "tavi@mg.example.com",
          settings: {},
          credentialRefs: {},
          enabled: false,
          authState: "none",
        },
        "2026-09-30T00:00:00.000Z",
      );
      offlineChannelName = await offlineChannelNames(repositories);
    } finally {
      store.close();
    }
    expect(offlineChannelName("telegram-default")).toBe("Telegram");
    expect(offlineChannelName("mailgun-team")).toBe("Email");
    expect(offlineChannelName("slack-default")).toBeUndefined();
    const history: ApprovalsHistoryResult = {
      items: [
        {
          kind: "approval",
          approvalId: "a1",
          taskId: "t1",
          principalId: "operator",
          toolId: "http.request",
          state: "granted",
          decidedBy: "ana",
          decidedAt: "2026-09-30T08:00:00.000Z",
          via: "telegram-default",
          scope: "once",
          note: null,
        },
        {
          kind: "approval",
          approvalId: "a2",
          taskId: "t1",
          principalId: "operator",
          toolId: "http.request",
          state: "denied",
          decidedBy: "ana",
          decidedAt: "2026-09-30T07:00:00.000Z",
          via: "slack-default",
          note: null,
        },
        // Who answered and through what, and a question from before that was recorded.
        {
          kind: "question",
          waitId: "w1",
          taskId: "t1",
          principalId: "operator",
          state: "answered",
          question: "Which day?",
          answer: "Monday",
          decidedAt: "2026-09-30T06:00:00.000Z",
          decidedBy: "ana",
          via: "telegram-default",
        },
        {
          kind: "question",
          waitId: "w0",
          taskId: "t1",
          principalId: "operator",
          state: "expired",
          question: "Which time?",
          answer: null,
          decidedAt: "2026-09-30T05:00:00.000Z",
        },
      ],
    };
    const lines = withChannels(history, offlineChannelName).items.map(historyLine);
    expect(lines).toEqual([
      "2026-09-30T08:00:00.000Z\tapproval\tgranted\tt1\thttp.request\tana\tTelegram\tonce",
      "2026-09-30T07:00:00.000Z\tapproval\tdenied\tt1\thttp.request\tana\tslack-default\t-",
      '2026-09-30T06:00:00.000Z\tquestion\tanswered\tt1\t"Which day?"\t"Monday"\tana\tTelegram',
      '2026-09-30T05:00:00.000Z\tquestion\texpired\tt1\t"Which time?"\t-\t-\t-',
    ]);
  });
});
