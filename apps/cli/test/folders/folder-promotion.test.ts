import { createHash } from "node:crypto";
import { linkSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TRUSTED_PUBLIC, artifactLabel, untrustedLabel, type ContentLabel } from "@tavi/contracts";
import type {
  ArtifactRepositoryPort,
  BrowserAction,
  ChatFolder,
  InvocationContext,
  MessagingServicePort,
  ModelEvent,
  ModelOutcome,
  ModelPort,
  ModelRequest,
  OutboundMessage,
  SendOutcome,
  ToolRule,
} from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import {
  createInMemoryApprovalRepository,
  createInMemoryArtifactRepository,
  createInMemoryCancellationRepository,
  createInMemoryEffectRepository,
  createInMemoryExecutionRepository,
  createInMemoryReceiptRepository,
  createInMemorySaver,
  createInMemoryTaskRepository,
} from "@tavi/test-support/fakes";
import { createWorkflowAdapter } from "@tavi/agent-host/workflow";
import { FolderSpace, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";

import { createFolderPromotion } from "../../src/features/folders/promotion.js";
import { folderFileReader, folderFileTaint } from "../../src/features/folders/fs-tools.js";
import { registerMessagingTools } from "../../src/features/channels/tools.js";
import { registerBrowserTools } from "../../src/features/sandbox/tools.js";

/**
 * A file of the chat's folder sent out by path: `browser.act` upload and `messaging.send_to` file. It leaves only as an
 * artifact, approved by the call's own approval — whose card shows its name,
 * size and sha256 — and never without a person: a call a rule allowed puts it
 * pending and the turn waits for its review.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const PDF = "%PDF-1.7 the report";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A chat whose folder is its managed one, holding `out/report.pdf`; and a file outside it. */
function setup(space?: { checkFloor(): void }) {
  const base = realpathSync(directories.create("tavi-promotion-"));
  const data = join(base, "data");
  const managed = join(data, "chats", "default", "chat-1");
  mkdirSync(join(managed, "out"), { recursive: true });
  writeFileSync(join(managed, "out", "report.pdf"), PDF);
  writeFileSync(join(base, "outside.txt"), "not the chat's");
  const folder: ChatFolder = {
    primary: managed,
    primaryKind: "managed",
    managed,
    scratch: join(managed, ".tmp"),
    home: join(managed, ".home"),
    attachments: [],
    revision: 0,
  };
  const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "chat-1", caller: "test", folder };
  // Every put counted, so "exactly one row" is checked rather than assumed.
  const store = createInMemoryArtifactRepository();
  const puts: string[] = [];
  const artifacts: ArtifactRepositoryPort = {
    ...store,
    putArtifact: async (input) => {
      const record = await store.putArtifact(input);
      puts.push(record.artifactId);
      return record;
    },
  };
  const promotion = createFolderPromotion({
    read: folderFileReader({ dataDirectory: data }),
    artifacts,
    ...(space === undefined ? {} : { space }),
  });
  const acted: BrowserAction[] = [];
  const registry = new ToolRegistry();
  registerBrowserTools(
    registry,
    {
      ...createFixtureBrowser(),
      act: async (action) => {
        acted.push(action);
        return { status: "accepted" as const };
      },
    },
    { promotion },
  );
  const sent: OutboundMessage[] = [];
  registerMessagingTools(registry, messagingService(sent), (prefix) => `${prefix}-${sent.length + 1}`, {
    allowedDestinations: ["chat-9"],
    connectionIds: ["telegram-main"],
    promotion,
  });
  const call = (
    id: string,
    input: unknown,
    extra: { approvedBy?: string; approvedContentHash?: string; contextLabel?: ContentLabel } = {},
  ) => registry.get(id)!.handler({ input, context, signal: new AbortController().signal, ...extra });
  const assess = (id: string, input: unknown) => registry.get(id)!.assess!(input, context);
  return { base, data, managed, folder, context, store, puts, acted, sent, registry, call, assess };
}

function messagingService(sent: OutboundMessage[]): MessagingServicePort {
  return {
    registerConnector: () => {},
    unregisterConnector: async () => false,
    openConnection: async () => {},
    closeConnection: async () => {},
    ingest: async () => ({ accepted: true, duplicate: false }),
    send: async (message) => {
      sent.push(message);
      const outcome: SendOutcome = {
        status: "accepted",
        retryable: false,
        parts: message.parts.map((_part, index) => ({ index, status: "accepted" })),
      };
      return outcome;
    },
    recordDelivery: async () => false,
    buildReplyDestination: (connectionId, replyTo) => ({ chatId: replyTo.externalConversationId, connectionId }),
    buildDestination: (_connectionId, target) => ({ chatId: target.to }),
    providerOf: () => "telegram",
    statusOf: () => undefined,
    ingressOf: () => undefined,
    connectionsOf: () => [],
    capabilitiesOf: () => undefined,
    answerInteraction: async () => {},
    editMessage: async () => false,
    replay: async () => ({ outcome: "not-found" as const }),
  };
}

const upload = { sessionId: "s1", ref: "e1", epoch: 1, kind: "upload", path: "out/report.pdf" } as const;
const sendFile = { kind: "file", connectionId: "telegram-main", to: "chat-9", path: "out/report.pdf" } as const;

describe("an outbound file by path: the approval card", () => {
  it.each([
    ["browser.act", upload],
    ["messaging.send_to", sendFile],
  ] as const)("%s shows the file's name, size and sha256, and binds the approval to that hash", (tool, input) => {
    const { assess } = setup();
    const assessment = assess(tool, input);
    expect(assessment.hardDeny).toBeUndefined();
    expect(assessment.display.title).toContain(`report.pdf (${PDF.length} bytes)`);
    expect(assessment.display.detail).toContain(`sha256: ${sha(PDF)}`);
    expect(assessment.display.detail).toContain("File: out/report.pdf");
    expect(assessment.contentHash).toBe(sha(PDF));
  });

  it("refuses at the gate a path outside the chat's folders, a hard-linked folder file, both forms at once, and a path on a non-upload", () => {
    const { base, managed, assess } = setup();
    expect(assess("browser.act", { ...upload, path: join(base, "outside.txt") }).hardDeny).toMatch(/outside your working folder/);
    expect(assess("messaging.send_to", { ...sendFile, path: "../../../../outside.txt" }).hardDeny).toMatch(/outside your working folder/);
    linkSync(join(managed, "out", "report.pdf"), join(managed, "linked.pdf"));
    expect(assess("browser.act", { ...upload, path: "linked.pdf" }).hardDeny).toMatch(/other hard links/);
    expect(assess("browser.act", { ...upload, artifactId: "art-1" }).hardDeny).toMatch(/exactly one of artifactId and path/);
    expect(assess("messaging.send_to", { ...sendFile, artifactId: "art-1" }).hardDeny).toMatch(/exactly one of artifactId and path/);
    expect(assess("browser.act", { ...upload, kind: "click" }).hardDeny).toMatch(/only to upload/);
    expect(assess("browser.act", { ...upload, path: "missing.pdf" }).hardDeny).toMatch(/does not exist/);
  });
});

describe("an outbound file by path: the call", () => {
  it("an upload a person approved puts exactly one artifact — the chat's, approved by them — and uploads it", async () => {
    const { call, puts, store, acted } = setup();
    await call("browser.act", upload, { approvedBy: "alice", approvedContentHash: sha(PDF) });
    expect(puts).toHaveLength(1);
    const record = await store.getArtifact(puts[0]!);
    expect(record).toMatchObject({
      runId: "chat-1",
      workspaceId: "default",
      reviewState: "approved",
      reviewedBy: "alice",
      fileName: "report.pdf",
      sha256: sha(PDF),
      contentType: "application/pdf",
    });
    expect(new TextDecoder().decode(await store.readArtifactBody(puts[0]!))).toBe(PDF);
    expect(acted.map((action) => action.artifactId)).toEqual([puts[0]]);
  });

  it("a send a person approved delivers the artifact under the file's name", async () => {
    const { call, puts, store, sent } = setup();
    await call("messaging.send_to", sendFile, { approvedBy: "alice", approvedContentHash: sha(PDF) });
    expect(puts).toHaveLength(1);
    expect(await store.getArtifact(puts[0]!)).toMatchObject({ runId: "chat-1", reviewState: "approved", reviewedBy: "alice" });
    expect(sent[0]?.parts).toEqual([{ kind: "file", artifactId: puts[0], filename: "report.pdf" }]);
  });

  it("refuses a file that changed after it was approved, and stores and sends nothing", async () => {
    const { call, managed, puts, acted, sent } = setup();
    writeFileSync(join(managed, "out", "report.pdf"), "%PDF swapped after approval");
    await expect(call("browser.act", upload, { approvedBy: "alice", approvedContentHash: sha(PDF) })).rejects.toThrow(
      /changed after it was approved/,
    );
    await expect(call("messaging.send_to", sendFile, { approvedBy: "alice", approvedContentHash: sha(PDF) })).rejects.toThrow(
      /changed after it was approved/,
    );
    expect(puts).toEqual([]);
    expect(acted).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each([
    ["browser.act", upload],
    ["messaging.send_to", sendFile],
  ] as const)("%s that no person approved puts the file pending and sends nothing", async (tool, input) => {
    const { call, puts, store, acted, sent } = setup();
    const output = (await call(tool, input)) as { status: string; artifactId: string; detail: string };
    expect(output.status).toBe("awaiting_review");
    expect(output.artifactId).toBe(puts[0]);
    expect(output.detail).toContain(`call ${tool} again with artifactId ${puts[0]}`);
    expect(await store.getArtifact(puts[0]!)).toMatchObject({ runId: "chat-1", reviewState: "pending", reviewedBy: null });
    expect(acted).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("stores and sends nothing under the free-space floor, approved or not (decision n)", async () => {
    let free = 1024;
    const { call, puts, acted, sent } = setup(
      new FolderSpace({ dataDirectory: tmpdir(), freeSpaceFloorBytes: 1024 * 1024, freeBytes: () => free, freeBytesTtlMs: 0 }),
    );
    await expect(call("browser.act", upload, { approvedBy: "alice", approvedContentHash: sha(PDF) })).rejects.toThrow(/free-space-floor/);
    await expect(call("messaging.send_to", sendFile, { approvedBy: "alice", approvedContentHash: sha(PDF) })).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    await expect(call("messaging.send_to", sendFile)).rejects.toThrow(/free-space-floor/);
    expect(puts).toEqual([]);
    expect(acted).toEqual([]);
    expect(sent).toEqual([]);
    // Above it again, the same send goes.
    free = 1024 * 1024 * 1024;
    await call("messaging.send_to", sendFile, { approvedBy: "alice", approvedContentHash: sha(PDF) });
    expect(puts).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("refuses both forms, and neither, at dispatch too", async () => {
    const { call } = setup();
    await expect(call("browser.act", { ...upload, artifactId: "art-1" }, { approvedBy: "alice" })).rejects.toThrow(
      /exactly one of artifactId and path/,
    );
    const { path: _path, ...neither } = sendFile;
    await expect(call("messaging.send_to", neither)).rejects.toThrow(/exactly one of `artifactId` and `path`/);
  });
});

describe("an outbound file's label", () => {
  const web = untrustedLabel("web", {
    principal: "host:example.com",
    ref: { ref: "c1", host: "example.com", at: "2026-10-13T00:00:00.000Z" },
  });

  it("stores a promoted file with the calling conversation's label, and a file of downloads/ as a download too", async () => {
    const { call, puts, store, managed } = setup();
    await call("browser.act", upload, { approvedBy: "alice", approvedContentHash: sha(PDF), contextLabel: web });
    expect((await store.getArtifact(puts[0]!))?.label).toEqual(web);
    await call("messaging.send_to", sendFile, { approvedBy: "alice", approvedContentHash: sha(PDF) });
    // No conversation label and a file of its own: none stored, so it reads as untrusted from an unknown source.
    const unlabelled = (await store.getArtifact(puts[1]!))!;
    expect(unlabelled.label).toBeUndefined();
    expect(artifactLabel(unlabelled)).toMatchObject({ integrity: "untrusted", sources: ["unknown-source"] });
    mkdirSync(join(managed, "downloads"), { recursive: true });
    writeFileSync(join(managed, "downloads", "page.pdf"), PDF);
    await call(
      "browser.act",
      { ...upload, path: "downloads/page.pdf" },
      { approvedBy: "alice", approvedContentHash: sha(PDF), contextLabel: TRUSTED_PUBLIC },
    );
    expect((await store.getArtifact(puts[2]!))?.label).toMatchObject({
      integrity: "untrusted",
      sources: ["download"],
      confidentiality: "personal",
    });
  });

  it("stores a file of a tainted chat's folder with that chat's taint, whatever the calling conversation's", async () => {
    const { data, folder, context } = setup();
    const store = createInMemoryArtifactRepository();
    const promotion = createFolderPromotion({ read: folderFileReader({ dataDirectory: data }), artifacts: store });
    const tainted = { ...context, folder: { ...folder, taintedFolders: [{ path: folder.managed, taskId: "chat-1" }] } };
    const { record } = await promotion.promote({
      path: "out/report.pdf",
      context: tainted,
      approvedBy: "alice",
      approvedContentHash: sha(PDF),
      contextLabel: TRUSTED_PUBLIC,
    });
    expect(record.label).toMatchObject({
      integrity: "untrusted",
      sources: ["sandbox"],
      refs: [expect.objectContaining({ source: "sandbox", ref: "chat:chat-1" })],
    });
    const { record: clean } = await promotion.promote({
      path: "out/report.pdf",
      context,
      approvedBy: "alice",
      approvedContentHash: sha(PDF),
      contextLabel: TRUSTED_PUBLIC,
    });
    expect(clean.label).toEqual(TRUSTED_PUBLIC);
  });

  it("stores a file with a taint recorded since the turn began, and a host file still holding marked bytes, as `sandbox`", async () => {
    const { data, context } = setup();
    const store = createInMemoryArtifactRepository();
    let late: readonly { readonly path: string; readonly taskId: string }[] = [];
    let marked: { readonly taskId?: string } | undefined;
    const asked: string[] = [];
    const options = {
      dataDirectory: data,
      taintedFoldersNow: async () => late,
      hostWrites: {
        record: async () => undefined,
        writerOf: async (_workspaceId: string, _path: string, sha256: string) => {
          asked.push(sha256);
          return marked;
        },
      },
    };
    const promotion = createFolderPromotion({ read: folderFileReader(options), taintOf: folderFileTaint(options), artifacts: store });
    const promote = async () =>
      (
        await promotion.promote({
          path: "out/report.pdf",
          context,
          approvedBy: "alice",
          approvedContentHash: sha(PDF),
          contextLabel: TRUSTED_PUBLIC,
        })
      ).record.label;
    expect(await promote()).toEqual(TRUSTED_PUBLIC);
    expect(asked).toEqual([sha(PDF)]);
    late = [{ path: context.folder?.managed ?? "", taskId: "chat-1" }];
    expect(await promote()).toMatchObject({
      integrity: "untrusted",
      sources: ["sandbox"],
      refs: [expect.objectContaining({ ref: "chat:chat-1" })],
    });
    late = [];
    marked = { taskId: "chat-writer" };
    expect(await promote()).toMatchObject({
      integrity: "untrusted",
      sources: ["sandbox"],
      refs: [expect.objectContaining({ ref: "chat:chat-writer" })],
    });
    // Another workspace's mark names no chat, and is untrusted still.
    marked = {};
    expect(await promote()).toMatchObject({ integrity: "untrusted", sources: ["sandbox"], refs: [] });
  });

  it("hands a download the calling conversation's label, for the file it stores", async () => {
    const { call, acted } = setup();
    await call("browser.act", { sessionId: "s1", ref: "e1", epoch: 1, kind: "download" }, { contextLabel: web });
    expect(acted).toHaveLength(1);
    expect(acted[0]).toMatchObject({ kind: "download", contextLabel: web });
  });
});

describe("an outbound file by path under a saved rule", () => {
  /** A model that makes one call, then answers. */
  function oneCall(name: string, input: unknown): ModelPort {
    let turn = 0;
    return {
      async stream(request: ModelRequest, options: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
        turn += 1;
        if (turn === 1)
          return { status: "completed", attemptId: request.attemptId, text: "", toolCalls: [{ id: "c1", name, input }], usage: {} };
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "done" });
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    };
  }

  it.each([
    ["browser.act", upload],
    ["messaging.send_to", sendFile],
  ] as const)("%s allowed by an `always` rule does not skip review: the file waits, pending, and nothing is sent", async (tool, input) => {
    const { registry, folder, store, puts, acted, sent } = setup();
    const always: ToolRule = {
      ruleId: "always-send",
      workspaceId: "default",
      toolPattern: tool,
      decision: "allow",
      source: "operator",
      createdBy: "operator",
      createdVia: "cli",
      createdAt: "2026-10-10T00:00:00.000Z",
    };
    const workflow = createWorkflowAdapter({
      checkpointSaver: createInMemorySaver().saver,
      models: oneCall(tool, input),
      tools: registry,
      tasks: createInMemoryTaskRepository(),
      executions: createInMemoryExecutionRepository(),
      effects: createInMemoryEffectRepository(),
      receipts: createInMemoryReceiptRepository(),
      approvals: createInMemoryApprovalRepository(),
      cancellations: createInMemoryCancellationRepository(),
      artifacts: store,
      ownerSession: "test-session",
      connectionId: "fixture",
      model: "fixture-model",
      systemPrompt: "test system prompt",
      access: { resolveWorkspace: () => ({ principalId: "operator" }), missingPermissions: () => [] },
      toolPolicy: { rules: async () => [always], sessionGrants: async () => [] },
      turnFolder: () => folder,
      now: () => "2026-10-10T00:00:00.000Z",
    } as Parameters<typeof createWorkflowAdapter>[0]);
    const result = await workflow.admit({
      context: { workspaceId: "default", principalId: "operator", runId: "chat-1", caller: "test" },
      operationKey: `op-${tool}`,
      kind: "start",
      prompt: "send the report",
    });
    // The rule let the call run without a round; the file did not leave.
    expect(result.outcome.interrupt).toBeUndefined();
    expect(result.outcome.status).toBe("waiting");
    expect(puts).toHaveLength(1);
    expect(result.outcome.reviewInterrupt?.requests).toEqual([expect.objectContaining({ artifactId: puts[0], toolName: tool })]);
    expect(await store.getArtifact(puts[0]!)).toMatchObject({ runId: result.taskId, reviewState: "pending" });
    expect(acted).toEqual([]);
    expect(sent).toEqual([]);
  });
});
