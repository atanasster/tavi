import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import type { SerializableAdmitRequest } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import { DatabaseClient, persistenceWorkerUrl } from "../src/persistence/client.js";
import { WorkerChannel } from "../src/persistence/worker-channel.js";
import type { DatabaseOperations } from "../src/persistence/protocol.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const at = "2026-09-28T00:00:00.000Z";

it("reconciles admissions, artifacts and revisions after commit but before acknowledgement", async () => {
  const directory = directories.create("tavi-lost-reply-");
  const options = { databasePath: join(directory, "database.sqlite"), artifactsDirectory: join(directory, "artifacts") };
  const wrapper = join(directory, "drop-reply.mjs");
  // The real worker executes and commits the operation; only its first result
  // envelope is intercepted. No fake SQL or successful response is substituted.
  writeFileSync(
    wrapper,
    `import {parentPort} from 'node:worker_threads';
    const post = parentPort.postMessage.bind(parentPort);
    parentPort.postMessage = (message, ...args) => {
      if (message.type === 'result') process.exit(77);
      return post(message, ...args);
    };
    await import(${JSON.stringify(persistenceWorkerUrl("database-worker").href)});`,
  );
  const loseReply = async <K extends keyof DatabaseOperations>(operation: K, input: DatabaseOperations[K]["input"]) => {
    const channel = new WorkerChannel(pathToFileURL(wrapper), { workerData: options, execArgv: [] });
    try {
      await channel.ready;
      await expect(channel.request(operation, input)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { mutationOutcome: "unknown" },
      });
      expect(channel.available).toBe(false);
    } finally {
      await channel.abort();
    }
  };
  const admission: SerializableAdmitRequest = {
    workspaceId: "default",
    principalId: "operator",
    operationKey: "once",
    kind: "start",
    intent: { prompt: "hello" },
    checkpointNamespace: "",
    newTaskId: "task-one",
    newThreadId: "thread-one",
    newAdmissionId: "admission-one",
    now: at,
    prompt: { builtin: { text: "Built in", version: "v1" } },
  };
  await loseReply("repository.tasks.admit", [admission]);
  let client = await DatabaseClient.open(options);
  try {
    expect(await client.repositories.tasks.getByOperationKey("default", "operator", "once")).toBeDefined();
    const replay = await client.repositories.tasks.admit({ ...admission, newTaskId: "must-not-exist", newAdmissionId: "must-not-exist" });
    expect(replay.created).toBe(false);
    expect(replay.task.taskId).toBe("task-one");
    expect(await client.repositories.tasks.listAdmissions("task-one")).toHaveLength(1);
    expect(await client.repositories.tasks.get("must-not-exist")).toBeUndefined();
  } finally {
    await client.close();
  }

  const publication = {
    artifactId: "art-once",
    workspaceId: "default",
    contentType: "text/plain",
    body: "durable artifact",
    extension: "txt",
  };
  await loseReply("repository.artifacts.putArtifact", [publication]);
  client = await DatabaseClient.open(options);
  try {
    expect(await client.getArtifact(publication.artifactId)).toMatchObject({ sha256: sha256Hex(publication.body) });
    const replay = await client.putArtifact(publication);
    expect(replay.artifactId).toBe(publication.artifactId);
    expect(new TextDecoder().decode(await client.readArtifactBody(publication.artifactId))).toBe(publication.body);
    expect((await client.listArtifacts({ workspaceId: "default", limit: 10, includeDecided: true })).rows).toHaveLength(1);
    await expect(client.putArtifact({ ...publication, body: "different" })).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await client.close();
  }

  const setting = { workspaceId: "default", text: "revision one", expectedRevision: 0, actor: "operator", now: at };
  await loseReply("repository.systemPrompts.set", [setting]);
  client = await DatabaseClient.open(options);
  try {
    expect(await client.repositories.systemPrompts.get("default")).toMatchObject({ text: setting.text, revision: 1 });
    await expect(client.repositories.systemPrompts.set(setting)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await client.repositories.systemPrompts.get("default")).toMatchObject({ revision: 1 });
  } finally {
    await client.close();
  }

  const timezone = { workspaceId: "default", settings: { timezone: "Europe/Berlin" }, expectedRevision: 0, actor: "operator", now: at };
  await loseReply("repository.workspaceSettings.set", [timezone]);
  client = await DatabaseClient.open(options);
  try {
    expect(await client.repositories.workspaceSettings.get("default")).toMatchObject({ settings: timezone.settings, revision: 1 });
    await expect(client.repositories.workspaceSettings.set(timezone)).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await client.close();
  }
}, 15_000);
