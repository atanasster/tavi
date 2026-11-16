import { existsSync } from "node:fs";
import { join } from "node:path";

import type { InboundEvent, MessagingCapabilities, OutboundMessage } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { formLines, maskedApprovable, maskedForm, splitMessage } from "../../src/features/approvals/form.js";
import { createApprovalLinkHandler } from "../../src/features/approvals/links.js";
import type { ChannelApprovals } from "../../src/features/approvals/channel-approvals.js";
import { renderRoundText } from "../../src/features/approvals/channel-approval-text.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { pdfFillTurns, registrationForm } from "../support/pdf-forms.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * A form fill's approval on a channel: values
 * masked in the owner's one-to-one chat, labels only anywhere else, and a
 * round approved in the chat only when every row was shown and every masked
 * one was verified against its source.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const form = {
  source: "registration.pdf, 1 page",
  output: "forms/registration-filled.pdf",
  rows: [
    { page: 1, field: "Child name", value: "Leo Ivanov", source: 'your words: "Leo Ivanov"', status: "verified" as const },
    {
      page: 1,
      field: "Date of birth",
      value: "2016-03-04",
      source: 'your words: "2016-03-04"',
      status: "verified" as const,
      sensitive: ["birth-date" as const],
    },
    {
      page: 2,
      field: "Insurance number",
      value: "AB-1234-5678",
      source: 'the form, page 2: "see example.com"',
      status: "document" as const,
      sensitive: ["insurance" as const],
    },
  ],
  leftBlank: [{ field: "Parent signature", why: "signature" as const }],
  warnings: ["the form carries JavaScript; the copy is written without it"],
};

describe("a form's rows on an approval surface", () => {
  it("masks each sensitive value by its strictest category, and is approvable only when every masked row was verified", () => {
    expect(maskedForm(form).rows.map((row) => row.value)).toEqual(["Leo Ivanov", "2016-••-••", "•••• 5678"]);
    // Every row's source is named without its quote: a sensitive row's holds the value, and a plain row's may hold another.
    expect(maskedForm(form).rows.map((row) => row.source)).toEqual(["your words", "your words", "the form, page 2"]);
    // A sender note stays.
    expect(
      maskedForm({ ...form, rows: [{ ...form.rows[0]!, source: 'leo.yaml: "Leo Ivanov" (sent by member:tg:9)' }] }).rows[0]?.source,
    ).toBe("leo.yaml (sent by member:tg:9)");
    expect(maskedApprovable(form)).toBe(false);
    expect(maskedApprovable({ ...form, rows: form.rows.slice(0, 2) })).toBe(true);
    expect(maskedApprovable({ ...form, rows: form.rows.slice(0, 2), truncated: true })).toBe(false);
  });

  it("lists rows by page, with or without values, and disarms the document's words", () => {
    const disarm = (text: string) => text.replace(/\./g, "[.]");
    const masked = formLines(form, "masked", disarm);
    expect(masked).toContain("Page 2");
    expect(masked.some((line) => line.includes("•••• 5678") && line.includes("the form, page 2 [the form's own words, sensitive]"))).toBe(
      true,
    );
    expect(formLines(form, "full", disarm).some((line) => line.includes("example[.]com"))).toBe(true);
    expect(masked.some((line) => line.includes("Parent signature (signature)"))).toBe(true);
    const labels = formLines(form, "labels");
    expect(labels.join("\n")).not.toContain("Leo Ivanov");
    expect(labels.join("\n")).toContain("3 values; the values are shown in Tavi.");
    expect(formLines(form, "full").join("\n")).toContain("AB-1234-5678");
  });

  it("splits a message at line boundaries into at most so many parts", () => {
    expect(splitMessage("aaa\nbbb\nccc", 7, 3)).toEqual(["aaa\nbbb", "ccc"]);
    expect(splitMessage("aaa\nbbb\nccc", 3, 2)).toBeUndefined();
    expect(splitMessage("aaaa", 3, 3)).toBeUndefined();
  });

  it("offers a reject-only card without values where a fill may not be approved", () => {
    const round = {
      taskId: "task-1",
      steps: 1,
      invocation: { workspaceId: "w", principalId: "p", runId: "task-1", caller: "test" },
      requests: [
        {
          callId: "c1",
          toolName: "pdf.fill",
          summary: "fill",
          input: {},
          display: { title: "Fill registration.pdf", command: "PLAIN TABLE", form },
        },
      ],
    };
    const text = renderRoundText(round, "abcd2345", undefined, { formApproval: "none" });
    expect(text).not.toContain("PLAIN TABLE");
    expect(text).not.toContain("Leo Ivanov");
    expect(text).toContain("reject abcd2345 <reason> — this form fill can be approved only in Tavi");
    expect(text).not.toContain("approve abcd2345");
  });
});

describe("an email link's page", () => {
  it("shows each form as a table, every cell escaped", async () => {
    const hostile = { ...form, rows: [{ ...form.rows[0]!, field: "<script>alert(1)</script>", value: "<img src=x onerror=alert(2)>" }] };
    const approvals = {
      describeLink: async () => ({
        ok: true as const,
        view: {
          kind: "round" as const,
          title: "Round",
          body: "",
          choiceLabel: "Approve once",
          needsPin: false,
          allowsNote: false,
          forms: [maskedForm(hostile)],
        },
      }),
    } as Pick<ChannelApprovals, "describeLink"> as ChannelApprovals;
    const links = createApprovalLinkHandler(approvals, { publicUrl: "https://mail.example.test" });
    const server = createServer((req, res) => void links(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const page = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/i/${"a".repeat(22)}`)).text();
      expect(page).toContain("<table>");
      expect(page).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
      expect(page).not.toContain("<script>");
      expect(page).not.toContain("<img");
    } finally {
      server.close();
    }
  });
});

interface Harness {
  readonly runtime: TaviRuntime;
  readonly sent: () => string[];
  readonly messages: () => readonly OutboundMessage[];
  readonly directory: string;
}

/** An owner with one fixture channel, the model scripted to read the form's fields and fill it from the person's words. */
async function harness(
  fill: { readonly dobQuote: string },
  channel: { readonly capabilities?: Partial<MessagingCapabilities>; readonly failedSends?: number } = {},
): Promise<Harness & { readonly artifactId: string }> {
  let failedSends = channel.failedSends ?? 0;
  const directory = directories.create("tavi-pdf-approvals-");
  const bytes = await registrationForm();
  const { turns, source } = pdfFillTurns(bytes, fill.dobQuote);
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: ["mutating", "external"],
    }),
    { modelOverride: createFixtureModel({ turns }) },
  );
  const instances: FixtureMessagingConnectorInstance[] = [];
  const fixture = createFixtureMessagingConnectorDefinition({
    onInstanceCreated: (instance) => instances.push(instance),
    // The first `failedSends` sends are refused, as a connection that is down refuses them.
    sendOutcome: () =>
      (failedSends -= 1) >= 0
        ? { status: "rejected", retryable: true, parts: [{ index: 0, status: "rejected", error: "connection is down" }] }
        : {
            status: "accepted",
            retryable: false,
            parts: [{ index: 0, status: "accepted", providerMessageId: `m-${counter}-${Math.random().toString(36).slice(2, 8)}` }],
          },
    ...(channel.capabilities === undefined ? {} : { capabilities: channel.capabilities }),
  });
  runtime.messaging.registerConnector({
    ...fixture,
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
  const stored = await repositories.artifacts.putArtifact({
    workspaceId: "default",
    contentType: "application/pdf",
    body: bytes,
    extension: "pdf",
    fileName: "registration.pdf",
  });
  source.artifactId = stored.artifactId;
  const sent = () =>
    (instances[0]?.sent ?? []).flatMap((message) => message.parts.map((part) => (part as { content?: string }).content ?? ""));
  return { runtime, sent, messages: () => instances[0]?.sent ?? [], directory, artifactId: stored.artifactId };
}

let counter = 0;
function inbound(content: string, conversationKind?: InboundEvent["conversationKind"]): InboundEvent {
  counter += 1;
  return {
    connectionId: "conn-a",
    providerEventId: `evt-${counter}`,
    kind: "message",
    externalSenderId: "user-1",
    externalConversationId: "chat-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content,
    ...(conversationKind === undefined ? {} : { conversationKind }),
  };
}

describe("tavi doctor's pdf section", () => {
  it("says whether the PDF tools are on and how their parser runs here", async () => {
    const { runtime } = await harness({ dobQuote: "2016-03-04" });
    const pdf = (await buildDoctorDocument(runtime, { integrity: "skip" }))["pdf"] as { enabled: boolean; confinement: string };
    expect(pdf.enabled).toBe(true);
    expect(pdf.confinement).toBe(process.platform === "darwin" ? "srt" : "refused");
    // Whether OCR is there to read scans and check covered text.
    expect(typeof (pdf as unknown as { ocr: unknown }).ocr).toBe("string");
    const settings = runtime.store.asPort().repositories.workspaceSettings;
    const current = await settings.get("default");
    await settings.set({
      workspaceId: "default",
      settings: { ...current.settings, pdfEnabled: false },
      expectedRevision: current.revision,
      actor: "operator",
      now: nowTimestamp(),
    });
    expect((await buildDoctorDocument(runtime, { integrity: "skip" }))["pdf"]).toMatchObject({ enabled: false, offIn: ["default"] });
    await runtime.close();
  }, 60_000);
});

describe("a form fill asked in a chat", () => {
  it("shows a one-to-one chat the values masked, and lets it approve when every masked row was verified", async () => {
    const { runtime, sent, directory } = await harness({ dobQuote: "2016-03-04" });
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("Fill the registration form: Leo Ivanov, born 2016-03-04.", "direct"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const announcement = sent().find((text) => text.startsWith("🔐")) ?? "";
    expect(announcement).toContain("Leo Ivanov");
    // The date of birth is masked to its year, and was checked against the person's words.
    expect(announcement).toMatch(/Date of birth: 2016-••-•• — your words \[✓ verified, sensitive\]/);
    expect(announcement).not.toContain("2016-03-04");
    const token = (
      (await repositories.approvalRounds.listEvents(taskId)).find((event) => event.kind === "announced")?.detail as { token: string }
    ).token;
    expect(announcement).toContain(`approve ${token}`);
    await runtime.messaging.ingest(inbound(`approve ${token}`, "direct"));
    expect(sent().at(-1)).toMatch(/approved: the run is now completed/);
    expect(existsSync(join(directory, "chats", "default", taskId, "forms", "registration-filled.pdf"))).toBe(true);
    await runtime.close();
  }, 60_000);

  it("sends a long table as up to three messages with the buttons under the last, and ❌ alone where it may only be rejected", async () => {
    const { runtime, messages } = await harness(
      { dobQuote: "March 4th" },
      { capabilities: { interactions: true, editOrProgress: true, approvals: "buttons", maxTextLength: 700 } },
    );
    await runtime.messaging.ingest(inbound("Fill the registration form: Leo Ivanov, born 2016-03-04.", "direct"));
    const announcement = messages().filter((message) => message.effectId.startsWith("approval:"));
    expect(announcement.length).toBeGreaterThan(1);
    expect(announcement.length).toBeLessThanOrEqual(3);
    for (const message of announcement) expect((message.parts[0] as { content: string }).content.length).toBeLessThanOrEqual(700);
    expect(announcement.slice(0, -1).every((message) => message.buttons === undefined)).toBe(true);
    // The date was not found in the person's words: ❌ alone.
    expect(announcement.at(-1)?.buttons?.map((row) => row.map((button) => button.label))).toEqual([["❌ Deny"]]);
    await runtime.close();
  }, 60_000);

  it("refuses an approval typed before the round's announcement went out", async () => {
    // The date was not found in the person's words: this chat may only reject it, announced or not.
    const { runtime, sent } = await harness({ dobQuote: "March 4th" }, { failedSends: 1 });
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("Fill the registration form: Leo Ivanov, born 2016-03-04.", "direct"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    expect((await repositories.approvalRounds.listEvents(taskId)).map((event) => event.kind)).toEqual(["announce_failed"]);
    await runtime.messaging.ingest(inbound(`approve ${taskId}`, "direct"));
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
    expect(sent().at(-1)).toContain("can be approved only");
    await runtime.close();
  }, 60_000);

  it("shows any other chat labels only, and refuses an approval there while a rejection goes through", async () => {
    const { runtime, sent } = await harness({ dobQuote: "2016-03-04" });
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("Fill the registration form: Leo Ivanov, born 2016-03-04.", "group"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const announcement = sent().find((text) => text.startsWith("🔐")) ?? "";
    expect(announcement).toContain("Date of birth");
    expect(announcement).not.toContain("Leo Ivanov");
    expect(announcement).toContain("2 values; the values are shown in Tavi.");
    const token = (
      (await repositories.approvalRounds.listEvents(taskId)).find((event) => event.kind === "announced")?.detail as { token: string }
    ).token;
    await runtime.messaging.ingest(inbound(`approve ${token}`, "group"));
    expect(sent().at(-1)).toContain("can be approved only in Tavi");
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
    await runtime.messaging.ingest(inbound(`reject ${token} not now`, "group"));
    expect(sent().at(-1)).toMatch(/rejected/);
    await runtime.close();
  }, 60_000);

  it("offers a one-to-one chat reject only when a masked value was not verified", async () => {
    // The date's quote is nowhere in the person's words: unmatched, and masked here.
    const { runtime, sent } = await harness({ dobQuote: "March 4th" });
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(inbound("Fill the registration form: Leo Ivanov, born 2016-03-04.", "direct"));
    const taskId = (await repositories.messagingConversations.get("conn-a", "chat-1"))?.taskId ?? "";
    const announcement = sent().find((text) => text.startsWith("🔐")) ?? "";
    expect(announcement).toMatch(/Date of birth: 2016-••-•• — .*not found in its source, sensitive/);
    expect(announcement).toContain("can be approved only in Tavi");
    const token = (
      (await repositories.approvalRounds.listEvents(taskId)).find((event) => event.kind === "announced")?.detail as { token: string }
    ).token;
    await runtime.messaging.ingest(inbound(`approve ${token}`, "direct"));
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
    await runtime.close();
  }, 60_000);
});
