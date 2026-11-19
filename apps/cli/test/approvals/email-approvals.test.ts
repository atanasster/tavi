import { inspectDatabase } from "../support/database-fixture.js";
import { chmodSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { splitEmailText } from "@tavi/contracts";
import type { InboundEvent } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApprovalLinkHandler } from "../../src/features/approvals/links.js";
import { questionToken } from "../../src/features/approvals/channel-approval-text.js";
import type { ChannelApprovals } from "../../src/features/approvals/channel-approvals.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { pdfFillTurns, registrationForm } from "../support/pdf-forms.js";
import { fixtureRuntimeOptions, askingForMemoryProposals } from "../support/serve-fixture.js";

/**
 * Approvals by email: single-use links to a confirmation page whose GET
 * decides nothing, and a verified reply for low- and medium-risk rounds only.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const BASE = "https://mail.example.test/tavi";
const propose = { toolCall: { id: "c1", name: "memory.propose", input: { kind: "fact", body: "the sky is blue" } } } as const;

async function harness(
  turns: readonly ScriptedTurn[],
  pin?: string,
  links = true,
): Promise<{ runtime: TaviRuntime; sent: () => { text: string; subject?: string }[] }> {
  const directory = directories.create("tavi-email-approvals-");
  const pinFile = join(directory, "pin");
  if (pin !== undefined) {
    writeFileSync(pinFile, pin, { mode: 0o600 });
    chmodSync(pinFile, 0o600);
  }
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: ["mutating", "external"],
      ...(pin === undefined ? {} : { credentials: { "approvals.pin": { fromFile: pinFile } } }),
    }),
    {
      modelOverride: createFixtureModel({ turns }),
      approvalLinkBase: (connectionId) => (connectionId === "mail" && links ? BASE : undefined),
      approvalEmailConnection: (connectionId) => connectionId === "mail",
    },
  );
  // A memory proposal is these tests' asked call: its seeded allow rule is revoked.
  await askingForMemoryProposals(runtime);
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
  await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
    connectionId: "mail",
    externalSenderId: "alice@example.test",
    workspaceId: "default",
    principalId: "alice",
    approvedBy: "operator",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const sent = () =>
    (instances[0]?.sent ?? []).map((message) => ({
      text: (message.parts[0] as { content?: string }).content ?? "",
      ...(message.subject === undefined ? {} : { subject: message.subject }),
    }));
  return { runtime, sent };
}

let counter = 0;
function email(content: string, extra: Partial<InboundEvent> = {}): InboundEvent {
  counter += 1;
  return {
    connectionId: "mail",
    providerEventId: `<e-${counter}@example.test>`,
    kind: "message",
    externalSenderId: "alice@example.test",
    externalConversationId: "tavi@mail.example.test",
    externalMessageId: `<e-${counter}@example.test>`,
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content,
    senderAuthentication: "pass",
    ...extra,
  };
}

const linksIn = (text: string) =>
  [...text.matchAll(/(\S+): https:\/\/mail\.example\.test\/tavi\/i\/([A-Za-z0-9_-]+)/g)].map((match) => ({
    label: match[1] ?? "",
    token: match[2] ?? "",
  }));

describe("approval links", () => {
  it("emails a form fill's labels only, refuses a reply's approval, and shows the masked values on the link's page", async () => {
    const form = await registrationForm();
    const { turns, source } = pdfFillTurns(form, "2016-03-04");
    const { runtime, sent } = await harness(turns);
    const repositories = runtime.store.asPort().repositories;
    source.artifactId = (
      await repositories.artifacts.putArtifact({ workspaceId: "default", contentType: "application/pdf", body: form, extension: "pdf" })
    ).artifactId;
    await runtime.messaging.ingest(email("Fill the registration form: Leo Ivanov, born 2016-03-04."));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const round = await repositories.approvalRounds.get(taskId, 1);
    const announcement = sent().find((message) => message.text.startsWith("🔐"))?.text ?? "";
    expect(announcement).toContain("Date of birth");
    expect(announcement).not.toContain("Leo Ivanov");
    expect(announcement).toContain("A reply cannot approve a form fill");
    // A verified reply naming the round still cannot approve it.
    await runtime.messaging.ingest(email("approve", { subject: `Re: [tavi ${round?.token}] Approval needed` }));
    expect(sent().at(-1)?.text).toContain("through the link in its email");
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
    // The link's page shows the masked table; the link approves.
    const once = linksIn(announcement).find((link) => link.label === "once")?.token ?? "";
    const described = await runtime.channelApprovals.describeLink(once);
    expect(described.ok && described.view.forms?.[0]?.rows.map((row) => [row.field, row.value, row.source])).toEqual([
      ["Child name", "Leo Ivanov", "your words"],
      ["Date of birth", "2016-••-••", "your words"],
    ]);
    expect(await runtime.channelApprovals.useLink(once, {})).toMatchObject({ ok: true });
    expect((await repositories.tasks.get(taskId))?.status).toBe("completed");
    await runtime.close();
  }, 60_000);

  it("sends a link per offered choice and a token subject; a link decides once, and spends its siblings", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember that the sky is blue"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const round = await repositories.approvalRounds.get(taskId, 1);
    const announcement = sent().find((message) => message.text.startsWith("🔐"));
    expect(announcement?.subject).toBe(`[tavi ${round?.token}] Approval needed: Run memory.propose`);
    const links = [...(announcement?.text ?? "").matchAll(/https:\/\/mail\.example\.test\/tavi\/i\/([A-Za-z0-9_-]+)/g)].map(
      (match) => match[1] ?? "",
    );
    // Once, for the rest of the task, and reject — `always` is not offered for a call with no subjects.
    expect(links).toHaveLength(3);
    expect(announcement?.text).toContain("Approve for the rest of this chat: https://mail.example.test/tavi/i/");
    // The links are bearer capabilities: whoever holds the email can use them, so it says not to forward it.
    expect(announcement?.text).toContain("Anyone with this message can use these links: do not forward it.");

    const described = await runtime.channelApprovals.describeLink(links[0] ?? "");
    expect(described).toMatchObject({ ok: true, view: { choiceLabel: "Approve once", needsPin: false } });
    // Reading is not deciding.
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
    expect(await runtime.channelApprovals.useLink(links[0] ?? "", {})).toMatchObject({ ok: true });
    expect((await repositories.tasks.get(taskId))?.status).toBe("completed");
    expect(await runtime.channelApprovals.useLink(links[0] ?? "", {})).toEqual({ ok: false, message: "This link was already used." });
    expect(await runtime.channelApprovals.describeLink(links[2] ?? "")).toEqual({ ok: false, message: "This link was already used." });
    expect(await runtime.channelApprovals.describeLink("not-a-real-token-at-all")).toEqual({
      ok: false,
      message: "This link is not valid.",
    });
    await runtime.close();
  });

  it("sends no links or token to a member writing in the operator's thread, whose card it cannot decide", async () => {
    const { runtime, sent } = await harness([{ text: "hi alice" }, propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await repositories.messagingIdentityBindings.bind({
      connectionId: "mail",
      externalSenderId: "bob@example.test",
      workspaceId: "default",
      principalId: "bob",
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await runtime.messaging.ingest(email("hello"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    // Bob, an allowed person but not the operator, writes into alice's thread: the round is alice's to decide.
    await runtime.messaging.ingest(email("remember that the sky is blue", { externalSenderId: "bob@example.test" }));
    const announcement = sent().find((message) => message.text.startsWith("🔐"));
    expect(announcement).toBeDefined();
    // The links are bearer tokens: whoever holds one decides as the operator. The member's card carries none.
    expect(linksIn(announcement?.text ?? "")).toEqual([]);
    expect(announcement?.subject).toMatch(/^Waiting for approval: /);
    expect(announcement?.text).toContain("Waiting for the operator to approve or reject it");
    expect(announcement?.text).not.toContain("link");
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
    await runtime.close();
  });

  it("shows on the link's page where the round's chat read untrusted content: mail the person forwarded or quoted, not their own domain's words", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    const content = "remember this\n\nOn Mon, Shop wrote:\n> the sky is blue";
    await runtime.messaging.ingest(email(content, { quotedRanges: splitEmailText(content) }));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    expect((await repositories.approvalRounds.get(taskId, 1))?.riskLabel).toMatchObject({ integrity: "untrusted", sources: ["email"] });
    const [token] = [...(sent().find((message) => message.text.startsWith("🔐"))?.text ?? "").matchAll(/\/i\/([A-Za-z0-9_-]+)/g)].map(
      (match) => match[1] ?? "",
    );
    const described = await runtime.channelApprovals.describeLink(token ?? "");
    const body = described.ok ? described.view.body : "";
    expect(body).toContain("⚠ after reading mail you forwarded or quoted (via example[.]test)");
    expect(body).not.toContain("mail from");
    await runtime.close();
  });

  it("keeps raw tokens out of what it records and shows, and refuses an expired link", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const tokens = [...(sent().find((message) => message.text.startsWith("🔐"))?.text ?? "").matchAll(/\/i\/([A-Za-z0-9_-]+)/g)].map(
      (match) => match[1] ?? "",
    );
    const recorded = JSON.stringify(await repositories.approvalRounds.listEvents(taskId));
    for (const token of tokens) expect(recorded).not.toContain(token);
    const described = await runtime.channelApprovals.describeLink(tokens[2] ?? "");
    for (const token of tokens) expect(JSON.stringify(described)).not.toContain(token);
    inspectDatabase(runtime.store).prepare("UPDATE tavi_approval_links SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(await runtime.channelApprovals.describeLink(tokens[0] ?? "")).toEqual({ ok: false, message: "This link has expired." });
    await runtime.close();
  });

  it("leaves the links usable when the decision they carry is refused", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const token =
      [...(sent().find((message) => message.text.startsWith("🔐"))?.text ?? "").matchAll(/\/i\/([A-Za-z0-9_-]+)/g)][0]?.[1] ?? "";
    await repositories.cancellations.request({
      taskId,
      requestedBy: "operator",
      reason: "stop",
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    expect((await runtime.channelApprovals.useLink(token, {})).ok).toBe(false);
    expect((await repositories.approvalLinks.get(createHash("sha256").update(token).digest("hex")))?.usedAt).toBeUndefined();
    await runtime.close();
  });

  it.each(["task", "round", "token"])("releases claimed links when the pre-decision %s read fails", async (read) => {
    const { runtime, sent } = await harness([propose, { text: "done" }], "4711");
    const repositories = runtime.store.asPort().repositories;
    try {
      await runtime.messaging.ingest(email("remember"));
      const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))!.taskId;
      inspectDatabase(runtime.store).prepare("UPDATE tavi_approval_rounds SET risk = 'critical' WHERE task_id = ?").run(taskId);
      const tokens = linksIn(sent().find((message) => message.text.startsWith("🔐"))!.text).map((link) => link.token);
      const consume = repositories.approvalLinks.consumeWithPin;
      const failure = new Error("pre-decision read rejected");
      vi.spyOn(repositories.approvalLinks, "consumeWithPin").mockImplementationOnce(async (input) => {
        const result = await consume(input);
        if (read === "task") vi.spyOn(repositories.tasks, "get").mockRejectedValueOnce(failure);
        else if (read === "round") vi.spyOn(repositories.approvalRounds, "get").mockRejectedValueOnce(failure);
        else vi.spyOn(repositories.approvalRounds, "getByToken").mockRejectedValueOnce(failure);
        return result;
      });
      await expect(runtime.channelApprovals.useLink(tokens[0]!, { pin: "4711" })).rejects.toBe(failure);
      expect((await repositories.approvalRounds.get(taskId, 1))?.settledAt).toBeUndefined();
      for (const token of tokens) {
        expect((await repositories.approvalLinks.get(createHash("sha256").update(token).digest("hex")))?.usedAt).toBeUndefined();
      }
      expect(await runtime.channelApprovals.useLink(tokens[0]!, { pin: "4711" })).toMatchObject({ ok: true });
    } finally {
      vi.restoreAllMocks();
      await runtime.close();
    }
  });

  it("retains claimed links when an admission has an unknown outcome", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }], "4711");
    const repositories = runtime.store.asPort().repositories;
    try {
      await runtime.messaging.ingest(email("remember"));
      const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))!.taskId;
      inspectDatabase(runtime.store).prepare("UPDATE tavi_approval_rounds SET risk = 'critical' WHERE task_id = ?").run(taskId);
      const tokens = linksIn(sent().find((message) => message.text.startsWith("🔐"))!.text).map((link) => link.token);
      vi.spyOn(repositories.tasks, "admit").mockRejectedValueOnce(new Error("admission acknowledgement lost"));
      await expect(runtime.channelApprovals.useLink(tokens[0]!, { pin: "4711" })).rejects.toThrow("admission acknowledgement lost");
      for (const token of tokens) {
        expect((await repositories.approvalLinks.get(createHash("sha256").update(token).digest("hex")))?.usedAt).toBeDefined();
      }
    } finally {
      vi.restoreAllMocks();
      await runtime.close();
    }
  });

  it("decides a critical round with the right PIN, and spends every link after three wrong ones", async () => {
    for (const attempt of ["right", "wrong"] as const) {
      const { runtime, sent } = await harness([propose, { text: "done" }], "4711");
      const repositories = runtime.store.asPort().repositories;
      await runtime.messaging.ingest(email("remember"));
      const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
      inspectDatabase(runtime.store).prepare("UPDATE tavi_approval_rounds SET risk = 'critical' WHERE task_id = ?").run(taskId);
      const tokens = [...(sent().find((message) => message.text.startsWith("🔐"))?.text ?? "").matchAll(/\/i\/([A-Za-z0-9_-]+)/g)].map(
        (match) => match[1] ?? "",
      );
      if (attempt === "right") {
        expect(await runtime.channelApprovals.useLink(tokens[0] ?? "", { pin: "4711" })).toMatchObject({ ok: true });
        expect((await repositories.tasks.get(taskId))?.status).toBe("completed");
      } else {
        expect((await runtime.channelApprovals.useLink(tokens[0] ?? "", { pin: "0000" })).message).toMatch(/2 tries left/);
        expect((await runtime.channelApprovals.useLink(tokens[1] ?? "", { pin: "1111" })).message).toMatch(/1 tries left/);
        expect((await runtime.channelApprovals.useLink(tokens[0] ?? "", { pin: "2222" })).message).toMatch(/Too many wrong PINs/);
        expect(await runtime.channelApprovals.useLink(tokens[2] ?? "", { pin: "4711" })).toMatchObject({ ok: false });
        expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
      }
      await runtime.close();
    }
  });

  it("asks a critical round's link for the PIN before it spends the link", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    inspectDatabase(runtime.store).prepare("UPDATE tavi_approval_rounds SET risk = 'critical' WHERE task_id = ?").run(taskId);
    const token =
      [...(sent().find((message) => message.text.startsWith("🔐"))?.text ?? "").matchAll(/\/i\/([A-Za-z0-9_-]+)/g)][0]?.[1] ?? "";
    expect(await runtime.channelApprovals.describeLink(token)).toMatchObject({ ok: true, view: { needsPin: true } });
    const refused = await runtime.channelApprovals.useLink(token, { pin: "1234" });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/approvals\.pin/);
    // Not spent: it still describes.
    expect((await runtime.channelApprovals.describeLink(token)).ok).toBe(true);
    await runtime.close();
  });

  it("answers a question from its option's link", async () => {
    const ask = {
      toolCall: {
        id: "q1",
        name: "operator.ask_user",
        input: { question: "Which customer?", options: [{ label: "Acme" }, { label: "Globex" }] },
      },
    } as const;
    const { runtime, sent } = await harness([ask, { text: "thanks" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("pick one"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const question = sent().find((message) => message.text.startsWith("❓"))?.text ?? "";
    const links = linksIn(question);
    expect(links.map((link) => link.label)).toEqual(["Acme", "Globex"]);
    expect(await runtime.channelApprovals.useLink(links[1]?.token ?? "", {})).toEqual({ ok: true, message: "Answered: Globex" });
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId;
    expect(waitId).toBeUndefined();
    await runtime.close();
  });

  it("ends a question's links with its wait, and does not spend one used after another answer", async () => {
    // A ten-minute question: its links must not outlive it by a day.
    const ask = {
      toolCall: {
        id: "q1",
        name: "operator.ask_user",
        input: {
          question: "Which customer?",
          options: [{ label: "Acme" }, { label: "Globex" }],
          deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      },
    } as const;
    const { runtime, sent } = await harness([ask, { text: "thanks" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("pick one"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const wait = await repositories.agentWaits.getActiveByTask(taskId);
    const links = linksIn(sent().find((message) => message.text.startsWith("❓"))?.text ?? "");
    const record = await repositories.approvalLinks.get(
      createHash("sha256")
        .update(links[0]?.token ?? "")
        .digest("hex"),
    );
    expect(record?.expiresAt).toBe(wait?.deadlineAt);
    // Answered some other way first: the link is refused, and not spent.
    await repositories.agentWaits.settle({
      waitId: wait?.waitId ?? "",
      outcome: { kind: "answered", replyText: "Acme", answers: ["Acme"] },
    });
    const used = links[1]?.token ?? "";
    expect(await runtime.channelApprovals.useLink(used, {})).toMatchObject({ ok: false });
    expect((await repositories.approvalLinks.get(createHash("sha256").update(used).digest("hex")))?.usedAt).toBeUndefined();
    await runtime.close();
  });

  it("sends a multi-select question one form link, and answers with the boxes ticked", async () => {
    const ask = {
      toolCall: {
        id: "q1",
        name: "operator.ask_user",
        input: { question: "Which customers?", options: [{ label: "Acme" }, { label: "Globex" }, { label: "Initech" }], multiSelect: true },
      },
    } as const;
    const { runtime, sent } = await harness([ask, { text: "thanks" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("pick some"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const waitId = (await repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";
    const links = linksIn(sent().find((message) => message.text.startsWith("❓"))?.text ?? "");
    expect(links.map((link) => link.label)).toEqual(["Choose"]);
    const token = links[0]?.token ?? "";
    const described = await runtime.channelApprovals.describeLink(token);
    expect(described.ok && described.view.options?.map((option) => option.label)).toEqual(["Acme", "Globex", "Initech"]);
    // Nothing ticked: refused, and the link still works.
    expect(await runtime.channelApprovals.useLink(token, {})).toEqual({ ok: false, message: "Choose at least one of the options." });
    expect(await runtime.channelApprovals.useLink(token, { picks: [3, 1] })).toEqual({ ok: true, message: "Answered: Acme, Initech" });
    expect((await repositories.agentWaits.get(waitId))?.settledOutcome?.answers).toEqual(["Acme", "Initech"]);
    await runtime.close();
  });
});

describe("approval by email reply", () => {
  it("gives parallel wrong PINs no more tries than sequential ones", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }], "4711");
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    inspectDatabase(runtime.store).prepare("UPDATE tavi_approval_rounds SET risk = 'critical' WHERE task_id = ?").run(taskId);
    const token =
      [...(sent().find((message) => message.text.startsWith("🔐"))?.text ?? "").matchAll(/\/i\/([A-Za-z0-9_-]+)/g)][0]?.[1] ?? "";
    // Sent together: each POST reads the PIN before any miss is counted.
    const results = await Promise.all(
      ["0001", "0002", "0003", "0004", "0005", "4711"].map((pin) => runtime.channelApprovals.useLink(token, { pin })),
    );
    expect(results.some((result) => result.ok)).toBe(false);
    const wrong = (await repositories.approvalRounds.listEvents(taskId)).filter((event) => event.detail?.["reason"] === "wrong-pin");
    expect(wrong.length).toBeLessThanOrEqual(3);
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
    await runtime.close();
  });

  it("without links, puts the token in the subject and offers only what a reply can decide", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }], undefined, false);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    const announcement = sent().find((message) => message.text.startsWith("🔐"));
    expect(announcement?.subject).toBe(`[tavi ${token}] Approval needed: Run memory.propose`);
    expect(announcement?.text).toContain(`Reply: approve ${token} · reject ${token} <reason>`);
    expect(announcement?.text).not.toMatch(/approve \S+ (session|always)/);
    expect(announcement?.text).not.toContain("/i/");
    // A bare "approve" in the thread names the round through its subject.
    await runtime.messaging.ingest(email("approve", { subject: `Re: ${announcement?.subject ?? ""}` }));
    expect(sent().at(-1)?.text).toMatch(/approved: the run is now completed/);
    await runtime.close();
  });

  it("answers a question from the first line of a reply, whatever follows it", async () => {
    const ask = {
      toolCall: {
        id: "q1",
        name: "operator.ask_user",
        input: { question: "Which one?", options: [{ label: "Red" }, { label: "Blue" }], allowOther: false },
      },
    } as const;
    const { runtime } = await harness([ask, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("pick a colour"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const wait = await repositories.agentWaits.getActiveByTask(taskId);
    expect(wait?.choices).toBeDefined();
    await runtime.messaging.ingest(email("2\n\n--\nAlice, sent from my phone"));
    expect((await repositories.agentWaits.get(wait?.waitId ?? ""))?.settledOutcome).toMatchObject({ kind: "answered", answers: ["Blue"] });
    await runtime.close();
  });

  it("names a question and its token in the subject, and takes a reply under it as the answer, never a round's", async () => {
    const ask = {
      toolCall: {
        id: "q1",
        name: "operator.ask_user",
        input: { question: "Ship the release tonight?", options: [{ label: "Approve" }, { label: "Hold" }], allowOther: false },
      },
    } as const;
    const { runtime, sent } = await harness([ask, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("ship it?"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const wait = await repositories.agentWaits.getActiveByTask(taskId);
    const question = sent().find((message) => message.text.startsWith("❓"));
    expect(question?.subject).toBe(`[tavi ${questionToken(wait?.waitId ?? "")}] Question: Ship the release tonight?`);
    // "approve" is an option here: under a question's subject it answers, and decides no round.
    await runtime.messaging.ingest(email("approve", { subject: `Re: ${question?.subject ?? ""}` }));
    expect((await repositories.agentWaits.get(wait?.waitId ?? ""))?.settledOutcome).toMatchObject({
      kind: "answered",
      answers: ["Approve"],
    });
    await runtime.close();
  });

  it("answers a question by its subject's token from a conversation that is not its task's", async () => {
    const ask = {
      toolCall: {
        id: "q1",
        name: "operator.ask_user",
        input: { question: "Ship the release tonight?", options: [{ label: "Approve" }, { label: "Hold" }], allowOther: false },
      },
    } as const;
    const { runtime, sent } = await harness([ask, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("ship it?"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const wait = await repositories.agentWaits.getActiveByTask(taskId);
    const subject = sent().find((message) => message.text.startsWith("❓"))?.subject ?? "";
    // The thread is lost: the reply arrives in a conversation with no task, and only its subject names the question.
    await runtime.messaging.ingest(email("approve", { subject: `Re: ${subject}`, externalConversationId: "other@mail.example.test" }));
    expect((await repositories.agentWaits.get(wait?.waitId ?? ""))?.settledOutcome).toMatchObject({
      kind: "answered",
      answers: ["Approve"],
    });
    await runtime.close();
  });

  it("decides a medium-risk round from a verified reply naming it in the subject", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(email("approve\n\nSent from my phone", { subject: `Re: [tavi ${token}] Approval needed` }));
    expect(sent().at(-1)?.text).toMatch(/approved: the run is now completed/);
    await runtime.close();
  });

  it("refuses a reply whose sender Mailgun could not verify, and a reply to a high-risk round", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    // Held before it reaches the round: the sender is told, the round is untouched.
    await runtime.messaging.ingest(email("approve", { subject: `Re: [tavi ${token}]`, senderAuthentication: "fail" }));
    expect(sent().at(-1)?.text).toMatch(/could not be verified as coming from you \(its sender authentication did not pass\)/);
    // Told at most once a day.
    const before = sent().length;
    await runtime.messaging.ingest(email("approve", { subject: `Re: [tavi ${token}]`, senderAuthentication: "fail" }));
    expect(sent()).toHaveLength(before);
    // Trusting this person's unverified mail admits it, but it still cannot decide a round.
    await repositories.messagingIdentityBindings.setTrustUnverified("mail", "alice@example.test", {
      setBy: "operator",
      setAt: "2026-01-01T00:00:00.000Z",
    });
    await runtime.messaging.ingest(email("approve", { subject: `Re: [tavi ${token}]`, senderAuthentication: "fail" }));
    expect(sent().at(-1)?.text).toMatch(/did not pass SPF and DKIM/);
    await repositories.messagingIdentityBindings.setTrustUnverified("mail", "alice@example.test", null);
    inspectDatabase(runtime.store).prepare("UPDATE tavi_approval_rounds SET risk = 'high' WHERE task_id = ?").run(taskId);
    await runtime.messaging.ingest(email("approve", { subject: `Re: [tavi ${token}]` }));
    expect(sent().at(-1)?.text).toMatch(/only a low- or medium-risk round/);
    expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["pending"]);
    await runtime.close();
  });

  it("refuses a reply that names no round, and a reply asking for more than once", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(email("approve", { subject: "a new thread" }));
    expect(sent().at(-1)?.text).toMatch(/keeping its subject line/);
    await runtime.messaging.ingest(email("approve session", { subject: `Re: [tavi ${token}]` }));
    expect(sent().at(-1)?.text).toMatch(/can approve once only/);
    expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["pending"]);
    await runtime.close();
  });
});

describe("the link page", () => {
  it("leaves a real link unspent however often a scanner GETs it, and decides on the POST", async () => {
    const { runtime, sent } = await harness([propose, { text: "done" }]);
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(email("remember"));
    const taskId = (await repositories.messagingConversations.get("mail", "tavi@mail.example.test"))?.taskId ?? "";
    const once =
      linksIn(sent().find((message) => message.text.startsWith("🔐"))?.text ?? "").find((link) => link.label === "once")?.token ?? "";
    const links = createApprovalLinkHandler(runtime.channelApprovals, { publicUrl: BASE });
    const server = createServer((req, res) => {
      void links(req, res).then((answered) => {
        if (!answered) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (let scan = 0; scan < 3; scan += 1) expect((await fetch(`${url}/tavi/i/${once}`)).status).toBe(200);
      expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["pending"]);
      expect((await repositories.approvalLinks.get(createHash("sha256").update(once).digest("hex")))?.usedAt).toBeUndefined();
      const decided = await fetch(`${url}/tavi/i/${once}`, { method: "POST", body: new URLSearchParams({}) });
      expect(await decided.text()).toMatch(/approved/);
      expect((await repositories.approvals.listForTask(taskId)).map((row) => row.state)).toEqual(["granted"]);
    } finally {
      server.close();
      await runtime.close();
    }
  });

  it("shows on GET, decides only on POST, and serves no active content", async () => {
    const calls: string[] = [];
    const channels: Pick<ChannelApprovals, "describeLink" | "useLink"> = {
      describeLink: async (token) =>
        token === "valid-token-000000"
          ? {
              ok: true,
              view: { kind: "round", title: "Round abc", body: "🔐 <b>x</b>", choiceLabel: "Reject", needsPin: false, allowsNote: true },
            }
          : { ok: false, message: "This link is not valid." },
      useLink: async (token, form) => {
        calls.push(`${token}:${form.note ?? ""}`);
        return { ok: true, message: "Task t rejected." };
      },
    };
    const links = createApprovalLinkHandler(channels);
    const server = createServer((req, res) => {
      void links(req, res).then((answered) => {
        if (!answered) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const shown = await fetch(`${url}/i/valid-token-000000`);
      const html = await shown.text();
      expect(shown.status).toBe(200);
      expect(shown.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(shown.headers.get("cache-control")).toBe("no-store");
      expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
      expect(html).not.toContain("<script");
      expect(calls).toEqual([]);
      const decided = await fetch(`${url}/i/valid-token-000000`, { method: "POST", body: new URLSearchParams({ note: "not now" }) });
      expect(await decided.text()).toContain("Task t rejected.");
      expect(calls).toEqual(["valid-token-000000:not now"]);
      expect((await fetch(`${url}/i/unknown-token-00000`)).status).toBe(410);
      expect((await fetch(`${url}/i/valid-token-000000`, { method: "POST", body: "x".repeat(20_000) })).status).toBe(413);
      expect(calls).toHaveLength(1);
      expect((await fetch(`${url}/webhook`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("offers a multi-select question's options as boxes, and posts only option numbers", async () => {
    const picks: (readonly number[] | undefined)[] = [];
    const channels: Pick<ChannelApprovals, "describeLink" | "useLink"> = {
      describeLink: async () => ({
        ok: true,
        view: {
          kind: "question",
          title: "A question",
          body: "",
          choiceLabel: "Send my choices",
          needsPin: false,
          allowsNote: false,
          options: [{ label: "Acme" }, { label: "<Globex>", description: "big" }],
        },
      }),
      useLink: async (_token, form) => {
        picks.push(form.picks);
        return { ok: true, message: "Answered." };
      },
    };
    const links = createApprovalLinkHandler(channels);
    const server = createServer((req, res) => void links(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/i/valid-token-000000`;
    try {
      const html = await (await fetch(url)).text();
      expect(html).toContain('<input type="checkbox" name="pick" value="1"> Acme');
      expect(html).toContain('value="2"> &#60;Globex&#62; — big');
      await fetch(url, {
        method: "POST",
        body: new URLSearchParams([
          ["pick", "1"],
          ["pick", "2"],
          ["pick", "9"],
          ["pick", "x"],
        ]),
      });
      expect(picks).toEqual([[1, 2]]);
    } finally {
      server.close();
    }
  });

  it("serves a link under the public URL's path, and with that path stripped by a proxy", async () => {
    const seen: string[] = [];
    const links = createApprovalLinkHandler(
      {
        describeLink: async (token) => {
          seen.push(token);
          return { ok: false, message: "This link is not valid." };
        },
        useLink: async () => ({ ok: false, message: "unused" }),
      },
      { publicUrl: "https://mail.example.test/tavi" },
    );
    const server = createServer((req, res) => {
      void links(req, res).then((answered) => {
        if (!answered) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}/tavi/i/prefixed-token-0000`)).status).toBe(410);
      expect((await fetch(`${url}/i/stripped-token-0000`)).status).toBe(410);
      expect((await fetch(`${url}/other/i/stripped-token-0000`)).status).toBe(404);
      expect(seen).toEqual(["prefixed-token-0000", "stripped-token-0000"]);
    } finally {
      server.close();
    }
  });
});
