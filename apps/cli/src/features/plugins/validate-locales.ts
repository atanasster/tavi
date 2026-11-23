import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGIN_BOUNDS,
  PLUGIN_MANIFEST_FILE,
  PluginManifestSchema,
  pluginOverlayTargets,
  type PluginLocaleFile,
  type PluginManifest,
} from "@tavi/contracts";
import type { Catalog, Locale } from "@tavi/contracts/i18n";
import { checkLocalePack, type PluginFileCheck } from "@tavi/runtime";

/**
 * `tavi plugins validate`'s look at a plugin's language packs
 * (`locales/<lang>.json`, manifest `schemaVersion: 3`): every problem install
 * would refuse a pack for, not only the first, and how much of the plugin
 * each pack translates.
 */

/** How much of one kind of text a pack translates: `translated` of `total`, and the paths or keys it leaves to English. */
export interface PluginLocaleCount {
  readonly translated: number;
  readonly total: number;
  readonly missing: readonly string[];
}

/** One language pack, as `tavi plugins validate` reports it. */
export interface PluginLocaleCoverage {
  readonly locale: Locale;
  readonly path: string;
  /** What install refuses the pack for; empty when it checks out. */
  readonly problems: readonly string[];
  /**
   * The manifest's words a person reads (fields with English text in the manifest) that the pack
   * translates; absent for English, whose words are the manifest's own, and for a pack that does not check out.
   */
  readonly manifest?: PluginLocaleCount;
  /** The plugin's own messages (`ctx.t`), out of every key in its packs that check out; absent for a pack that does not check out. */
  readonly messages?: PluginLocaleCount;
}

export interface PluginLocaleReport {
  readonly locales: readonly PluginLocaleCoverage[];
  /** Each pack problem, said as install says it (naming the file), for the report's `problems`. */
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  /** The English messages `ctx.t` falls back to, from an English pack that checks out: what `register` is handed in the validate run. */
  readonly english: Catalog;
}

/** What a pack file is: its bytes, or why it cannot be read. */
type PackFile = Buffer | undefined;

/** The pack at `path` as install checks it (`checkLocalePack`): its problems, each a sentence naming the file, or the pack. */
function checkPack(
  manifest: PluginManifest,
  locale: Locale,
  path: string,
  content: PackFile,
): { readonly problems: readonly string[]; readonly pack?: PluginLocaleFile } {
  const checked = checkLocalePack(manifest, locale, path, content);
  if ("pack" in checked) return { problems: [], pack: checked.pack };
  if ("file" in checked) return { problems: [checked.file] };
  return { problems: checked.problems.map((problem) => `the language pack ${path} is not valid: ${problem}`) };
}

const SENTINEL = "\u0000tavi-validate-field\u0000";

/** Where in `value` the sentinel string is, as a path of keys and indexes. */
function sentinelAt(value: unknown, path: readonly (string | number)[] = []): readonly (string | number)[] | undefined {
  if (value === SENTINEL) return path;
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const found = sentinelAt(child, [...path, Array.isArray(value) ? Number(key) : key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let at: unknown = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
}

/**
 * The manifest fields a pack may translate that have English text: each path
 * `pluginOverlayTargets` offers, written into a copy to find where it lands,
 * kept when the manifest has words there. A field the manifest leaves empty
 * (an optional description, a setting with no label) is not counted.
 */
export function englishOverlayFields(manifest: PluginManifest): readonly string[] {
  const fields: string[] = [];
  for (const [path, target] of pluginOverlayTargets(manifest)) {
    const copy = structuredClone(manifest);
    target.apply(copy, SENTINEL);
    const at = sentinelAt(copy);
    const english = at === undefined ? undefined : valueAt(manifest, at);
    if (typeof english === "string" && english.trim() !== "") fields.push(path);
  }
  return fields;
}

/**
 * Every language pack `manifest` declares, read with `fileOf`: its problems as
 * install finds them, and, for each that checks out, the manifest fields and
 * message keys it translates out of the total.
 */
export function pluginLocaleReport(manifest: PluginManifest, fileOf: (path: string) => PackFile): PluginLocaleReport {
  const declared = Object.entries(manifest.locales ?? {}) as [Locale, string][];
  if (declared.length === 0) return { locales: [], problems: [], warnings: [], english: {} };
  const checked = declared.map(([locale, path]) => ({ locale, path, ...checkPack(manifest, locale, path, fileOf(path)) }));
  const fields = englishOverlayFields(manifest);
  const withEnglish = new Set(fields);
  const keys = [...new Set(checked.flatMap(({ pack }) => Object.keys(pack?.messages ?? {})))].sort();
  const warnings: string[] = [];
  const locales = checked.map(({ locale, path, problems, pack }): PluginLocaleCoverage => {
    if (pack === undefined) return { locale, path, problems };
    const own = Object.keys(pack.messages);
    const messages = { translated: own.length, total: keys.length, missing: keys.filter((key) => !Object.hasOwn(pack.messages, key)) };
    if (locale === "en") return { locale, path, problems, messages };
    const overlaid = Object.keys(pack.manifest);
    for (const field of overlaid.filter((each) => !withEnglish.has(each)))
      warnings.push(`the language pack ${path} translates ${field}, which the manifest leaves empty: only ${locale} shows it`);
    return {
      locale,
      path,
      problems,
      manifest: {
        translated: overlaid.filter((field) => withEnglish.has(field)).length,
        total: fields.length,
        missing: fields.filter((field) => !Object.hasOwn(pack.manifest, field)),
      },
      messages,
    };
  });
  // `ctx.t` falls back to English, then to the key: a key with no English shows as the key itself where its language lacks it.
  const englishPack = checked.find(({ locale }) => locale === "en");
  const englishMessages = (englishPack?.pack?.messages ?? {}) as Catalog;
  const noEnglish = keys.filter((key) => !Object.hasOwn(englishMessages, key));
  // An English pack that does not check out is already a problem.
  if (noEnglish.length > 0 && (englishPack === undefined || englishPack.pack !== undefined)) {
    const one = noEnglish.length === 1;
    const where = englishPack === undefined ? 'no "en" pack in locales' : `not in ${englishPack.path}`;
    warnings.push(
      `${one ? "the message" : "the messages"} ${listed(noEnglish)} ${one ? "has" : "have"} no English (${where}): ctx.t answers the key itself in English and in any language without ${one ? "it" : "them"}`,
    );
  }
  return { locales, problems: checked.flatMap(({ problems }) => problems), warnings, english: englishMessages };
}

/** Up to `most` items, then how many more. */
export function listed(items: readonly string[], most = 8): string {
  return items.length <= most ? items.join(", ") : `${items.slice(0, most).join(", ")} and ${String(items.length - most)} more`;
}

/**
 * The packs of the folder at `directory`, read from disk, when install's check
 * stopped at a pack: its manifest, when it parses, and each pack it declares (a
 * regular file within the byte limit, that `check` lets be read). `undefined`
 * when the manifest does not parse or declares none.
 */
export function pluginLocaleReportOnDisk(directory: string, check?: PluginFileCheck): PluginLocaleReport | undefined {
  let manifest: PluginManifest;
  try {
    const parsed = PluginManifestSchema.safeParse(JSON.parse(readFileSync(join(directory, PLUGIN_MANIFEST_FILE), "utf8")));
    if (!parsed.success) return undefined;
    manifest = parsed.data;
  } catch {
    return undefined;
  }
  if (manifest.locales === undefined) return undefined;
  let root: string;
  try {
    root = realpathSync.native(directory);
  } catch {
    return undefined;
  }
  return pluginLocaleReport(manifest, (path) => {
    // As install's tree read: no link anywhere along the path, and the file inside the plugin.
    const parts = path.split("/");
    const expected = join(root, ...parts);
    try {
      for (let at = 1; at < parts.length; at += 1) if (lstatSync(join(root, ...parts.slice(0, at))).isSymbolicLink()) return undefined;
      const stat = lstatSync(expected);
      if (!stat.isFile() || realpathSync.native(expected) !== expected || check?.(expected, stat) !== undefined) return undefined;
      // Over the limit is said as such without reading it all: a buffer one byte longer says so.
      return stat.size > PLUGIN_BOUNDS.maxLocaleBytes ? Buffer.alloc(PLUGIN_BOUNDS.maxLocaleBytes + 1) : readFileSync(expected);
    } catch {
      return undefined;
    }
  });
}
