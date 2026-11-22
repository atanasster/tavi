import { renderTextRef } from "@tavi/contracts";
import { createTranslator } from "@tavi/contracts/i18n";
import { CORE_BG } from "@tavi/contracts/locales/core-bg";
import { CORE_EN } from "@tavi/contracts/locales/core-en";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/io.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** A refusal a person reads crosses the wire with its key beside its English, so the canvas can say it in its language. */

const directories = temporaryDirectories({ prefix: "tavi-error-keys-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];
const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };
const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function attach(): Promise<IpcClient> {
  const directory = directories.create();
  handles.push(
    await serve(
      fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }),
      { dataDirectory: directory, drainDeadlineMs: 5_000 },
      quietIo,
      {
        modelOverride: createFixtureModel({ turns: [{ text: "x" }] }),
      },
    ),
  );
  const owner = await findLiveOwner(directory);
  if (owner === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(owner);
  clients.push(client);
  return client;
}

describe("keyed refusals on the wire", () => {
  it("sends a refusal the owner words itself with its key and the same English", async () => {
    const client = await attach();
    const refused = await client.request("subscribe", { taskId: "task-that-never-was" }, "sub-missing");
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Task task-that-never-was does not exist",
        i18n: { key: "error.task.notFound", params: { taskId: "task-that-never-was" } },
      },
    });
    expect(renderTextRef(refused.error!.i18n!, bg)).toBe("Чатът task-that-never-was не съществува");
  });

  it("sends a thrown keyed error's key through the command's answer", async () => {
    const client = await attach();
    const refused = await client.request("reminders", { action: "get", reminderId: "rem-missing" }, "rem-missing");
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Reminder rem-missing does not exist",
        i18n: { key: "error.reminder.notFound", params: { reminderId: "rem-missing" } },
      },
    });
  });

  it("sends an error with no key as English only", async () => {
    const client = await attach();
    const refused = await client.request("subscribe", { nonsense: true }, "bad-payload");
    expect(refused.ok).toBe(false);
    expect(refused.error?.i18n).toBeUndefined();
  });
});
