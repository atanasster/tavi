import { expect } from "vitest";

import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

/** A dev server's first move: listen on a port, say so, and close. Run with `node`, inside the sandbox. */
const LISTEN = [
  'import { createServer } from "node:net";',
  "",
  "const server = createServer();",
  'server.on("error", (error) => console.log(`could not listen: ${error.code}`));',
  'server.listen(0, process.env.HOST ?? "127.0.0.1", () => {',
  '  console.log("listening");',
  "  server.close();",
  "});",
  "",
].join("\n");

const PROMPT = "In the shell, run `node listen.mjs`, then run `script -q /dev/null tty`. Reply with what each printed.";

/** The project folder the chats work in, and the flags every owner of this walk gets. */
let folder = "";
const base = () => ["--allow", "sandbox.run", "--fs-root", folder];

type Walk = Parameters<Parameters<typeof walkGuide>[1]["steps"][string]>[0];

/**
 * Asks for the two commands with `tavi run` in the project folder, as a reader asks in a chat on it, and shows the
 * chat on the canvas once its turn has ended (the answer masked: the model's own words). Returns the chat's recorded
 * timeline, as text: what each shell command printed is in it.
 */
async function askAndShow(walk: Walk): Promise<string> {
  walk.tavi("run", "--folder", folder, PROMPT);
  const run = chats(walk.tavi).find((chat) => chat.chatKind === "run");
  const page = await walk.open(`/tasks/${run?.taskId ?? ""}`);
  await page
    .getByRole("button", { name: /^Copy response/ })
    .last()
    .waitFor({ timeout: 60_000 });
  // The answer from its start, tall enough to show what each command printed.
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page
    .locator("main .markdown")
    .last()
    .evaluate((answer) => answer.scrollIntoView({ block: "start" }));
  await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
  await page.setViewportSize({ width: 1280, height: 800 });
  return walk.tavi("tasks", run?.taskId ?? "", "--format", "json");
}

walkGuide("run-and-maintain/sandbox-operator-options", {
  configured: true,
  model: true,
  steps: {
    "see-what-a-run-can-t-do-by-default": async (walk) => {
      folder = projectsFolder("sandbox-operator-options", { "dev/listen.mjs": LISTEN });
      folder = `${folder}/dev`;
      await restartOwner(walk.dataDir, base());
      const recorded = await askAndShow(walk);
      expect(recorded).toMatch(/stdout\\*": ?\\*"could not listen: EPERM/);
      expect(recorded).toContain("tcgetattr/ioctl: Operation not supported");
    },
    "let-runs-listen": async (walk) => {
      await restartOwner(walk.dataDir, [...base(), "--sandbox-local-bind"]);
      const recorded = await askAndShow(walk);
      expect(recorded).toMatch(/stdout\\*": ?\\*"listening/);
      // Still no terminal: script printed no device.
      expect(recorded).not.toMatch(/\/dev\/ttys\d+/);
    },
    "let-runs-open-terminals": async (walk) => {
      await restartOwner(walk.dataDir, [...base(), "--sandbox-local-bind", "--sandbox-pty"]);
      const recorded = await askAndShow(walk);
      expect(recorded).toMatch(/stdout\\*": ?\\*"listening/);
      expect(recorded).toMatch(/\/dev\/ttys\d+/);
    },
    "read-every-granted-https-connection": async (walk) => {
      await restartOwner(walk.dataDir, [...base(), "--sandbox-inspect-tls"]);
      walk.unwalked("a run reaching a granted HTTPS host: a walk reaches no third party, and the sandbox never dials this machine");
      const screen = await walk.terminal({
        title: "tavi serve",
        args: ["serve", "--sandbox-inspect-tls", "--sandbox-parent-proxy", "http://proxy.example:3128"],
        tty: true,
        input: [{ wait: 4 }],
        lines: 2,
        cols: 150,
      });
      expect(screen.join("\n")).toContain("--sandbox-inspect-tls cannot be used with --sandbox-parent-proxy");
    },
  },
});
