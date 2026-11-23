import { coreIn } from "@tavi/contracts/locales/core-server";
import { renderBriefHtml, type DailyBrief } from "@tavi/plugin-collectors";
import type { PluginView } from "@tavi/contracts";
import { delay } from "@tavi/test-support";
import { describe, expect, it, vi } from "vitest";

import { BUILTIN_CHANNELS, BUILTIN_PLUGINS, builtinChannelDescriptorIn, builtinViewIn } from "../../src/features/plugins/catalog.js";
import { workspaceLocales } from "../../src/features/plugins/localized.js";
import { BROWSER_VIEW_MANIFEST } from "@tavi/plugin-browser-view/manifest";
import { GUARD_PLUGIN_ID } from "@tavi/plugin-guard/manifest";

/** The built-in plugins' own words in Bulgarian, as the canvas's plugin list, channel setup and the daily brief show them. */

const bg = coreIn("bg");
const viewOf = (id: string, extra: Partial<PluginView> = {}): PluginView => {
  const plugin = BUILTIN_PLUGINS.find((candidate) => candidate.id === id)!;
  return {
    id,
    kind: "builtin",
    name: id,
    description: plugin.description,
    enabled: true,
    core: plugin.core,
    versions: [],
    tools: [],
    configFields: {},
    config: {},
    ...extra,
  } as PluginView;
};

describe("the built-in plugins in Bulgarian", () => {
  it("gives every built-in a description in Bulgarian, but the one whose words are its own manifest's", () => {
    const untranslated = BUILTIN_PLUGINS.filter((plugin) => builtinViewIn(viewOf(plugin.id), bg).description === plugin.description);
    expect(untranslated.map((plugin) => plugin.id)).toEqual([BROWSER_VIEW_MANIFEST.id]);
    expect(builtinViewIn(viewOf("tavi.telegram"), bg).description).toBe("Каналът Telegram: бот, на който пишеш, свързан с теб.");
  });

  it("discloses the guard's hook in Bulgarian", () => {
    const view = builtinViewIn(
      viewOf(GUARD_PLUGIN_ID, { mods: [{ event: "tool.check", onFailure: "deny", disclosure: "x", reads: "x" }] as never }),
      bg,
    );
    expect(view.mods?.[0]?.disclosure).toBe(
      "Пита преди команда в терминала, която изтрива или презаписва файлове, и казва какво ще засегне.",
    );
  });

  it("leaves an installed plugin's view to its own pack", () => {
    const external = { ...viewOf("tavi.telegram"), id: "acme.x", kind: "external" } as PluginView;
    expect(builtinViewIn(external, bg)).toBe(external);
  });

  it("gives each built-in channel its setup words in Bulgarian, and none to another provider", () => {
    for (const channel of BUILTIN_CHANNELS) {
      const shown = builtinChannelDescriptorIn(channel.descriptor.providerId, bg);
      expect(shown?.providerId).toBe(channel.descriptor.providerId);
      expect(shown?.description).not.toBe(channel.descriptor.description);
    }
    expect(builtinChannelDescriptorIn("discord", bg)).toBeUndefined();
  });

  it("writes the daily brief's own words in Bulgarian", async () => {
    const brief: DailyBrief = {
      generatedAt: "2026-09-16T07:00:00.000Z",
      period: { start: "2026-09-09", end: "2026-09-15" },
      projects: [{ id: "acme", name: "Acme", metrics: [], news: [], notes: [] }],
    };
    const html = await renderBriefHtml(brief, "bg");
    expect(html).toContain('<html lang="bg">');
    expect(html).toContain("<h1>Ежедневен бюлетин — всички проекти</h1>");
    expect(html).toContain("Период 2026-09-09 → 2026-09-15 · създаден 2026-09-16T07:00:00.000Z · 1 проект</div>");
    expect(html).toContain("За този проект не бяха събрани показатели.");
  });

  it("writes the daily brief's own words in English as it always has", async () => {
    const brief: DailyBrief = {
      generatedAt: "2026-09-16T07:00:00.000Z",
      period: { start: "2026-09-09", end: "2026-09-15" },
      projects: [
        {
          id: "acme",
          name: "Acme",
          metrics: [{ source: "stripe", key: "mrr", label: "MRR", value: 12, unit: "usd" }],
          news: [],
          notes: ["n"],
        },
        { id: "bare", name: "Bare", metrics: [], news: [], notes: [] },
      ],
    };
    const html = await renderBriefHtml(brief);
    for (const part of [
      '<html lang="en">',
      "<title>Daily brief</title>",
      "<h1>Daily brief — all projects</h1>",
      '<div class="meta">Period 2026-09-09 → 2026-09-15 · generated 2026-09-16T07:00:00.000Z · 2 project(s)</div>',
      "<th>Cross-project</th>",
      "<tr><th>Sessions</th>",
      "<tr><th>MRR</th>",
      "<tr><th>Paid revenue</th>",
      '<th>Metric</th><th>Source</th><th class="value">Value</th>',
      "<h3>News</h3>",
      `<p class="muted">No news items matched this project's keywords.</p>`,
      '<p class="muted">No metrics were collected for this project.</p>',
      "<strong>Data quality</strong>",
    ])
      expect(html).toContain(part);
    // One project reads "1 project(s)", as English always said it.
    expect(await renderBriefHtml({ ...brief, projects: [brief.projects[1]!] })).toContain("· 1 project(s)</div>");
  });
});

describe("each workspace's language, for a reader that cannot wait", () => {
  it("answers each workspace in its own language, follows a settings write, and stops when closed", async () => {
    const stored = new Map<string, "en" | "bg">([
      ["default", "en"],
      ["other", "bg"],
    ]);
    const settings = { get: async (workspaceId: string) => ({ settings: { locale: stored.get(workspaceId) } }) } as never;
    let listener: ((operation: string) => void) | undefined;
    let closed = false;
    const languages = await workspaceLocales(settings, "default", (heard) => {
      listener = heard;
      return () => {
        closed = true;
      };
    });
    expect(languages.of("default")).toBe("en");
    // Not read yet: the seed's, until its own lands.
    expect(languages.of("other")).toBe("en");
    await vi.waitFor(() => expect(languages.of("other")).toBe("bg"));
    stored.set("default", "bg");
    listener?.("repository.workspaceSettings.get");
    await delay(5);
    expect(languages.of("default")).toBe("en");
    listener?.("repository.workspaceSettings.put");
    await vi.waitFor(() => expect(languages.of("default")).toBe("bg"));
    expect(languages.of("other")).toBe("bg");
    languages.close();
    expect(closed).toBe(true);
  });

  it("answers a Bulgarian workspace's first call in Bulgarian, and a workspace saved later once it is saved", async () => {
    const stored = new Map<string, "en" | "bg">([
      ["default", "en"],
      ["team", "bg"],
    ]);
    const settings = {
      get: async (workspaceId: string) => ({ workspaceId, settings: { locale: stored.get(workspaceId) } }),
      list: async () => [...stored].map(([workspaceId, locale]) => ({ workspaceId, settings: { locale } })),
    } as never;
    let listener: ((operation: string) => void) | undefined;
    const languages = await workspaceLocales(settings, "default", (heard) => {
      listener = heard;
      return () => undefined;
    });
    // Listed up front: the flight card on the team's first call is Bulgarian, not the default's English.
    expect(languages.of("team")).toBe("bg");
    // Never saved: no language set, so English, whatever the default speaks.
    expect(languages.of("fresh")).toBe("en");
    stored.set("later", "bg");
    listener?.("repository.workspaceSettings.set");
    await vi.waitFor(() => expect(languages.of("later")).toBe("bg"));
    languages.close();
  });
});
