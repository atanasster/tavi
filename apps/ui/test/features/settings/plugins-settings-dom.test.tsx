// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { ClientResponse } from "@tavi/client/browser";
import type { PluginView } from "@tavi/contracts";

import type { SettingsClient } from "../../../src/lib/ipc.js";
import { PluginsSettings } from "../../../src/features/settings/PluginsSettings.js";
import { announced, freshAnnouncer } from "../../announced.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, click, mount, unmountAll } from "../../support/dom.js";

beforeEach(() => void freshAnnouncer());

/** The Plugins settings page: what each control asks the owner, and what it says back. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const byAria = (container: HTMLElement, label: string) => container.querySelector(`[aria-label="${label}"]`);

const base = { versions: [], tools: [], configFields: {}, config: {}, description: "" } as const;
const PLUGINS: PluginView[] = [
  {
    ...base,
    id: "tavi.persistence",
    kind: "builtin",
    runsOwnerCode: true,
    name: "tavi.persistence",
    enabled: true,
    core: true,
    phase: "ready",
  },
  {
    ...base,
    id: "tavi.schedules",
    kind: "builtin",
    runsOwnerCode: true,
    name: "tavi.schedules",
    enabled: true,
    core: false,
    phase: "ready",
  },
  {
    ...base,
    id: "tavi.router",
    kind: "builtin",
    runsOwnerCode: true,
    name: "tavi.router",
    description: "Jev (TypeSafe) routing provider.",
    enabled: true,
    core: false,
    phase: "ready",
  },
  {
    ...base,
    id: "acme.router",
    kind: "external",
    runsOwnerCode: true,
    name: "Acme router",
    enabled: false,
    core: false,
    versions: [
      {
        version: "1.0.0",
        reviewState: "proposed",
        contentHash: "b".repeat(64),
        installedAt: "2026-09-26T12:00:00.000Z",
        runsOwnerCode: true,
        tools: [],
        configFields: {},
        router: { features: ["tools"], batch: false, pricing: { connectionId: "plugin:acme.router", model: "acme-1" } },
      },
    ],
  },
  {
    ...base,
    id: "acme.weather",
    kind: "external",
    runsOwnerCode: true,
    name: "Weather",
    description: "Forecasts",
    enabled: false,
    // As the owner reports a plugin it has not loaded.
    phase: "not_composed",
    core: false,
    versions: [
      {
        version: "1.0.0",
        reviewState: "proposed",
        contentHash: "a".repeat(64),
        installedAt: "2026-09-26T12:00:00.000Z",
        runsOwnerCode: true,
        tools: [{ id: "acme.weather.forecast", effect: "external", description: "Get a forecast" }],
        configFields: { city: { type: "string", required: true } },
      },
    ],
    directory: "/data/plugins/acme.weather",
    tools: [{ id: "acme.weather.forecast", effect: "external", description: "Get a forecast" }],
    configFields: { city: { type: "string", required: true }, days: { type: "number" } },
    config: { days: 3 },
  },
];

function owner(answers: Partial<Record<string, ClientResponse>> = {}) {
  const sent: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      sent.push({ command, payload: payload as Record<string, unknown> });
      const action = (payload as { action: string }).action;
      if (action === "list") return { ok: true, result: { plugins: PLUGINS } } as ClientResponse;
      return (
        answers[action] ??
        ({
          ok: true,
          result: {
            result: { pluginId: "acme.weather", version: "1.0.0", created: true },
            restartRequired: action === "enable" || action === "disable",
          },
        } as ClientResponse)
      );
    },
  };
  return { client, sent };
}

describe("Plugins settings", () => {
  it("lists installed and built-in plugins, and offers no disable for a core one", async () => {
    const { client } = owner();
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    expect(view.querySelector("h1")?.textContent).toBe("Plugins");
    expect(view.textContent).toContain("Weather");
    expect(view.textContent).toContain("acme.weather.forecast (external)");
    expect(byAria(view, "Disable tavi.persistence")).toBeNull();
    // Core built-ins are folded under their own summary; the optional ones lead.
    expect(view.querySelector(".plugins-core summary")?.textContent).toBe("Core (always on) · 1");
    expect(view.querySelector(".plugins-core #plugin-row-tavi\\.persistence")).not.toBeNull();
    expect(view.querySelector(".plugins-core #plugin-row-tavi\\.schedules")).toBeNull();
    // All core plugins ready: the fold starts closed.
    expect(view.querySelector<HTMLDetailsElement>(".plugins-core")?.open).toBe(false);
    expect(byAria(view, "Disable tavi.schedules")).not.toBeNull();
    // The Jev router is an optional built-in: it can be switched off from here.
    expect(byAria(view, "Disable tavi.router")).not.toBeNull();
    // A routing provider's review says what it would receive, how it is priced and that it is shared.
    expect(view.textContent).toContain(
      "1.0.0 awaits review. It declares no tools. Routing provider: receives task text and tool descriptions when router egress allows it. One call per feature, priced as plugin:acme.router / acme-1.",
    );
    // The review shows what the proposed version itself declares, and where to read it.
    expect(view.textContent).toContain("1.0.0 awaits review. It declares acme.weather.forecast (external), settings city.");
    expect(view.textContent).toContain("/data/plugins/acme.weather/1.0.0");
    // An external plugin with no approved version cannot be enabled yet.
    expect((byAria(view, "Enable acme.weather") as HTMLButtonElement).disabled).toBe(true);
    // It says one thing about where it stands: it awaits review, not "disabled" and "not composed".
    const badges = [...(view.querySelector("#plugin-row-acme\\.weather")?.querySelectorAll(".badge") ?? [])].map(
      (badge) => badge.textContent,
    );
    expect(badges).toContain("awaits review");
    expect(badges).not.toContain("disabled");
    expect(badges).not.toContain("not composed");
  });

  it("says an enabled plugin not loaded yet loads at next start, and nothing more of an approved, disabled one", async () => {
    const weather = PLUGINS.find((plugin) => plugin.id === "acme.weather")!;
    const approved = weather.versions.map((version) => ({ ...version, reviewState: "approved" as const }));
    const badgesOf = async (plugin: PluginView) => {
      const client: SettingsClient = {
        request: async () => ({ ok: true, result: { plugins: [plugin] } }) as ClientResponse,
      };
      const view = await mount(
        <InWorkspace client={client}>
          <PluginsSettings />
        </InWorkspace>,
      );
      return [...(view.querySelector("#plugin-row-acme\\.weather")?.querySelectorAll(".badge") ?? [])].map((badge) => badge.textContent);
    };
    const enabled = await badgesOf({ ...weather, enabled: true, versions: approved, activeVersion: "1.0.0" });
    expect(enabled).toContain("loads at next start");
    expect(enabled).not.toContain("awaits review");
    const disabled = await badgesOf({ ...weather, enabled: false, versions: approved, activeVersion: "1.0.0" });
    expect(disabled).toContain("disabled");
    expect(disabled).not.toContain("loads at next start");
    expect(disabled).not.toContain("awaits review");
  });

  it("gives a plugin that only adds to the canvas no restart badge, and says its declaration once, with one full stop", async () => {
    const ui: NonNullable<PluginView["ui"]> = {
      abi: "tavi.ui/1",
      contributions: [
        {
          id: "live",
          title: "Browser",
          document: "index.html",
          role: "browser-view",
          placements: [{ slot: "chat.panel.top" }],
          channels: ["browser.live"],
          disclosure: "Receives live images of each page.",
        },
      ],
    };
    const view = {
      ...base,
      id: "my.browserview",
      kind: "external" as const,
      name: "My browser view",
      core: false,
      ui,
      uiOnly: true as const,
    };
    const proposed = {
      version: "1.0.0",
      reviewState: "proposed" as const,
      contentHash: "c".repeat(64),
      installedAt: "2026-09-26T12:00:00.000Z",
      runsOwnerCode: false,
      tools: [],
      configFields: {},
      ui,
    };
    const builtin = {
      ...base,
      id: "tavi.browserview",
      kind: "builtin" as const,
      name: "tavi.browserview",
      core: false,
      enabled: true,
      ui,
      uiOnly: true as const,
    };
    const mountWith = async (plugins: PluginView[]) => {
      unmountAll();
      const client: SettingsClient = { request: async () => ({ ok: true, result: { plugins } }) as ClientResponse };
      return await mount(
        <InWorkspace client={client}>
          <PluginsSettings />
        </InWorkspace>,
      );
    };
    const waiting = await mountWith([{ ...view, runsOwnerCode: false, enabled: false, versions: [proposed] }]);
    const row = waiting.querySelector("#plugin-row-my\\.browserview")?.textContent ?? "";
    expect(row).toContain("Canvas live (role browser-view) → chat.panel.top; receives browser.live — Receives live images of each page.");
    expect(row).not.toContain("..");
    expect(row.split("Receives live images").length - 1).toBe(1);
    const on = await mountWith([
      {
        ...view,
        runsOwnerCode: false,
        enabled: true,
        activeVersion: "1.0.0",
        phase: "not_composed",
        versions: [{ ...proposed, reviewState: "approved" }],
      },
      { ...builtin, runsOwnerCode: false, phase: "not_composed" },
    ]);
    expect(on.textContent).not.toContain("loads at next start");
  });

  it("opens the core fold while a core plugin is not ready, so its state is not hidden", async () => {
    const failing = PLUGINS.map((plugin) => (plugin.core ? { ...plugin, phase: "failed" as const } : plugin));
    const client: SettingsClient = {
      request: async () => ({ ok: true, result: { plugins: failing } }) as ClientResponse,
    };
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    expect(view.querySelector<HTMLDetailsElement>(".plugins-core")?.open).toBe(true);
  });

  it("names each Approve button with its visible words first, so saying them reaches it", async () => {
    const { client } = owner();
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    const approves = [...view.querySelectorAll<HTMLButtonElement>("button")].filter((each) => each.textContent?.startsWith("Approve"));
    expect(approves.length).toBeGreaterThan(0);
    for (const each of approves) expect(each.getAttribute("aria-label")?.startsWith(each.textContent!.replace(/…$/, ""))).toBe(true);
  });

  it("approves a proposed version and says when a change waits for a restart", async () => {
    const { client, sent } = owner();
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    await click(byAria(view, "Approve 1.0.0 of acme.weather"));
    expect(sent.at(-2)).toEqual({ command: "plugins", payload: { action: "approve", pluginId: "acme.weather", version: "1.0.0" } });
    expect(announced()).toBe("acme.weather@1.0.0 approved.");
    await click(byAria(view, "Disable tavi.schedules"));
    expect(sent.at(-2)).toEqual({ command: "plugins", payload: { action: "disable", pluginId: "tavi.schedules" } });
    expect(announced()).toContain("Restart the owner (tavi serve)");
  });

  it("takes a plugin's status lines off the chats once the owner disabled it, and not for a rejected proposal, which never ran", async () => {
    const off: string[] = [];
    const { client } = owner({ approve: { ok: false, error: { code: "CONFLICT", message: "no" } } as ClientResponse });
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings onPluginOff={(pluginId) => off.push(pluginId)} />
      </InWorkspace>,
    );
    await click(byAria(view, "Approve 1.0.0 of acme.weather"));
    await click(byAria(view, "Reject acme.router 1.0.0"));
    await click(byAria(view, "Disable tavi.schedules"));
    expect(off).toEqual(["tavi.schedules"]);
    const refused = owner({ disable: { ok: false, error: { code: "CONFLICT", message: "busy" } } as ClientResponse });
    unmountAll();
    const again = await mount(
      <InWorkspace client={refused.client}>
        <PluginsSettings onPluginOff={(pluginId) => off.push(pluginId)} />
      </InWorkspace>,
    );
    await click(byAria(again, "Disable tavi.schedules"));
    expect(off).toEqual(["tavi.schedules"]);
  });

  it("says a routing provider's routing stopped at once when it is disabled", async () => {
    const { client } = owner({
      disable: {
        ok: true,
        result: { result: { pluginId: "tavi.router", enabled: false }, restartRequired: true, routingStopped: true },
      } as ClientResponse,
    });
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    await click(byAria(view, "Disable tavi.router"));
    expect(announced()).toContain("Its routing stopped now; restart the owner (tavi serve) to unload its code.");
  });

  it("installs from an absolute path and edits settings, sending only what changed", async () => {
    const { client, sent } = owner();
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    await click(button(view, "Install plugin"));
    const path = document.querySelector<HTMLInputElement>("dialog input")!;
    await type(path, "relative/dir");
    await click(button(document.body, "Install"));
    expect(document.body.textContent).toContain("Use an absolute path");
    await type(path, "/opt/plugins/weather");
    await click(button(document.body, "Install"));
    expect(sent.find((entry) => entry.payload["action"] === "install")?.payload).toEqual({
      action: "install",
      path: "/opt/plugins/weather",
    });
    expect(announced()).toContain("acme.weather@1.0.0 installed");

    await click(byAria(view, "Settings for acme.weather"));
    const inputs = [...document.querySelectorAll<HTMLInputElement>("dialog input")];
    await type(inputs[0]!, "Sofia");
    await type(inputs[1]!, "");
    await click(button(document.body, "Save"));
    expect(sent.find((entry) => entry.payload["action"] === "config")?.payload).toEqual({
      action: "config",
      pluginId: "acme.weather",
      set: { city: "Sofia" },
      unset: ["days"],
    });
  });

  it("shows a running plugin's commands, and its hook activity from `show` once opened", async () => {
    const tally: PluginView = {
      ...base,
      id: "acme.tally",
      kind: "external",
      runsOwnerCode: true,
      name: "Tally",
      enabled: true,
      core: false,
      mods: [
        {
          event: "tool.check",
          onFailure: "ask",
          disclosure: "Counts tool calls.",
          reads: "Sees the input of `fs.write`, and can refuse the call.",
        },
        { event: "prompt.submit", onFailure: "skip", disclosure: "Adds the tally.", reads: "Every prompt.", contextTrusted: true },
      ],
      commands: [{ name: "tally", description: "Counts the tool calls." }],
    };
    const quiet: PluginView = {
      ...base,
      id: "acme.quiet",
      kind: "external",
      runsOwnerCode: true,
      name: "Quiet",
      enabled: true,
      core: false,
      commands: [{ name: "hush", description: "Says nothing." }],
    };
    const sent: Record<string, unknown>[] = [];
    const client: SettingsClient = {
      request: async (_command, payload) => {
        const data = payload as Record<string, unknown>;
        sent.push(data);
        if (data["action"] === "list") return { ok: true, result: { plugins: [tally, quiet] } } as ClientResponse;
        const activity = {
          decisions: 2,
          failures: 1,
          pruned: true,
          recent: [
            {
              pluginId: "acme.tally",
              kind: "failure",
              event: "tool.check",
              tool: "fs.write",
              detail: "timeout: 1000 ms",
              at: "2026-10-01T12:00:00.000Z",
            },
          ],
        };
        const hookLatency = [
          { event: "tool.check", medianMs: 3, worstMs: 41, samples: 20 },
          { event: "prompt.submit", medianMs: 5, worstMs: 5, samples: 1 },
        ];
        return {
          ok: true,
          result: { plugin: data["pluginId"] === "acme.tally" ? { ...tally, hookActivity: activity, hookLatency } : quiet },
        } as ClientResponse;
      },
    };
    const view = await mount(
      <InWorkspace client={client} timeZone="Europe/Sofia">
        <PluginsSettings />
      </InWorkspace>,
    );
    expect(view.textContent).toContain("Command /tally: Counts the tool calls.");
    // A tool the hook reads is code, not backticks.
    expect(view.textContent).toContain("Sees the input of fs.write, and can refuse the call.");
    expect(view.querySelector("#plugin-row-acme\\.tally code")?.textContent).toBe("fs.write");
    // A prompt.submit hook whose manifest declares its context trusted says so; the other hook does not.
    expect(view.textContent).toContain("Hook prompt.submit (trusted context) (fails: skip)");
    expect(view.textContent).toContain("Hook tool.check (fails: ask)");
    // Nothing is read until the activity is opened.
    expect(sent.some((item) => item["action"] === "show")).toBe(false);
    const toggle = byAria(view, "Hook activity for acme.tally");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(sent.at(-1)).toEqual({ action: "show", pluginId: "acme.tally" });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(view.textContent).toContain(
      "Hook activity: 2 decisions, 1 failure. Older rows were pruned: only the newest 10000 decisions and 500 failures are kept, and counted.",
    );
    // Each event's own hook time, as `tavi plugins show` says it.
    expect(byAria(view, "Hook time for acme.tally")?.textContent).toBe(
      "tool.check: median 3 ms, worst 41 ms over its last 20 callsprompt.submit: median 5 ms, worst 5 ms over its last call",
    );
    // When, in the workspace's own zone, not an ISO timestamp.
    const rows = byAria(view, "Recent hook activity for acme.tally");
    expect(rows?.textContent).toBe("Thu 1 Oct 15:00 failure tool.check fs.write: timeout: 1000 ms");
    // A plugin with no activity shows nothing more.
    const before = view.textContent;
    await click(byAria(view, "Hook activity for acme.quiet"));
    expect(sent.at(-1)).toEqual({ action: "show", pluginId: "acme.quiet" });
    expect(view.textContent).toBe(before);
    // Closed, it is gone.
    await click(toggle);
    expect(view.textContent).not.toContain("Hook activity: 2 decisions");
  });

  it("shows a tool's trusted output on the plugin and on a version awaiting review; the untrusted default says nothing", async () => {
    const lookup: PluginView = {
      ...base,
      id: "acme.lookup",
      kind: "external",
      runsOwnerCode: true,
      name: "Lookup",
      enabled: true,
      core: false,
      activeVersion: "1.0.0",
      tools: [
        { id: "acme.lookup.order", effect: "read-only", description: "Look up an order", output: "trusted" },
        { id: "acme.lookup.own", effect: "read-only", description: "Its own data", output: "trusted" },
      ],
      versions: [
        {
          version: "1.0.0",
          reviewState: "approved",
          contentHash: "c".repeat(64),
          installedAt: "2026-09-26T12:00:00.000Z",
          runsOwnerCode: true,
          configFields: {},
          tools: [
            { id: "acme.lookup.order", effect: "read-only", description: "Look up an order", output: "trusted" },
            { id: "acme.lookup.own", effect: "read-only", description: "Its own data", output: "trusted" },
          ],
        },
        {
          version: "1.1.0",
          reviewState: "proposed",
          contentHash: "d".repeat(64),
          installedAt: "2026-10-14T12:00:00.000Z",
          runsOwnerCode: true,
          configFields: {},
          tools: [
            { id: "acme.lookup.order", effect: "read-only", description: "Look up an order" },
            { id: "acme.lookup.own", effect: "read-only", description: "Its own data", output: "trusted" },
          ],
        },
      ],
    };
    const client: SettingsClient = { request: async () => ({ ok: true, result: { plugins: [lookup] } }) as ClientResponse };
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    expect(view.textContent).toContain("Tools: acme.lookup.order (read-only, trusted output), acme.lookup.own (read-only, trusted output)");
    expect(view.textContent).toContain(
      "1.1.0 awaits review. It declares acme.lookup.order (read-only), acme.lookup.own (read-only, trusted output)",
    );
  });

  it("shows a version's apps block as its author's words, never as Tavi's", async () => {
    const notes: PluginView = {
      ...base,
      id: "acme.notes",
      kind: "external",
      runsOwnerCode: true,
      name: "Notes",
      enabled: false,
      core: false,
      versions: [
        {
          version: "1.0.0",
          reviewState: "proposed",
          contentHash: "f".repeat(64),
          installedAt: "2026-10-16T12:00:00.000Z",
          runsOwnerCode: true,
          configFields: {},
          tools: [],
          apps: {
            abi: "tavi.apps/1",
            apps: [
              {
                id: "acme-notes",
                name: "Notes",
                summary: "Keeps your notes safe",
                category: "notes",
                scopes: [{ scope: "notes.read", says: "Reads every note", access: "read", optional: false }],
                tools: { find: { title: "Find a note", says: "Searches all notes" } },
                dataClass: "personal",
                accountScope: "owner",
              },
            ],
          },
        },
      ],
    };
    const client: SettingsClient = { request: async () => ({ ok: true, result: { plugins: [notes] } }) as ClientResponse };
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    const line = view.querySelector('[data-source="author"]');
    expect(line?.textContent).toBe(
      ` App acme-notes (notes, personal data), in its author's words: name "Notes"; summary "Keeps your notes safe"; scope notes.read (read) "Reads every note"; tool find "Find a note" "Searches all notes".`,
    );
  });

  it("shows where each version would run, and approves one that cannot be a worker only in-process, after a confirmation", async () => {
    const proposed = {
      reviewState: "proposed",
      contentHash: "e".repeat(64),
      installedAt: "2026-10-14T12:00:00.000Z",
      runsOwnerCode: true,
      configFields: {},
      tools: [],
    } as const;
    const chat: PluginView = {
      ...base,
      id: "acme.chat",
      kind: "external",
      runsOwnerCode: true,
      name: "Chat",
      enabled: true,
      core: false,
      activeVersion: "1.0.0",
      isolation: "in-process",
      versions: [
        {
          ...proposed,
          version: "1.0.0",
          reviewState: "approved",
          isolation: "in-process",
          workerRefusal: "it supplies messaging channels, which the owner uses as live objects a worker cannot hand over",
        },
        {
          ...proposed,
          version: "1.1.0",
          workerRefusal: "it supplies messaging channels, which the owner uses as live objects a worker cannot hand over",
        },
      ],
    };
    const tool: PluginView = {
      ...base,
      id: "acme.tool",
      kind: "external",
      runsOwnerCode: true,
      name: "Tool",
      enabled: true,
      core: false,
      activeVersion: "1.0.0",
      isolation: "process",
      versions: [
        { ...proposed, version: "1.0.0", reviewState: "approved", isolation: "process" },
        { ...proposed, version: "2.0.0", networkDomains: ["api.acme.test"], rawSecrets: ["token"] },
      ],
    };
    const sent: Record<string, unknown>[] = [];
    const client: SettingsClient = {
      request: async (_command, payload) => {
        const data = payload as Record<string, unknown>;
        sent.push(data);
        return {
          ok: true,
          result:
            data["action"] === "list"
              ? { plugins: [chat, tool] }
              : {
                  result: { pluginId: data["pluginId"], version: data["version"], reviewState: "approved", isolation: "in-process" },
                  restartRequired: false,
                },
        } as ClientResponse;
      },
    };
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    // Tagged as `tavi plugins list` tags them.
    expect([...view.querySelectorAll("#plugin-row-acme\\.chat .badge")].map((badge) => badge.textContent)).toContain("UNSANDBOXED");
    expect([...view.querySelectorAll("#plugin-row-acme\\.tool .badge")].map((badge) => badge.textContent)).toContain("worker");
    // The review says where it would run, what it reaches and what it holds raw.
    expect(view.textContent).toContain(
      "It cannot run as a confined worker: it supplies messaging channels, which the owner uses as live objects a worker cannot hand over. Approving it runs it UNSANDBOXED in the owner's process, with its privileges.",
    );
    expect(view.textContent).toContain(
      "Approved, it runs as a confined worker, reaching only api.acme.test. It holds the real values of token (raw secrets), not placeholders.",
    );
    // A refused worker offers no plain approval, which the owner would refuse.
    expect(byAria(view, "Approve 1.1.0 of acme.chat")).toBeNull();
    await click(byAria(view, "Approve 1.1.0 in-process: acme.chat"));
    expect(document.querySelector("dialog")?.textContent).toContain("its code runs in the owner's process with the owner's privileges");
    expect(sent.some((item) => item["action"] === "approve")).toBe(false);
    await click(button(document.body, "Approve in-process (unsandboxed)"));
    expect(sent.find((item) => item["action"] === "approve")).toEqual({
      action: "approve",
      pluginId: "acme.chat",
      version: "1.1.0",
      inProcess: true,
    });
    expect(announced()).toBe("acme.chat@1.1.0 approved, to run UNSANDBOXED in the owner's process.");
    expect(document.querySelector("dialog")).toBeNull();
    // One that can be a worker is approved as one, or in-process by choice.
    await click(byAria(view, "Approve 2.0.0 of acme.tool"));
    expect(sent.filter((item) => item["action"] === "approve").at(-1)).toEqual({
      action: "approve",
      pluginId: "acme.tool",
      version: "2.0.0",
    });
    await click(byAria(view, "Approve in-process: acme.tool 2.0.0"));
    expect(document.querySelector("dialog")?.textContent).toContain("It could run as a confined worker.");
  });

  it("shows the owner's refusal in words", async () => {
    const { client } = owner({
      approve: { ok: false, error: { code: "CONFLICT", message: "plugin acme.weather@1.0.0 was already rejected" } } as ClientResponse,
    });
    const view = await mount(
      <InWorkspace client={client}>
        <PluginsSettings />
      </InWorkspace>,
    );
    await click(byAria(view, "Approve 1.0.0 of acme.weather"));
    expect(view.textContent).toContain("was already rejected");
  });
});

it("edits provider-only instances and sends validated credential references through IPC", async () => {
  const provider: PluginView = {
    ...base,
    id: "acme.models",
    kind: "external",
    runsOwnerCode: true,
    name: "Acme Models",
    enabled: true,
    core: false,
    versions: [
      {
        version: "0.1.0",
        reviewState: "approved",
        contentHash: "a".repeat(64),
        installedAt: "2026-09-28T00:00:00.000Z",
        runsOwnerCode: true,
        tools: [],
        configFields: {},
        capabilities: [
          {
            id: "model",
            kind: "model",
            settings: { model: { type: "string", required: true, description: "Model" } },
            credentials: ["apiKey"],
            disclosure: "Sends model history",
          },
        ],
      },
    ],
  };
  const sent: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const data = payload as Record<string, unknown>;
      sent.push(data);
      return {
        ok: true,
        result: data["action"] === "list" ? { plugins: [provider] } : { result: {}, restartRequired: true },
      } as ClientResponse;
    },
  };
  const view = await mount(
    <InWorkspace client={client}>
      <PluginsSettings />
    </InWorkspace>,
  );
  await click(byAria(view, "Settings for acme.models"));
  await click(button(document.body, "Add provider instance"));
  const input = (label: string) => {
    const found = byAria(document.body, label);
    if (!(found instanceof HTMLInputElement)) throw new Error(label);
    return found;
  };
  await type(input("Instance 1 ID"), "home");
  await type(input("Instance 1 account"), "home");
  await type(input("Instance 1 model"), "model-one");
  await type(input("Instance 1 apiKey reference"), "wrong.namespace");
  await click(button(document.body, "Save"));
  expect(document.body.textContent).toContain("must use its instance namespace");
  expect(sent.some((item) => item["action"] === "config")).toBe(false);
  await type(input("Instance 1 apiKey reference"), "plugins.acme.models.home.key");
  await click(button(document.body, "Save"));
  expect(sent.find((item) => item["action"] === "config")).toEqual({
    action: "config",
    pluginId: "acme.models",
    set: {},
    unset: [],
    instances: [
      {
        id: "home",
        factory: "model",
        workspaceId: "default",
        accountId: "home",
        settings: { model: "model-one" },
        credentials: { apiKey: "plugins.acme.models.home.key" },
      },
    ],
  });
  expect(view.textContent).toContain("Restart the owner");
});

it("names a plugin's settings by their labels, each with one hint under its own field, and marks a row's state as a state", async () => {
  const places: PluginView = {
    ...base,
    id: "places.open",
    kind: "external",
    runsOwnerCode: true,
    name: "Places",
    description: "Configured with `tavi places`.",
    enabled: true,
    core: false,
    phase: "stopped",
    activeVersion: "0.1.0",
    configFields: {
      contact: { type: "string", label: "Contact", description: "An email or URL OpenStreetMap can reach you at." },
      afdcKey: { type: "credential", description: "Your free api.data.gov key." },
    },
  };
  const client: SettingsClient = {
    request: async (_command, payload) =>
      (payload as { action: string }).action === "list"
        ? ({ ok: true, result: { plugins: [places] } } as ClientResponse)
        : ({ ok: true, result: {} } as ClientResponse),
  };
  const view = await mount(
    <InWorkspace client={client}>
      <PluginsSettings />
    </InWorkspace>,
  );
  const row = view.querySelector("#plugin-row-places\\.open")!;
  // Backticks in a description are code, not literal marks; its phase is a toned state; Remove says why it is off.
  expect(row.querySelector(".settings-description code")?.textContent).toBe("tavi places");
  expect(row.textContent).not.toContain("`");
  expect(row.querySelector(".badge.badge-muted")?.textContent).toBe("stopped");
  expect(byAria(view, "Remove places.open")?.getAttribute("title")).toBe("Disable it first to remove it");

  await click(byAria(view, "Settings for places.open"));
  const dialog = document.querySelector("dialog")!;
  const labels = [...dialog.querySelectorAll("label")].map((label) => label.textContent);
  expect(labels).toEqual(["Contact", "afdcKey"]);
  const hintOf = (label: string) => {
    const input = dialog.querySelector<HTMLInputElement>(
      `#${[...dialog.querySelectorAll("label")].find((l) => l.textContent === label)!.htmlFor}`,
    )!;
    return document.getElementById(input.getAttribute("aria-describedby")!)?.textContent;
  };
  expect(hintOf("Contact")).toBe("An email or URL OpenStreetMap can reach you at.");
  expect(hintOf("afdcKey")).toBe(
    "Your free api.data.gov key. A credential reference, never the secret: store the value under it in the Credentials view.",
  );
});
