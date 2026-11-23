// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { lifecycleWarningText, type LifecycleWarning } from "@tavi/contracts";

import {
  lifecycleNotice,
  roleRows,
  rolesLifecycleNotices,
  type BrowsedModel,
  type ConnectionSummary,
  type RolesDocument,
} from "../../../src/features/settings/models-api.js";
import type { ModelReplacements } from "../../../src/features/settings/lifecycle-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { ModelBrowser } from "../../../src/features/settings/ModelBrowser.js";
import { setLocale, translateCore } from "../../../src/lib/i18n.js";
import { announced, freshAnnouncer } from "../../announced.js";
import { InWorkspace } from "../../support/workspace.js";
import { click, mount, mountSettled, settle } from "../../support/dom.js";

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
function owner(start: {
  connections: ConnectionSummary[];
  roles: RolesDocument;
  disabledPlugins?: string[];
  lifecycle?: Record<string, BrowsedModel["lifecycle"]>;
  replacements?: Record<string, ModelReplacements>;
  /** Credentials already stored when the page opens. */
  credentials?: string[];
  /** A credential store that refuses every write. */
  storeFails?: boolean;
  /** An owner whose sync finds no key. */
  syncNoKey?: boolean;
}) {
  const writes: { command: string; payload: Record<string, unknown> }[] = [];
  const connections = [...start.connections];
  const stored = new Set<string>(start.credentials ?? []);
  const client: SettingsClient = {
    request: async (command, raw) => {
      const payload = raw as Record<string, unknown>;
      const action = payload["action"];
      // The page reads the workspace's settings for the plugins turned off: a read, never a write.
      if (command === "workspace-settings")
        return { ok: true, result: start.disabledPlugins === undefined ? {} : { disabledPlugins: start.disabledPlugins } };
      if (command === "credentials") {
        if (action === "list") return { ok: true, result: { credentials: [...stored], unusable: [] } };
        writes.push({ command, payload });
        if (action === "set" && start.storeFails === true)
          return { ok: false, error: { code: "UNAVAILABLE", message: "the keychain is locked" } };
        if (action === "set") stored.add(String(payload["reference"]));
        return { ok: true, result: {} };
      }
      if (action === "list") return { ok: true, result: connections };
      if (action === "roles") return { ok: true, result: start.roles };
      if (action === "replace") {
        if (payload["confirmed"] === true) writes.push({ command, payload });
        return {
          ok: true,
          result: {
            usedBy: [
              { kind: "role", workspaceId: "default", detail: "main" },
              { kind: "chat", workspaceId: "default", count: 2 },
            ],
            ...(payload["confirmed"] === true
              ? {
                  changed: [{ kind: "role", workspaceId: "default", detail: "main" }],
                  skipped: [],
                  failed: [{ use: { kind: "chat", workspaceId: "default" }, error: "database is locked" }],
                }
              : {}),
          },
        };
      }
      if (action === "lifecycle")
        return {
          ok: true,
          result: {
            checkedAt: null,
            warnings: Object.entries(start.replacements ?? {}).map(([target, replacements]) => {
              const [connectionId, model] = target.split("/");
              return { connectionId, model, level: "warning", says: [], replacements };
            }),
            unread: [],
          },
        };
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
              ...(start.lifecycle?.[modelId] === undefined ? {} : { lifecycle: start.lifecycle[modelId] }),
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
      if (action === "sync" && start.syncNoKey === true)
        return { ok: true, result: { skipped: "no-key", hint: "Store a Rhumb key first." } };
      if (action === "sync")
        return {
          ok: true,
          result: { warnings: [{ connectionId: "openai", model: "gpt-5", level: "warning", says: ["retires on 2026-12-11"] }], unread: [] },
        };
      return { ok: true, result: { restartRequired: false } };
    },
  };
  return { client, writes };
}

describe("the Models page", () => {
  it("says each model's lifecycle today, and which models the default and roles use that warn", () => {
    const at = { catalogVersion: "v", checkedAt: "2026-11-01T00:00:00.000Z" };
    const model = (modelId: string, lifecycle?: BrowsedModel["lifecycle"]): BrowsedModel => ({
      connectionId: "openai",
      modelId,
      provenance: "live",
      state: "available",
      capabilities: [],
      connectionLabel: "OpenAI",
      stale: false,
      ...(lifecycle === undefined ? {} : { lifecycle }),
    });
    const today = "2026-11-20";
    expect(lifecycleNotice(model("a"), today)).toBeUndefined();
    expect(lifecycleNotice(model("a", { status: "ga", ...at }), today)).toBeUndefined();
    expect(lifecycleNotice(model("a", { status: "deprecated", retiresOn: "2026-11-19", ...at }), today)).toMatchObject({
      level: "error",
      label: "Retired",
    });
    expect(lifecycleNotice(model("a", { status: "ga", redirect: { to: "b", on: "2026-12-01" }, ...at }), today)).toMatchObject({
      level: "warning",
      label: "Redirecting",
    });
    const models = [
      model("gpt-5", { status: "deprecated", retiresOn: "2026-12-11", ...at }),
      model("o3", { status: "deprecated", deprecatedOn: "2026-10-01", ...at }),
      model("gpt-4.1", { status: "ga", ...at }),
    ];
    const roles: RolesDocument = {
      workspaceDefault: { target: { connectionId: "openai", model: "gpt-5" } },
      resolved: [],
      roles: [
        {
          workspaceId: "default",
          role: "fast",
          target: { connectionId: "openai", model: "gpt-4.1" },
          fallback: [
            { connectionId: "openai", model: "gpt-5" },
            { connectionId: "openai", model: "o3" },
          ],
          updatedAt: "2026-11-01T00:00:00.000Z",
        } as never,
      ],
    };
    // gpt-5 once though named twice; o3's deprecation is a notice only, not a banner.
    expect(rolesLifecycleNotices({ models, roles }, today).map((entry) => entry.target)).toEqual(["openai/gpt-5"]);
  });

  it("says every lifecycle warning through contracts' lifecycleWarningText, in the page's language", async () => {
    const date = "2026-12-01";
    const warnings: LifecycleWarning[] = [
      { level: "error", code: "retired" },
      { level: "error", code: "retired", date, days: -1 },
      { level: "warning", code: "redirected", to: "b" },
      { level: "warning", code: "redirected", to: "b", via: "router", date, days: -1 },
      { level: "warning", code: "redirects_soon", to: "b" },
      { level: "warning", code: "redirects_soon", to: "b", via: "router", date, days: 10 },
      { level: "warning", code: "retires_soon" },
      { level: "warning", code: "retires_soon", date, days: 10 },
      { level: "info", code: "end_claimed" },
      { level: "info", code: "end_claimed", date, days: 10 },
      { level: "info", code: "end_claimed", date, days: 0 },
      { level: "info", code: "end_claimed", date, days: -3 },
      { level: "info", code: "deprecated" },
      { level: "info", code: "deprecated", date, days: -1 },
      { level: "info", code: "price_changes" },
      { level: "info", code: "price_changes", date, days: 10 },
    ];
    // The badge's title is the warnings in contracts' words: English as the CLI and the doctor say them.
    const lifecycle = {
      status: "deprecated" as const,
      retiresOn: "2026-11-19",
      redirect: { to: "b", via: "router", on: "2026-11-15" },
      catalogVersion: "v",
      checkedAt: "2026-11-01T00:00:00.000Z",
    };
    const browsed: BrowsedModel = {
      connectionId: "openai",
      modelId: "a",
      provenance: "live",
      state: "available",
      capabilities: [],
      connectionLabel: "OpenAI",
      stale: false,
      lifecycle,
    };
    const today = "2026-11-10";
    expect(lifecycleNotice(browsed, today)?.text).toBe(
      "will be answered and billed as b (via router) on 2026-11-15; retires on 2026-11-19",
    );
    for (const warning of warnings) expect(lifecycleWarningText(warning, translateCore)).toBe(lifecycleWarningText(warning));
    // In Bulgarian every clause comes from the core catalogue, none left in English.
    await setLocale("bg");
    try {
      for (const warning of warnings) expect(lifecycleWarningText(warning, translateCore)).not.toBe(lifecycleWarningText(warning));
      expect(lifecycleNotice(browsed, today)?.text).toBe(
        "ще отговаря и ще се таксува като b (през router) от 2026-11-15; спира на 2026-11-19",
      );
    } finally {
      await setLocale("en");
    }
  });

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

  it("names each role in Bulgarian, never its English id", async () => {
    await setLocale("bg");
    try {
      const fake = owner({
        connections: [local],
        roles: { workspaceDefault: { target: { connectionId: "local", model: "a" } }, resolved: [], roles: [] },
      });
      await mount(
        <InWorkspace client={fake.client} workspaceId="default">
          <ModelBrowser />
        </InWorkspace>,
      );
      expect([...document.querySelectorAll(".role-name")].map((name) => name.textContent)).toEqual([
        "По подразбиране",
        "основен",
        "извличане",
        "сбиване",
        "бърз",
        "ембединги",
      ]);
    } finally {
      await setLocale("en");
    }
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
    const reset = byLabel("Use default for main");
    expect(reset?.textContent).toBe("Use default");
    await click(reset);
    expect(fake.writes.at(-1)?.payload).toMatchObject({ action: "clear-role", role: "main" });
  });

  it("stores a Rhumb key from Model retirements, then checks the models in use on demand", async () => {
    const roles: RolesDocument = { workspaceDefault: null, resolved: [], roles: [] };
    const fake = owner({ connections: [local], roles });
    const host = await mountSettled(
      <InWorkspace client={fake.client} workspaceId="default">
        <ModelBrowser />
      </InWorkspace>,
    );
    expect(host.textContent).toContain("Model retirements");
    expect(host.querySelector<HTMLAnchorElement>('a[href="https://rhumbdata.com/sign-up"]')).not.toBeNull();
    await type(host.querySelector<HTMLInputElement>("#rhumb-key"), "rk_test_1");
    await click(byText("Store key"));
    await settle();
    expect(fake.writes).toContainEqual({ command: "credentials", payload: { action: "set", reference: "rhumb", value: "rk_test_1" } });
    expect(host.querySelector("#rhumb-key")).toBeNull();
    await click(byText("Check now"));
    await settle();
    expect(fake.writes.some((write) => write.command === "models" && write.payload["action"] === "sync")).toBe(true);
    expect(host.textContent).toContain("openai/gpt-5 retires on 2026-12-11");
  });

  it("keeps a key the store refused, to try again, and stores nothing blank", async () => {
    const roles: RolesDocument = { workspaceDefault: null, resolved: [], roles: [] };
    const fake = owner({ connections: [local], roles, storeFails: true });
    const host = await mountSettled(
      <InWorkspace client={fake.client} workspaceId="default">
        <ModelBrowser />
      </InWorkspace>,
    );
    const store = () => byText("Store key") as HTMLButtonElement | null;
    await type(host.querySelector<HTMLInputElement>("#rhumb-key"), "   ");
    expect(store()?.disabled).toBe(true);
    await type(host.querySelector<HTMLInputElement>("#rhumb-key"), "rk_test_2");
    await click(store());
    await settle();
    expect(host.textContent).toContain("the keychain is locked");
    // The form stays, with the key in it, for another try.
    expect(host.querySelector<HTMLInputElement>("#rhumb-key")?.value).toBe("rk_test_2");
    expect(store()?.disabled).toBe(false);
    expect(host.textContent).not.toContain("Check now");
  });

  it("offers Check now, and no form, when a key is already stored; a sync without one says why", async () => {
    const roles: RolesDocument = { workspaceDefault: null, resolved: [], roles: [] };
    const fake = owner({ connections: [local], roles, credentials: ["rhumb"], syncNoKey: true });
    const host = await mountSettled(
      <InWorkspace client={fake.client} workspaceId="default">
        <ModelBrowser />
      </InWorkspace>,
    );
    expect(host.querySelector("#rhumb-key")).toBeNull();
    expect(host.textContent).toContain("A Rhumb key is stored");
    await click(byText("Check now"));
    await settle();
    expect(host.textContent).toContain("Store a Rhumb key first.");
  });

  it("names the models in use that retire above the roles, and counts them on their connection", async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const roles: RolesDocument = { workspaceDefault: null, activeTarget: { connectionId: "local", model: "a" }, resolved: [], roles: [] };
    const fake = owner({
      connections: [local],
      roles,
      lifecycle: { a: { status: "deprecated", retiresOn: soon, catalogVersion: "v", checkedAt: "2026-11-20T08:00:00.000Z" } },
      replacements: { "local/a": { provider: { model: "b" }, rhumb: [{ for: "agent", model: "c" }] } },
    });
    const host = await mountSettled(
      <InWorkspace client={fake.client} workspaceId="default">
        <ModelBrowser />
      </InWorkspace>,
    );
    const banner = host.querySelector('[aria-labelledby="lifecycle-banner-title"]');
    expect(banner?.textContent).toContain(`local/a retires on ${soon}`);
    // The provider's choice, then Rhumb's pick, each named as such.
    expect([...(banner?.querySelectorAll(".lifecycle-replacements li") ?? [])].map((item) => item.textContent)).toEqual([
      "Provider's choice: b",
      "Rhumb suggests c (with tools)",
    ]);

    // Replace lists every use first, and moves nothing before the yes.
    await click(byText("Replace with c (with tools)"));
    await settle();
    const dialog = document.querySelector(".modal");
    expect(dialog?.querySelector("h2")?.textContent).toBe("Replace a with c?");
    expect([...(dialog?.querySelectorAll(".replace-uses li") ?? [])].map((item) => item.textContent)).toEqual([
      "The main role",
      "2 chats that chose it",
    ]);
    expect(fake.writes.some((write) => write.payload["action"] === "replace")).toBe(false);
    expect(byText("Replace with b (provider's choice)")).toBeDefined();
    const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Replace");
    await click(confirm);
    await settle();
    expect(fake.writes.find((write) => write.payload["action"] === "replace")?.payload).toMatchObject({
      connectionId: "local",
      model: "a",
      replaceWith: { connectionId: "local", model: "c" },
      confirmed: true,
    });
    expect(host.textContent).toContain(
      "Replaced local/a with local/c in 1 place. Not done: 1 chat that chose it failed: database is locked.",
    );
    expect(host.querySelector(".connection-item")?.textContent).toContain("1 model retired, retiring or redirected");
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
