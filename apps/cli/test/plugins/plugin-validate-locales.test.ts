import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { renderPluginValidation, validatePlugin } from "../../src/features/plugins/validate.js";
import { pluginLocaleReportOnDisk } from "../../src/features/plugins/validate-locales.js";
import { capture } from "../support/attached-owner.js";
import { directSandbox as direct } from "../support/direct-sandbox.js";

/** `tavi plugins validate` on a plugin's language packs: every pack's problems as install finds them, and what each translates. */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dirs = temporaryDirectories();
afterEach(() => dirs.cleanup());

/** A schemaVersion 3 plugin with a tool, a setting and a channel-free manifest, its `packs` written under `locales/`. */
function plugin(
  packs: Record<string, unknown>,
  code = "export function register({ registerTool, z }) { registerTool({ name: 'go', inputSchema: z.object({}), handler: () => null }); }",
): string {
  const path = dirs.create("tavi-validate-locales-");
  writeFileSync(join(path, "index.mjs"), code);
  mkdirSync(join(path, "locales"));
  for (const [locale, pack] of Object.entries(packs))
    writeFileSync(join(path, "locales", `${locale}.json`), typeof pack === "string" ? pack : JSON.stringify(pack));
  writeFileSync(
    join(path, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 3,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.packs",
      version: "1.0.0",
      name: "Packs",
      description: "Says things in two languages.",
      entry: "index.mjs",
      tools: [{ name: "go", effect: "read-only", description: "Go somewhere" }],
      config: { city: { type: "string", label: "City", description: "Where you live" }, units: { type: "string" } },
      locales: Object.fromEntries(Object.keys(packs).map((locale) => [locale, `locales/${locale}.json`])),
    }),
  );
  return path;
}

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

describe("tavi plugins validate: language packs", () => {
  it("counts the manifest fields and messages each pack translates, and names what it leaves to English", async () => {
    const path = plugin({
      en: { messages: { greeting: "Hello, {name}", things: { one: "{count} thing", other: "{count} things" } } },
      bg: { manifest: { name: "Пакети", "config.city.label": "Град" }, messages: { greeting: "Здравей, {name}" } },
    });
    const report = await validatePlugin(path, { platform: "win32" });
    expect(report.problems).toEqual([]);
    // The fields with English: name, description, the city's label and description (units has neither).
    expect(report.locales).toEqual([
      { locale: "en", path: "locales/en.json", problems: [], messages: { translated: 2, total: 2, missing: [] } },
      {
        locale: "bg",
        path: "locales/bg.json",
        problems: [],
        manifest: { translated: 2, total: 4, missing: ["description", "config.city.description"] },
        messages: { translated: 1, total: 2, missing: ["things"] },
      },
    ]);
    const text = renderPluginValidation(path, report);
    expect(text).toContain("language pack en (locales/en.json): 2 of 2 messages\n");
    expect(text).toContain(
      "language pack bg (locales/bg.json): 2 of 4 manifest fields, 1 of 2 messages\n" +
        "  fields left in English: description, config.city.description\n" +
        "  messages left to English: things\n",
    );
    expect(text).toMatch(/\nvalid\n$/);
  });

  it("reports every pack's problems, not only the first install stops at, and the packs that check out", async () => {
    const fixed = plugin({
      en: { manifest: { name: "Packs" }, messages: {} },
      bg: {
        manifest: {
          "tools.go.description": "Иди някъде",
          "config.nowhere.label": "Никъде",
          name: "П".repeat(81),
        },
      },
    });
    const report = await validatePlugin(fixed, { platform: "win32" });
    expect(report.problems).toEqual([
      "the language pack locales/en.json is not valid: the English pack carries messages only: the manifest itself is the English",
      "the language pack locales/bg.json is not valid: tools.go.description is read by the model, which reads the manifest's English; it cannot be translated",
      "the language pack locales/bg.json is not valid: config.nowhere.label is not a field of this manifest a language pack can translate",
      "the language pack locales/bg.json is not valid: name is longer than the 80 characters its field takes",
    ]);
    expect(report.locales?.map((pack) => [pack.locale, pack.problems.length])).toEqual([
      ["en", 1],
      ["bg", 3],
    ]);
    const text = renderPluginValidation(fixed, report);
    expect(text).toContain("language pack bg (locales/bg.json): not valid, its errors below\n");
    expect(text).toMatch(/\nnot valid\n$/);
  });

  it("reports a missing pack and one that is not JSON beside a pack that checks out", async () => {
    const path = plugin({ en: { messages: { hi: "Hi" } }, bg: "{ not json" });
    const manifest = join(path, "tavi-plugin.json");
    const raw = JSON.parse(readFileSync(manifest, "utf8")) as { locales: Record<string, string> };
    raw.locales = { ...raw.locales, en: "locales/english.json" };
    writeFileSync(manifest, JSON.stringify(raw));
    const report = await validatePlugin(path, { platform: "win32" });
    expect(report.problems).toEqual([
      "the manifest's language pack locales/english.json does not exist",
      "the language pack locales/bg.json is not JSON",
    ]);
  });

  it("reports a pack over 64 KiB beside the other packs' problems", async () => {
    const report = await validatePlugin(plugin({ en: { manifest: { name: "Packs" } }, bg: "x".repeat(64 * 1024 + 1) }), {
      platform: "win32",
    });
    expect(report.problems).toEqual([
      "the language pack locales/en.json is not valid: the English pack carries messages only: the manifest itself is the English",
      "the language pack locales/bg.json is over 65536 bytes",
    ]);
  });

  it("re-reads a pack only as install's tree read would: a refused file, a linked folder or one outside the plugin is not there", () => {
    const path = plugin({ en: { messages: { hi: "Hi" } }, bg: { messages: { hi: "Здрасти" } } });
    const refused = pluginLocaleReportOnDisk(path, (real) => (real.endsWith("/locales/bg.json") ? "refused" : undefined));
    expect(refused?.problems).toEqual(["the manifest's language pack locales/bg.json does not exist"]);
    // The packs' folder swapped for a link to a folder outside the plugin after install's read.
    const outside = dirs.create("tavi-validate-locales-outside-");
    cpSync(join(path, "locales"), outside, { recursive: true });
    rmSync(join(path, "locales"), { recursive: true });
    symlinkSync(outside, join(path, "locales"));
    expect(pluginLocaleReportOnDisk(path)?.problems).toEqual([
      "the manifest's language pack locales/en.json does not exist",
      "the manifest's language pack locales/bg.json does not exist",
    ]);
  });

  it("warns about messages with no English and a field the manifest leaves empty", async () => {
    const report = await validatePlugin(
      plugin({
        en: { messages: { hi: "Hi" } },
        bg: { manifest: { "config.units.label": "Единици" }, messages: { hi: "Здрасти", bye: "Чао" } },
      }),
      { platform: "win32" },
    );
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([
      "the language pack locales/bg.json translates config.units.label, which the manifest leaves empty: only bg shows it",
      "the message bye has no English (not in locales/en.json): ctx.t answers the key itself in English and in any language without it",
    ]);
    const noEnglish = await validatePlugin(plugin({ bg: { messages: { hi: "Здрасти" } } }), { platform: "win32" });
    expect(noEnglish.warnings).toEqual([
      'the message hi has no English (no "en" pack in locales): ctx.t answers the key itself in English and in any language without it',
    ]);
  });

  it("hands register ctx.locale and a ctx.t that reads the English pack, as the owner does", async () => {
    const path = plugin(
      {
        en: { messages: { things: { one: "{count} thing", other: "{count} things" } } },
        bg: { messages: { things: { one: "{count} нещо", other: "{count} неща" } } },
      },
      `export function register({ registerTool, z, locale, t }) {
        if (locale !== "en") throw new Error("locale " + locale);
        const said = t("things", { count: 2 }) + " / " + t("unknown.key");
        if (said !== "2 things / unknown.key") throw new Error("said " + said);
        registerTool({ name: "go", inputSchema: z.object({}), handler: () => null });
      }`,
    );
    const report = await validatePlugin(path, { sandbox: direct, platform: "darwin" });
    expect(report.problems).toEqual([]);
    expect(report.registered?.tools).toEqual(["go"]);
  });

  it("reports nothing of packs for a plugin that declares none", async () => {
    const report = await validatePlugin(join(repo, "examples/plugins/acme-units"), { platform: "win32" });
    expect(report.locales).toBeUndefined();
    expect(renderPluginValidation("x", report)).not.toContain("language pack");
  });

  it("reads the examples' packs: the Telegram channel's setup words and the onboarding flow's messages", async () => {
    const telegram = await validatePlugin(join(repo, "examples/plugins/acme-telegram-webhook"), { platform: "win32" });
    expect(telegram).toMatchObject({ problems: [], warnings: [] });
    expect(telegram.locales).toEqual([
      expect.objectContaining({
        locale: "bg",
        // Only the placeholders, which are numbers, stay as they are.
        manifest: { translated: 14, total: 16, missing: ["channels.telegram.sender.placeholder", "channels.telegram.target.placeholder"] },
      }),
    ]);
    const onboarding = await validatePlugin(join(repo, "examples/plugins/acme-onboarding"), { sandbox: direct, platform: "darwin" });
    expect(onboarding).toMatchObject({ problems: [], warnings: [], registered: { onboarding: { flow: true } } });
    expect(onboarding.locales?.map((pack) => [pack.locale, pack.messages?.translated, pack.messages?.missing])).toEqual([
      ["en", 13, []],
      ["bg", 13, []],
    ]);
  });

  it("prints the coverage in text and in --format json, and exits 1 on a pack install would refuse", async () => {
    const good = plugin({ en: { messages: { hi: "Hi" } }, bg: { manifest: { name: "Пакети" }, messages: { hi: "Здрасти" } } });
    const text = await tavi(["plugins", "validate", good, "--data-dir", dirs.create("tavi-validate-locales-data-")]);
    expect(text.code, text.stderr).toBe(EXIT.ok);
    expect(text.stdout).toContain("language pack bg (locales/bg.json): 1 of 4 manifest fields, 1 of 1 message\n");
    const json = await tavi(["plugins", "validate", good, "--format", "json", "--data-dir", dirs.create("tavi-validate-locales-data-")]);
    expect(json.code, json.stderr).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout)).toMatchObject({
      pluginId: "acme.packs",
      problems: [],
      locales: [
        { locale: "en", messages: { translated: 1, total: 1 } },
        { locale: "bg", manifest: { translated: 1, total: 4 }, messages: { translated: 1, total: 1 } },
      ],
    });
    const bad = plugin({ bg: { manifest: { "tools.go.description": "Иди" } } });
    const refused = await tavi(["plugins", "validate", bad, "--format", "json", "--data-dir", dirs.create("tavi-validate-locales-data-")]);
    expect(refused.code).toBe(EXIT.taskFailed);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      problems: [expect.stringContaining("tools.go.description is read by the model")],
      locales: [{ locale: "bg", problems: [expect.stringContaining("tools.go.description")] }],
    });
  });
});
