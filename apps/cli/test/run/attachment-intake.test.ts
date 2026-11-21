import type { ArtifactUploadAnswer, ReplyResult, RunResult } from "@tavi/contracts";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/io.js";
import { namedAttachments } from "../../src/features/run/attachment-intake.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * A web UI message's attachments: a PDF uploaded with
 * `artifacts upload`, named by `run` or `reply`, reaches the model as the
 * line a channel attachment leaves, quoted apart from the person's words.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n", "latin1");

async function start(): Promise<{
  readonly client: IpcClient;
  readonly model: ReturnType<typeof createFixtureModel>;
  readonly handle: ServeHandle;
}> {
  const directory = directories.create("tavi-attach-");
  const model = createFixtureModel({ turns: [{ text: "I see the form." }, { text: "And the second one." }] });
  const handle = await serve(
    fixtureServeOptions(directory, { defaultConnectionId: "fixture-conn" }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    quietIo,
    { modelOverride: model },
  );
  handles.push(handle);
  const owner = await findLiveOwner(directory);
  if (owner === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(owner);
  clients.push(client);
  return { client, model, handle };
}

async function upload(client: IpcClient, name: string): Promise<string> {
  const answer = await client.request(
    "artifacts",
    {
      action: "upload",
      workspaceId: "default",
      uploadId: `upload-${name.replace(/\W/g, "")}`,
      name,
      size: PDF.length,
      offset: 0,
      data: PDF.toString("base64"),
    },
    `upload-${name}`,
  );
  expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
  const attachment = (answer.result as ArtifactUploadAnswer).attachment;
  if (attachment === undefined) throw new Error("no attachment");
  return attachment.artifactId;
}

/** The text of each message the model was sent on its `index`th call. */
function messagesOf(model: ReturnType<typeof createFixtureModel>, index: number): string[] {
  return (model.calls[index]?.messages ?? []).map((message) => JSON.stringify(message));
}

describe("attachments named by a message", () => {
  it("quotes a run's and a reply's uploaded PDF apart from the person's words", async () => {
    const { client, model } = await start();
    const first = await upload(client, "form.pdf");
    const started = await client.request(
      "run",
      {
        prompt: "fill this in for me",
        workspaceId: "default",
        principal: "operator",
        operationKey: "op-attach",
        approval: "approve",
        attachments: [first],
      },
      "run-attach",
      { timeoutMs: 15_000 },
    );
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    await waitFor(() => model.calls.length >= 1);
    const line = messagesOf(model, 0).find((message) => message.includes(`artifact ${first}`));
    expect(line).toContain("[Attachment form.pdf (application/pdf, ");
    expect(line).not.toContain("fill this in for me");

    const second = await upload(client, "second.pdf");
    const run = started.result as RunResult;
    const replied = await client.request(
      "reply",
      { workspaceId: "default", taskId: run.taskId, text: "and this one", clientMessageId: "m-attach", attachments: [second] },
      "reply-attach",
      { timeoutMs: 15_000 },
    );
    expect(replied.ok, JSON.stringify(replied.error)).toBe(true);
    expect((replied.result as ReplyResult).duplicate).toBe(false);
    await waitFor(() => model.calls.length >= 2);
    const quoted = messagesOf(model, 1).find((message) => message.includes(`artifact ${second}`));
    expect(quoted).toContain("[Attachment second.pdf");
    expect(quoted).not.toContain("and this one");
  }, 30_000);

  it("refuses an id that is not an upload of the workspace, and a steer with files", async () => {
    const { client } = await start();
    const refused = await client.request(
      "run",
      {
        prompt: "read it",
        workspaceId: "default",
        principal: "operator",
        operationKey: "op-bad",
        approval: "approve",
        attachments: ["art-not-there"],
      },
      "run-bad",
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const id = await upload(client, "form.pdf");
    const steered = await client.request(
      "reply",
      { workspaceId: "default", conversationId: "op-none", text: "look", clientMessageId: "m-steer", intent: "steer", attachments: [id] },
      "reply-steer",
    );
    expect(steered).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  }, 30_000);

  it("erases a chat's uploaded PDF with the turn that named it", async () => {
    const { client, model, handle } = await start();
    const id = await upload(client, "form.pdf");
    const started = await client.request(
      "run",
      {
        prompt: "read this",
        workspaceId: "default",
        principal: "operator",
        operationKey: "op-erase",
        approval: "approve",
        attachments: [id],
      },
      "run-erase",
      { timeoutMs: 15_000 },
    );
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    await waitFor(() => model.calls.length >= 1);
    const taskId = (started.result as RunResult).taskId;
    const artifacts = handle.runtime.store.asPort().repositories.artifacts;
    expect((await artifacts.getArtifact(id))?.runId).toBe(taskId);
    await waitFor(
      async () =>
        (
          await client.request(
            "chat-context",
            { action: "forget", workspaceId: "default", taskId, before: new Date(Date.now() + 60_000).toISOString() },
            `forget-${Date.now()}`,
          )
        ).ok,
    );
    expect(await artifacts.getArtifact(id)).toBeUndefined();
  }, 30_000);

  it("names only an approved, untrusted PDF, video, GIF or audio upload of the workspace, each once", async () => {
    const kept = {
      artifactId: "art-up-1",
      workspaceId: "default",
      contentType: "application/pdf",
      reviewState: "approved",
      untrusted: true,
      byteSize: 2048,
      fileName: "form.pdf",
      label: { integrity: "untrusted", sources: ["attachment"], principals: [], confidentiality: "public", refs: [] },
    };
    const records: Record<string, unknown> = {
      "art-up-1": kept,
      "art-other": { ...kept, artifactId: "art-other", workspaceId: "elsewhere" },
      "art-text": { ...kept, artifactId: "art-text", contentType: "text/plain" },
      "art-pending": { ...kept, artifactId: "art-pending", reviewState: "pending" },
      "art-preview": { ...kept, artifactId: "art-preview", purpose: "thumbnail" },
      "art-trusted": { ...kept, artifactId: "art-trusted", untrusted: undefined },
      "art-web": { ...kept, artifactId: "art-web", label: { ...kept.label, sources: ["web"] } },
      "art-clip": { ...kept, artifactId: "art-clip", contentType: "video/mp4", fileName: "clip.mp4", byteSize: 4096 },
      "art-mkv": { ...kept, artifactId: "art-mkv", contentType: "video/x-matroska" },
      "art-voice": { ...kept, artifactId: "art-voice", contentType: "audio/ogg", fileName: "voice.ogg", byteSize: 4096 },
    };
    const store = { getArtifact: async (id: string) => records[id] } as unknown as Parameters<typeof namedAttachments>[0];
    expect((await namedAttachments(store, "default", ["art-up-1"]))[0]?.line).toBe(
      "[Attachment form.pdf (application/pdf, 2 KB): artifact art-up-1, untrusted content from the sender]",
    );
    // A video upload is named as a PDF is; a type the upload never takes is not.
    expect((await namedAttachments(store, "default", ["art-clip"]))[0]?.line).toBe(
      "[Attachment clip.mp4 (video/mp4, 4 KB): artifact art-clip, untrusted content from the sender]",
    );
    // An audio upload says which tool reads what is said in it.
    expect((await namedAttachments(store, "default", ["art-voice"]))[0]?.line).toContain("audio.transcribe");
    for (const id of ["art-mkv", "art-other", "art-text", "art-pending", "art-preview", "art-trusted", "art-web", "art-missing"])
      await expect(namedAttachments(store, "default", [id])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(namedAttachments(store, "default", ["art-up-1", "art-up-1"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
