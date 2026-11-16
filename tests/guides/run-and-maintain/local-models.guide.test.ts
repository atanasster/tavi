import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { delay } from "@tavi/test-support";
import { expect, onTestFinished } from "vitest";

import { startModelServer } from "../support/maintain.js";
import { walkGuide } from "../support/walk.js";

const PORT = 8088;
const MODEL_ID = "qwen3-8b";
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;
/** A `.gguf` model you have (`TAVI_GUIDE_LOCAL_MODEL`): with it the walk runs the real `llama-server`. */
const gguf = process.env["TAVI_GUIDE_LOCAL_MODEL"];
const STAND_IN =
  "no .gguf model file is on this computer (set TAVI_GUIDE_LOCAL_MODEL to one): the endpoint is the walks' made-up model server on 127.0.0.1, not llama-server, so the test shows Tavi's side of a local connection, not a real model's answer";

/** Starts `llama-server` on the model file, as the guide's Before you start does, and waits until it lists its model. */
async function startLlamaServer(model: string): Promise<void> {
  const child = spawn("llama-server", ["-m", model, "--alias", MODEL_ID, "--port", String(PORT), "--jinja"], { stdio: "ignore" });
  onTestFinished(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  for (let waited = 0; waited < 300_000; waited += 1000) {
    const listed = await fetch(`${BASE_URL}/models`).then(
      (response) => response.ok,
      () => false,
    );
    if (listed) return;
    await delay(1000);
  }
  throw new Error("llama-server did not start within five minutes");
}

interface Roles {
  readonly workspaceDefault: { readonly target: { readonly connectionId: string; readonly model: string } } | null;
  readonly resolved: readonly { readonly role: string; readonly target?: { readonly connectionId: string } }[];
}

walkGuide("run-and-maintain/local-models", {
  // No cloud model at all: the reader's local one is the only one.
  configured: false,
  steps: {
    "add-the-connection": async (walk) => {
      if (gguf !== undefined && existsSync(gguf)) {
        walk.needsUser("a local model file");
        await startLlamaServer(gguf);
      } else {
        const server = await startModelServer({ port: PORT, models: [MODEL_ID] });
        expect(server.baseUrl, `port ${PORT} is taken: the pictures would show another address`).toBe(BASE_URL);
      }
      const add = ["models", "add", "local", "--base-url", BASE_URL, "--model", MODEL_ID];
      const flags = ["--local-only", "--first-byte-timeout", "300"];
      const screen = await walk.terminal({ title: `tavi ${[...add, ...flags].join(" ")}`, args: [...add, ...flags] });
      expect(screen.join("\n")).toContain('"localOnly": true');
      // No key named: a placeholder of this connection's own, stored under its name.
      expect(screen.join("\n")).toContain('"credentialRef": "local"');
      expect(walk.taviJson<{ readonly credentials: readonly string[] }>("credentials", "list").credentials).toContain("local");
    },
    "test-it": async (walk) => {
      if (gguf === undefined) walk.unwalked(STAND_IN);
      const screen = await walk.terminal({ title: "tavi models test local", args: ["models", "test", "local"] });
      expect(screen.join("\n")).toMatch(/"ok": true/);
      expect(screen.join("\n")).toContain('"tools"');
    },
    "make-it-the-default": async (walk) => {
      const screen = await walk.terminal({
        title: `tavi models set-default --connection local --model ${MODEL_ID}`,
        args: ["models", "set-default", "--connection", "local", "--model", MODEL_ID],
      });
      expect(screen.join("\n")).toContain(MODEL_ID);
      const roles = walk.taviJson<Roles>("models", "roles");
      expect(roles.workspaceDefault?.target).toEqual({ connectionId: "local", model: MODEL_ID });
      // Every chat role now runs on this computer.
      for (const role of ["main", "extraction", "compaction", "fast"]) {
        expect(roles.resolved.find((entry) => entry.role === role)?.target?.connectionId, role).toBe("local");
      }
    },
    "check-that-every-role-stays-local": async (walk) => {
      const page = await walk.open("/settings/models");
      await page.getByText("Not set · memory search matches words only").waitFor();
      await page.getByText(`Uses default · ${MODEL_ID}`).first().waitFor();
      await walk.shot();
    },
  },
});
