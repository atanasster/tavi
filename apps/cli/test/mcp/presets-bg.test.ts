import type { PluginManifest, PluginView } from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import { clientSetupOf } from "../../src/features/apps/client-setup.js";
import { mcpApps } from "../../src/features/apps/sources/mcp.js";
import { AVAILABLE_PRESETS, presetOf } from "../../src/features/mcp/presets/index.js";

/**
 * MCP presets and Tavi's client-setup steps in a Bulgarian workspace: what a person reads in Discover and on each
 * preset's page (summary, tools, settings, key steps) is Bulgarian; the reviewed template a manifest is written from,
 * and what the model reads, stay as they are.
 */

const bg = coreIn("bg");
const CYRILLIC = /\p{Script=Cyrillic}/u;

describe("MCP presets in Bulgarian", () => {
  it("says every preset's summary, description and tools in Bulgarian, keeping its template", () => {
    for (const id of AVAILABLE_PRESETS) {
      const english = presetOf(id);
      const said = presetOf(id, bg);
      expect(said, id).toBeDefined();
      expect(said?.app?.summary, id).toMatch(CYRILLIC);
      expect(said?.description, id).toMatch(CYRILLIC);
      for (const [name, tool] of Object.entries(said?.app?.tools ?? {})) {
        expect(tool.title, `${id} ${name}`).toMatch(CYRILLIC);
        if (tool.says !== undefined) expect(tool.says, `${id} ${name}`).toMatch(CYRILLIC);
      }
      for (const [key, field] of Object.entries(said?.config ?? {})) {
        expect(field.label, `${id} ${key}`).toMatch(CYRILLIC);
        expect(field.description, `${id} ${key}`).toMatch(CYRILLIC);
      }
      for (const step of said?.keySteps ?? []) {
        expect(step.text, id).toMatch(CYRILLIC);
        expect(step.link?.label, id).toMatch(CYRILLIC);
      }
      // The server itself is the reviewed one: its address, sign-in, floors and ids are the same in every language.
      expect(said?.block).toEqual(english?.block);
      expect(said?.app?.id).toBe(english?.app?.id);
      expect(Object.keys(said?.app?.tools ?? {})).toEqual(Object.keys(english?.app?.tools ?? {}));
      expect(said?.withdrawnIf).toBe(english?.withdrawnIf);
    }
  });

  it("speaks as a person would", () => {
    expect(presetOf("todoist", bg)?.app?.tools["delete-object"]).toEqual({
      title: "Изтрий",
      says: "Изтрива завинаги задача, проект, раздел или коментар",
    });
    expect(presetOf("todoist-token", bg)?.app?.name).toBe("Todoist (API токен)");
    expect(presetOf("linear", bg)?.description).toBe(
      "Акаунтът ти в Linear през официалния хостван MCP сървър на Linear: един вход, без собствен клиент.",
    );
    expect(presetOf("google-maps", bg)?.keySteps?.map((step) => step.link?.label)).toEqual(["Вземи Demo Key", "Включи API", "Създай ключ"]);
    // A number and its unit stay on one line.
    expect(presetOf("google-maps", bg)?.app?.summary).toContain("30 дни");
  });

  it("is the English template without a language, or with English", () => {
    expect(presetOf("todoist", coreEnglish)).toBe(presetOf("todoist"));
    expect(presetOf("todoist")?.app?.summary).toBe("Add, find, change and complete your Todoist tasks, asking before anything is deleted.");
    expect(presetOf(undefined, bg)).toBeUndefined();
  });
});

describe("Tavi's steps for Google's shared client in Bulgarian", () => {
  it("says each step, link and field in Bulgarian, and keeps the values to type and the console's pages", () => {
    const english = clientSetupOf("google");
    const said = clientSetupOf("google", bg);
    expect(said?.title).toBe("Настрой Google");
    expect(said?.steps).toHaveLength(english?.steps.length ?? 0);
    for (const [index, step] of (said?.steps ?? []).entries()) {
      expect(step.text).toMatch(CYRILLIC);
      if (step.link !== undefined) expect(step.link.label).toMatch(CYRILLIC);
      expect(step.link?.url).toBe(english?.steps[index]?.link?.url);
      expect(step.values?.map((value) => value.value)).toEqual(english?.steps[index]?.values?.map((value) => value.value));
    }
    expect(said?.steps[2]?.values).toEqual([{ label: "Име на приложението", value: "Tavi (personal)" }]);
    expect(clientSetupOf("toString", bg)).toBeUndefined();
  });
});

describe("a preset server's page in a Bulgarian workspace", () => {
  const google = presetOf("google-maps");
  const manifest = {
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "mcp-remote", packages: [] },
    capabilities: [],
    id: "mcp.gmaps",
    version: "1.0.0",
    name: "Google Maps",
    description: google?.description,
    config: google?.config,
    tools: [],
    provides: [],
    channels: [],
    mcp: {
      abi: "tavi.mcp/1",
      transport: "http",
      url: { value: "https://mapstools.googleapis.com/mcp" },
      headers: { "X-Goog-Api-Key": { setting: "apiKey" } },
      auth: "headers",
      exposure: "auto",
      preset: "google-maps",
      maxMessageBytes: 1_048_576,
      concurrency: 4,
    },
  } as unknown as PluginManifest;
  const view = {
    id: "mcp.gmaps",
    kind: "mcp",
    name: "Google Maps",
    description: "",
    enabled: true,
    core: false,
    activeVersion: "1.0.0",
    versions: [
      {
        version: "1.0.0",
        reviewState: "approved",
        contentHash: "h",
        installedAt: "2026-11-20T00:00:00.000Z",
        tools: [],
        configFields: google?.config,
        runsOwnerCode: false,
      },
    ],
    tools: [],
    configFields: google?.config,
    config: {},
    runsOwnerCode: false,
  } as unknown as PluginView;
  const project = (t?: typeof bg) =>
    mcpApps({
      views: [view],
      rows: new Map(),
      reviews: new Map(),
      manifestOf: () => manifest,
      rules: [],
      settings: {},
      workspaceId: "default",
      sharing: {},
      credentialRefs: new Set(),
      ...(t === undefined ? {} : { t }),
    })[0];

  it("shows its summary, key field and key steps in Bulgarian, over the English its manifest was written with", () => {
    const app = project(bg);
    expect(app?.summary).toBe(presetOf("google-maps", bg)?.app?.summary);
    expect(app?.settings).toMatchObject([
      {
        key: "apiKey",
        label: "API ключът ти за Maps",
        help: "API ключ за Google Maps Platform с включен Maps Grounding Lite API; ограничи го само до този API",
      },
    ]);
    expect(app?.auth).toMatchObject({ kind: "api-key", fields: [{ key: "apiKey", label: "API ключът ти за Maps" }] });
    const steps = app?.auth.kind === "api-key" ? (app.auth.keySteps ?? []) : [];
    expect(steps[0]?.link?.label).toBe("Вземи Demo Key");
  });

  it("is unchanged in English", () => {
    const app = project();
    expect(app?.summary).toBe(google?.app?.summary);
    expect(app?.settings).toMatchObject([{ key: "apiKey", label: "Your Maps API key" }]);
    expect(project(coreEnglish)).toEqual(app);
  });
});
