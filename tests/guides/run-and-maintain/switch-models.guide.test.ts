import { expect } from "vitest";

import { MODEL } from "../../../scripts/docs/session.mjs";
import { writeKeyFile } from "../support/maintain.js";
import { dismissChecklist } from "../support/steps.js";
import { keyFile, walkGuide } from "../support/walk.js";

interface Roles {
  readonly workspaceDefault: { readonly target: { readonly connectionId: string; readonly model: string } } | null;
  readonly resolved: readonly { readonly role: string; readonly source: string | null; readonly target?: { readonly model: string } }[];
}

const resolved = (walk: { taviJson<T>(...args: string[]): T }, role: string) =>
  walk.taviJson<Roles>("models", "roles").resolved.find((entry) => entry.role === role);

walkGuide("run-and-maintain/switch-models", {
  // The walk starts with no model at all, and connects the one every walk uses: a reader adds theirs the same way.
  configured: false,
  model: true,
  steps: {
    "store-the-key": async (walk) => {
      // The walks' own OpenRouter key, copied into a 0600 file; it is never printed.
      const file = writeKeyFile("openrouter.key", { from: keyFile });
      const screen = await walk.terminal({
        title: "tavi credentials set openrouter --file openrouter.key",
        args: ["credentials", "set", "openrouter", "--file", file],
      });
      expect(screen.join("\n")).toContain("stored credential openrouter");
    },
    "add-the-connection": async (walk) => {
      const add = ["models", "add", "openrouter", "--base-url", MODEL.baseUrl, "--credential", "openrouter", "--model", MODEL.main];
      const screen = await walk.terminal({ title: `tavi ${add.join(" ")}`, args: add });
      expect(screen.join("\n")).toContain('"credentialRef": "openrouter"');
      expect(walk.taviJson<readonly { readonly connectionId: string }[]>("models", "list").map((entry) => entry.connectionId)).toEqual([
        "openrouter",
      ]);
    },
    "list-its-models-and-test-one": async (walk) => {
      const catalog = walk.taviJson<{ readonly models: readonly { readonly modelId: string }[] }>("models", "discover", "openrouter");
      expect(catalog.models.map((entry) => entry.modelId)).toEqual(expect.arrayContaining([MODEL.main, MODEL.fast]));
      const screen = await walk.terminal({ title: "tavi models test openrouter", args: ["models", "test", "openrouter"] });
      expect(screen.join("\n")).toMatch(/"ok": true/);
    },
    "make-it-the-default": async (walk) => {
      const screen = await walk.terminal({
        title: `tavi models set-default --connection openrouter --model ${MODEL.main}`,
        args: ["models", "set-default", "--connection", "openrouter", "--model", MODEL.main],
      });
      expect(screen.join("\n")).toContain(MODEL.main);
      expect(walk.taviJson<Roles>("models", "roles").workspaceDefault?.target).toEqual({ connectionId: "openrouter", model: MODEL.main });
      expect(resolved(walk, "main")).toMatchObject({ source: "workspace-default", target: { model: MODEL.main } });
    },
    "give-a-role-its-own-model": async (walk) => {
      const screen = await walk.terminal({
        title: `tavi models set-role fast --connection openrouter --model ${MODEL.fast}`,
        args: ["models", "set-role", "fast", "--connection", "openrouter", "--model", MODEL.fast],
      });
      expect(screen.join("\n")).toContain(MODEL.fast);
      expect(resolved(walk, "fast")).toMatchObject({ source: "role-override", target: { model: MODEL.fast } });
    },
    "check-every-role-in-the-canvas": async (walk) => {
      const page = await walk.open("/settings/models");
      await page.getByText("Anthropic: Claude Haiku 5.5").first().waitFor();
      await walk.shot();
    },
    "pick-a-model-for-one-chat": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      const picker = page.getByRole("combobox", { name: "Chat model" }).or(page.getByLabel("Chat model")).first();
      await picker.click();
      await page.getByPlaceholder("Search models…").waitFor();
      await walk.shot();
      // Picked, it is the chat's model and the default new chats start on. (The picture's checks closed the list.)
      if (!(await page.getByPlaceholder("Search models…").isVisible())) await picker.click();
      await page.getByPlaceholder("Search models…").fill("Claude Haiku 5.5");
      await page
        .getByRole("option", { name: /Claude Haiku 5\.5/ })
        .first()
        .click();
      await expect.poll(() => walk.taviJson<Roles>("models", "roles").workspaceDefault?.target.model).toBe(MODEL.fast);
    },
  },
});
