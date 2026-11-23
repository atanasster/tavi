import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/io.js";
import { EXIT, main } from "../../src/main.js";
import { appsOwnerCommand, pluginsCommand } from "../../src/server/config-commands.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * The owner serves a plugin's words already in the workspace's language: its
 * listing, its canvas contributions and its Connected apps entry, laid over from
 * its language pack. Without a language, or in English, the answer is what it was.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown("test done");
  directories.cleanup();
});
const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

function weather(): string {
  const source = directories.create("tavi-plugin-serving-src-");
  writeFileSync(
    join(source, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 3,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.weather",
      version: "1.0.0",
      name: "Weather",
      description: "Forecasts for your town.",
      config: { city: { type: "string", label: "City" } },
      apps: { abi: "tavi.apps/1", apps: [{ id: "acme-weather", name: "Weather", summary: "Forecasts" }] },
      ui: {
        abi: "tavi.ui/1",
        contributions: [{ id: "panel", title: "Forecast", document: "panel.html", placements: [{ slot: "chat.panel.tab" }] }],
      },
      locales: { bg: "locales/bg.json" },
    }),
  );
  writeFileSync(join(source, "panel.html"), "<!doctype html><p>weather</p>");
  mkdirSync(join(source, "locales"));
  writeFileSync(
    join(source, "locales", "bg.json"),
    JSON.stringify({
      manifest: {
        name: "Времето",
        description: "Прогнози за твоя град.",
        "config.city.label": "Град",
        "apps.apps.acme-weather.name": "Времето",
        "apps.apps.acme-weather.summary": "Прогнози",
        "ui.contributions.panel.title": "Прогноза",
      },
    }),
  );
  return source;
}

async function owner(): Promise<ServeHandle> {
  const directory = directories.create("tavi-plugin-serving-");
  for (const argv of [
    ["plugins", "install", weather()],
    ["plugins", "approve", "acme.weather", "1.0.0"],
    ["plugins", "enable", "acme.weather"],
  ])
    expect(await main([...argv, "--data-dir", directory], { io: quietIo })).toBe(EXIT.ok);
  const handle = await serve(
    fixtureServeOptions(directory, { defaultConnectionId: "conn", defaultModel: "model" }),
    {
      dataDirectory: directory,
      drainDeadlineMs: 5_000,
      modelTarget: { source: "default", connectionId: "conn", model: "model", workspaceId: "default" },
    },
    quietIo,
  );
  handles.push(handle);
  return handle;
}

type Listed = { readonly plugins: readonly { readonly id: string; readonly name: string; readonly description: string }[] };

describe("a plugin's words served in the workspace's language", () => {
  it("lists, frames and connects it in Bulgarian, and answers English byte for byte without a language", async () => {
    const { runtime } = await owner();
    const list = async (locale?: "bg") => await pluginsCommand(runtime, { action: "list" }, "operator", locale);
    const english = await list();
    const bulgarian = await list("bg");
    if (!english.ok || !bulgarian.ok) throw new Error("plugins list failed");
    const ofWeather = (answer: unknown) => (answer as Listed).plugins.find((plugin) => plugin.id === "acme.weather");
    expect(ofWeather(english.result)).toMatchObject({ name: "Weather", description: "Forecasts for your town." });
    expect(ofWeather(bulgarian.result)).toMatchObject({
      name: "Времето",
      description: "Прогнози за твоя град.",
      configFields: { city: { type: "string", label: "Град" } },
    });
    // English stays as it was: the same bytes as a listing asked for in no language.
    const again = await list();
    expect(again.ok && JSON.stringify(again.result)).toBe(JSON.stringify(english.result));

    const ui = await pluginsCommand(runtime, { action: "ui", pluginId: "acme.weather" }, "operator", "bg");
    expect(
      ui.ok && (ui.result as { entries: { ui: { contributions: { title: string }[] } }[] }).entries[0]?.ui.contributions[0]?.title,
    ).toBe("Прогноза");
    // Its frames are told the language (it has no messages of its own to give them).
    expect(ui.ok && (ui.result as { entries: { locale?: string; messages?: unknown }[] }).entries[0]).toMatchObject({ locale: "bg" });
    const englishUi = await pluginsCommand(runtime, { action: "ui", pluginId: "acme.weather" }, "operator");
    expect(englishUi.ok && (englishUi.result as { entries: object[] }).entries[0]).not.toHaveProperty("locale");

    const apps = async (locale?: "bg") =>
      await appsOwnerCommand(runtime, { action: "list", workspaceId: "default" }, "operator", locale === undefined ? {} : { locale });
    const appOf = (answer: Awaited<ReturnType<typeof apps>>) =>
      answer.ok
        ? (answer.result as { apps: { appId: string; name: string; summary: string }[] }).apps.find((app) => app.appId === "acme-weather")
        : undefined;
    expect(appOf(await apps())).toMatchObject({ name: "Weather", summary: "Forecasts" });
    expect(appOf(await apps("bg"))).toMatchObject({ name: "Времето", summary: "Прогнози" });
  }, 60_000);
});
