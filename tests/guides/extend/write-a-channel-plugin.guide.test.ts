import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { expect, onTestFinished } from "vitest";

import { guideCode, plugin, pluginFolder, ready, validate } from "../support/extend.js";
import { restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

const ID = "acme.parrot";
/** The listener's port, as the page gives it: fixed, so the pictures do not change from run to run. */
const PORT = 48733;
/** The code the page shows: what the reader saves, and what the walk installs. */
const code = guideCode("extend/write-a-channel-plugin");

/** Made-up test secrets for the made-up service, new for each run, kept in files as the page says. */
const SECRETS = { apiToken: randomBytes(18).toString("hex"), webhookSecret: randomBytes(18).toString("hex") };

let folder: ReturnType<typeof pluginFolder>;
let connectionId = "";

/** Parrot's API, as the walk plays it on this computer: the replies Tavi posts to it, with the token they carried. */
const parrot = { url: "", replies: [] as { readonly to: string; readonly text: string; readonly token: string }[] };

function startParrot(): Promise<void> {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/api/messages") {
        response.writeHead(404).end();
        return;
      }
      const sent = JSON.parse(body) as { to: string; text: string };
      parrot.replies.push({ ...sent, token: String(request.headers.authorization ?? "") });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `m-${parrot.replies.length}` }));
    });
  });
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      parrot.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      resolve();
    }),
  );
}

interface Connections {
  readonly connections: readonly {
    readonly connectionId: string;
    readonly providerId: string;
    readonly status?: { readonly state?: string };
  }[];
}

walkGuide("extend/write-a-channel-plugin", {
  configured: true,
  model: true,
  steps: {
    "describe-the-channel": async (walk) => {
      folder = pluginFolder("write-a-channel-plugin", "acme-parrot");
      folder.write("json", code.manifest);
      // Refused, as the page shows: on a terminal, so the picture has what it printed.
      const screen = await walk.terminal({
        title: "tavi plugins install",
        args: ["plugins", "install", folder.dir],
        tty: true,
        input: [{ until: "does not exist", wait: 30 }],
      });
      expect(screen.join("\n")).toContain("index.mjs does not exist");
    },
    "write-the-connector": async (walk) => {
      folder.write("js", code.module);
      expect(validate(folder.dir).problems).toEqual([]);
      const screen = await walk.terminal({ title: "tavi plugins install", args: ["plugins", "install", folder.dir] });
      expect(screen.join("\n")).toContain(`installed ${ID}@1.0.0 (proposed)`);
    },
    "review-what-it-reaches": async (walk) => {
      const page = await walk.open("/settings/plugins");
      const row = page.locator(`[id="plugin-row-${ID}"]`);
      await row.getByText("awaits review", { exact: true }).waitFor();
      await expect(row.textContent()).resolves.toMatch(/Receives messages from outside and can send as you on Parrot/i);
      await walk.shot(row);
    },
    "approve-it-enable-it-and-add-a-connection": async (walk) => {
      const page = await walk.page();
      const row = page.locator(`[id="plugin-row-${ID}"]`);
      await row.getByRole("button", { name: `Approve 1.0.0 in-process: ${ID}`, exact: true }).click();
      // A channel cannot run as a confined worker: the confirmation says what approving it in-process lets it do.
      await page.getByRole("dialog").getByRole("button", { name: "Approve in-process (unsandboxed)" }).click();
      await expect.poll(() => plugin(walk, ID)?.versions[0]?.reviewState, { timeout: 15_000 }).toBe("approved");
      await row.getByRole("button", { name: `Enable ${ID}` }).click();
      await expect.poll(() => plugin(walk, ID)?.enabled, { timeout: 15_000 }).toBe(true);
      await restartOwner(walk.dataDir, []);
      await ready(walk, ID);
      await startParrot();
      const secrets = temporaryDirectories({ prefix: "tavi-parrot-" });
      onTestFinished(() => secrets.cleanup());
      const dir = secrets.create();
      for (const [key, value] of Object.entries(SECRETS)) writeFileSync(join(dir, key), value, { mode: 0o600 });
      connectionId = walk
        .tavi(
          ...["channels", "add", "parrot", "--apiUrl", parrot.url],
          ...["--secret-file", `apiToken=${join(dir, "apiToken")}`, "--secret-file", `webhookSecret=${join(dir, "webhookSecret")}`],
        )
        .trim()
        .split(/\s+/)
        .at(-1) as string;
      await expect
        .poll(
          () => walk.taviJson<Connections>("channels", "list").connections.find((each) => each.providerId === "parrot")?.status?.state,
          {
            timeout: 30_000,
          },
        )
        .toBe("running");
      const channels = await walk.open("/settings/messaging");
      const connection = channels.locator("li.row", { hasText: "Parrot" }).first();
      await connection.waitFor();
      await walk.shot(connection);
    },
    "point-the-service-at-tavi": async (walk) => {
      walk.tavi("channels", "ingress", "--port", String(PORT));
      const screen = await walk.terminal({ title: "tavi channels list", args: ["channels", "list"], cols: 120 });
      expect(screen.join("\n")).toContain(String(PORT));
      // A call without the secret is refused before the plugin's handle sees it.
      const refused = await fetch(`http://127.0.0.1:${PORT}/hooks/${connectionId}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "m-0", from: "u-sam", text: "Hi" }),
      });
      expect(refused.status).toBe(403);
    },
    "allow-yourself": async (walk) => {
      const page = await walk.open("/settings/people");
      const form = page.locator("form", { has: page.getByRole("heading", { name: "Allow a person" }) });
      await form.getByRole("textbox", { name: "Parrot user" }).fill("u-sam");
      await form.getByRole("checkbox", { name: "This is me" }).check();
      await walk.shot(form);
      await form.getByRole("button", { name: "Allow person" }).click();
      await expect.poll(() => walk.tavi("channels", "people", connectionId), { timeout: 15_000 }).toMatch(/u-sam/);
    },
    "say-hello": async (walk) => {
      const delivered = await fetch(`http://127.0.0.1:${PORT}/hooks/${connectionId}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRETS.webhookSecret}` },
        body: JSON.stringify({ id: "m-100", from: "u-sam", text: "Hello from Parrot! In one sentence, what can you help me with?" }),
      });
      expect(delivered.status).toBeLessThan(300);
      // The reply comes back to Parrot's API, to Sam, with the token the connection holds.
      await expect.poll(() => parrot.replies.length, { timeout: 180_000, interval: 1_000 }).toBeGreaterThan(0);
      expect(parrot.replies[0]).toMatchObject({ to: "u-sam", token: `Bearer ${SECRETS.apiToken}` });
      const tasks = JSON.parse(walk.tavi("tasks")) as { tasks: readonly { taskId: string; chatKind?: string }[] };
      const chat = tasks.tasks.find((task) => task.chatKind !== "home");
      expect(chat).toBeDefined();
      const page = await walk.open(`/tasks/${chat?.taskId}`);
      await page
        .getByRole("button", { name: /^Copy response/ })
        .first()
        .waitFor({ timeout: 60_000 });
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
  },
});
