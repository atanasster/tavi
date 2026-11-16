// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { roleRows, type ConnectionSummary, type RolesDocument } from "../../../src/features/settings/models-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { ModelBrowser } from "../../../src/features/settings/ModelBrowser.js";
import { announced, freshAnnouncer } from "../../announced.js";
import { InWorkspace } from "../../support/workspace.js";
import { click, mount, mountSettled } from "../../support/dom.js";

beforeEach(() => void freshAnnouncer());

/** The Models page in a DOM: roles first, one picker for every slot, connections added and managed in dialogs. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function type(input: HTMLInputElement | null, value: string): Promise<void> {
  if (input === null) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const byText = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
const byLabel = <T extends Element = HTMLButtonElement>(label: string): T | null => document.querySelector<T>(`[aria-label="${label}"]`);

const local: ConnectionSummary = {
  connectionId: "local",
  label: "Local",
  kind: "openai-compatible",
  baseUrl: "http://localhost:1234/v1",
  credentialRef: "local.apiKey",
  localOnly: true,
  defaultModel: null,
};

/** A stateful owner: connections added through the page appear in its next `list`. */
function owner(start: { connections: ConnectionSummary[]; roles: RolesDocument; disabledPlugins?: string[] }) {
  const writes: { command: string; payload: Record<string, unknown> }[] = [];
  const connections = [...start.connections];
  const client: SettingsClient = {
    request: async (command, raw) => {
      const payload = raw as Record<string, unknown>;
      const action = payload["action"];
      // The page reads the workspace's settings for the plugins turned off: a read, never a write.
      if (command === "workspace-settings")
        return { ok: true, result: start.disabledPlugins === undefined ? {} : { disabledPlugins: start.disabledPlugins } };
      if (command === "credentials") {
        if (action === "list") return { ok: true, result: { credentials: [], unusable: [] } };
        writes.push({ command, payload });
        return { ok: true, result: {} };
      }
      if (action === "list") return { ok: true, result: connections };
      if (action === "roles") return { ok: true, result: start.roles };
      if (action === "show")
        return {
          ok: true,
          result: {
            catalog: ["a", "b", "c"].map((modelId) => ({
              connectionId: payload["connectionId"],
              modelId,
              provenance: "live",
              state: "available",
              capabilities: modelId === "a" ? ["tools"] : [],
            })),
          },
        };
      writes.push({ command, payload });
      if (action === "add")
        connections.push({
          ...local,
          connectionId: String(payload["connectionId"]),
          label: String(payload["label"]),
          baseUrl: String(payload["baseUrl"]),
          credentialRef: String(payload["credentialRef"]),
          localOnly: false,
        });
      if (action === "discover") return { ok: true, result: { models: [{}, {}, {}] } };
      return { ok: true, result: { restartRequired: false } };
    },
  };
  return { client, writes };
}

describe("the Models page", () => {
  it("resolves each role to its own chain, the default, or nothing", () => {
    const main = {
      workspaceId: "default",
      role: "main" as const,
      target: { connectionId: "local", model: "a" },
      fallback: [{ connectionId: "local", model: "b" }],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const withDefault = roleRows({ workspaceDefault: { target: { connectionId: "local", model: "c" } }, resolved: [], roles: [main] });
    expect(withDefault.find((row) => row.role === "main")).toMatchObject({
      source: "override",
      target: main.target,
      fallback: main.fallback,
    });
    expect(withDefault.find((row) => row.role === "fast")).toMatchObject({ source: "default", target: { model: "c" } });
    // Embedding is served by its own binding alone, as the owner's embedding role is: never the default.
    expect(withDefault.find((row) => row.role === "embedding")).toMatchObject({ source: "unset" });
    expect(roleRows({ workspaceDefault: null, resolved: [], roles: [] }).every((row) => row.source === "unset")).toBe(true);
  });

  it("adds a first connection with a masked key, then asks for a default model", async () => {
    const fake = owner({ connections: [], roles: { workspaceDefault: null, resolved: [], roles: [] } });
    await mount(
      <InWorkspace client={fake.client} workspaceId="default">
        <ModelBrowser />
      </InWorkspace>,
    );
    expect(document.body.textContent).toContain("Connect a model provider");
    await click(byText("Add connection"));
    await click([...document.querySelectorAll(".provider-tile")].find((tile) => tile.textContent?.startsWith("OpenRouter")));

    // Beside the documentation, a link to where an OpenRouter key is made.
    const create = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent === "Create a key at OpenRouter");
    expect(create?.href).toBe("https://openrouter.ai/settings/keys");

    // A key is not a login: no password field for a password manager to fill.
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    const key = byLabel<HTMLInputElement>("Model API key");
    expect(key?.className).toBe("secret");
    expect(key?.autocomplete).toBe("off");

    await click(byText("Connect and discover models"));
    expect(document.body.textContent).toContain("Enter the provider key.");
    expect(fake.writes).toHaveLength(0);

    await type(key, "test-key");
    await click(byText("Connect and discover models"));
    expect(fake.writes.map((row) => `${row.command}:${row.payload["action"]}`)).toEqual([
      "credentials:set",
      "models:add",
      "models:discover",
    ]);
    expect(fake.writes[1]?.payload).toMatchObject({ connectionId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    expect(announced()).toContain("Discovered 3 models.");

    // No default yet: the default's picker opens, and a pick saves it.
    expect(document.querySelector(".modal h2")?.textContent).toBe("Default model");
    const choices = document.querySelectorAll<HTMLInputElement>('.picker-list input[type="radio"]');
    expect(choices).toHaveLength(3);
    await click(choices[0]);
    await click(byText("Save"));
    expect(fake.writes.at(-1)?.payload).toMatchObject({ action: "set-default", connectionId: "openrouter", model: "a" });
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("edits a role's primary and ordered fallbacks in one picker, and resets it to the default", async () => {
    const main = {
      workspaceId: "default",
      role: "main" as const,
      target: { connectionId: "local", model: "a" },
      fallback: [{ connectionId: "local", model: "b" }],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const fake = owner({
      connections: [local],
      roles: { workspaceDefault: { target: { connectionId: "local", model: "a" } }, resolved: [], roles: [main] },
    });
    await mount(
      <InWorkspace client={fake.client} workspaceId="default">
        <ModelBrowser />
      </InWorkspace>,
    );

    const rows = [...document.querySelectorAll(".role-row")];
    expect(rows).toHaveLength(6);
    expect(rows[0]?.textContent).toContain("Default");
    expect(rows.find((row) => row.textContent?.startsWith("main"))?.textContent).toContain("then b");
    expect(rows.find((row) => row.textContent?.startsWith("fast"))?.textContent).toContain("Uses default");
    // Embedding is never served by the default: it says what an unbound one means, and is not counted as a gap.
    expect(rows.find((row) => row.textContent?.startsWith("embedding"))?.textContent).toContain(
      "Not set · memory search matches words only",
    );
    expect(document.querySelector(".badge-warning")).toBeNull();
    expect(document.querySelector(".connection-item")?.textContent).toContain("3 models");

    await click(byLabel("Set the model for main"));
    expect(document.querySelector(".picker-chain")?.textContent).toContain("Primary");
    await click(byLabel("Add c as a fallback"));
    expect(byLabel("Add a as a fallback")?.disabled).toBe(true);
    await click(byLabel("Move c earlier"));
    await click(byLabel("Remove b from fallbacks"));
    await click(byText("Save"));
    expect(fake.writes.at(-1)?.payload).toMatchObject({
      action: "set-role",
      role: "main",
      connectionId: "local",
      model: "a",
      fallback: [{ connectionId: "local", model: "c" }],
    });

    // Named by the word it shows first (WCAG 2.5.3), then what it does.
    const reset = byLabel("Reset: use the default for main");
    expect(reset?.textContent).toBe("Reset");
    await click(reset);
    expect(fake.writes.at(-1)?.payload).toMatchObject({ action: "clear-role", role: "main" });
  });

  it("shows no video controls while tavi.video is off", async () => {
    const roles: RolesDocument = { workspaceDefault: null, resolved: [], roles: [] };
    const page = async (disabledPlugins?: string[]) => {
      const fake = owner({ connections: [local], roles, ...(disabledPlugins === undefined ? {} : { disabledPlugins }) });
      const host = await mountSettled(
        <InWorkspace client={fake.client} workspaceId="default">
          <ModelBrowser />
        </InWorkspace>,
      );
      return host.textContent ?? "";
    };
    expect(await page()).toContain("Video analysers");
    const off = await page(["tavi.video"]);
    expect(off).not.toContain("Video analysers");
    expect(off).not.toContain("Native video");
  });

  it("replaces a key only when confirmed, and removes a connection only when confirmed", async () => {
    const fake = owner({ connections: [local], roles: { workspaceDefault: null, resolved: [], roles: [] } });
    await mount(
      <InWorkspace client={fake.client} workspaceId="default">
        <ModelBrowser />
      </InWorkspace>,
    );
    await click(byLabel("Manage Local"));
    await type(byLabel<HTMLInputElement>("New key for Local"), "replacement");
    expect(byText("Save new key")?.disabled).toBe(true);
    await click(byText("Remove this connection…"));
    expect(fake.writes).toHaveLength(0);
    await click(byText("Remove connection"));
    expect(fake.writes.at(-1)?.payload).toMatchObject({ action: "remove", connectionId: "local" });
  });
});
