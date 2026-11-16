import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SITE_NOTE_ABI, SiteNoteSchema, TaviError, type PluginManifest, type SiteNote, type SiteRecipeStep } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { SitesOn } from "../apps/sharing.js";
import { enabledPluginEntries, type SitePluginSource } from "./site-policy.js";
import { describeRecipeStep } from "./site-recipes.js";

/**
 * Site notes beyond the built-in ones: a
 * plugin's (the `.json` files its manifest's `siteNotes` names, read from its
 * verified snapshot) and the operator's (the data directory's `site-notes/`).
 * Both are off until turned on in the operator's site switch, the one site
 * profiles use (`apps.sites`): a plugin's note is on while the plugin's site
 * of the same id is; an operator's note is on under `@operator` as `<id>@<digest>`,
 * so a file changed since it was reviewed is off again.
 */

/** Where the operator's site notes are kept in the data directory. */
export const SITE_NOTES_DIRECTORY = "site-notes";
/** The operator's notes in the site switch: no plugin id starts with `@`. */
export const OPERATOR_SITE_NOTES = "@operator";

/** A note enabled, and who wrote it: what the agent is told the notes come from. */
export interface EnabledSiteNote {
  readonly from: string;
  readonly note: SiteNote;
}

/** An operator's note on disk: its file, the digest its switch names, and the note (none when the file does not read as one). */
export interface OperatorSiteNote {
  readonly file: string;
  readonly digest: string;
  readonly note?: SiteNote;
  readonly problem?: string;
}

const MAX_NOTE_BYTES = 64 * 1024;
const MAX_OPERATOR_NOTES = 200;

/** The switch entry naming an operator's note as it was reviewed. */
export const operatorNoteKey = (note: SiteNote, digest: string): string => `${note.id}@${digest.slice(0, 16)}`;

/** A version's site notes, from its verified snapshot: one that no longer reads is left out, never guessed at. */
export function readPluginSiteNotes(directory: string, manifest: PluginManifest): SiteNote[] {
  return (manifest.siteNotes ?? []).flatMap((path) => {
    try {
      const parsed = SiteNoteSchema.safeParse(JSON.parse(readFileSync(join(directory, path), "utf8")));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/** An operator's note as last read, kept while its file's modification time and size stay the same. */
type OperatorNoteCache = Map<string, { readonly mtimeMs: number; readonly size: number; readonly entry: OperatorSiteNote }>;

/** One operator's note: its size is checked before it is read, so a file over the limit is never read in full. */
function readOperatorNote(directory: string, file: string, cache: OperatorNoteCache | undefined): OperatorSiteNote {
  const path = join(directory, file);
  try {
    const { mtimeMs, size } = statSync(path);
    const cached = cache?.get(file);
    if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) return cached.entry;
    const entry = ((): OperatorSiteNote => {
      if (size > MAX_NOTE_BYTES) return { file, digest: "", problem: "larger than 64 KiB" };
      const bytes = readFileSync(path);
      const digest = sha256Hex(bytes);
      // It may have grown since it was looked at.
      if (bytes.byteLength > MAX_NOTE_BYTES) return { file, digest, problem: "larger than 64 KiB" };
      try {
        const parsed = SiteNoteSchema.safeParse(JSON.parse(bytes.toString("utf8")));
        return parsed.success
          ? { file, digest, note: parsed.data }
          : { file, digest, problem: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
      } catch {
        return { file, digest, problem: "not JSON" };
      }
    })();
    cache?.set(file, { mtimeMs, size, entry });
    return entry;
  } catch {
    return { file, digest: "", problem: "unreadable" };
  }
}

/**
 * The operator's notes, by file name; a directory that is not there holds
 * none. With `cache`, a file whose modification time and size are unchanged
 * is not read again.
 */
export function readOperatorSiteNotes(directory: string, cache?: OperatorNoteCache): OperatorSiteNote[] {
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, MAX_OPERATOR_NOTES);
  } catch {
    cache?.clear();
    return [];
  }
  if (cache !== undefined) for (const file of cache.keys()) if (!names.includes(file)) cache.delete(file);
  return names.map((file) => readOperatorNote(directory, file, cache));
}

/**
 * The notes the operator turned on, from the switch as the site policy last
 * read it: a running plugin's (not one withdrawn), read once per version, and
 * the operator's, each file read again only once it changed.
 */
export function enabledSiteNotes(input: {
  readonly plugins: () => readonly SitePluginSource[];
  readonly withdrawn: () => ReadonlySet<string>;
  readonly operatorDirectory: string;
  readonly read?: (directory: string, manifest: PluginManifest) => readonly SiteNote[];
}): (on: SitesOn) => EnabledSiteNote[] {
  const fromPlugins = enabledPluginEntries({ plugins: input.plugins, withdrawn: input.withdrawn, read: input.read ?? readPluginSiteNotes });
  const operatorCache: OperatorNoteCache = new Map();
  return (on) => {
    const operatorOn = on[OPERATOR_SITE_NOTES] ?? [];
    const fromOperator =
      operatorOn.length === 0
        ? []
        : readOperatorSiteNotes(input.operatorDirectory, operatorCache).flatMap(({ note, digest }): EnabledSiteNote[] =>
            note !== undefined && operatorOn.includes(operatorNoteKey(note, digest)) ? [{ from: "the operator", note }] : [],
          );
    return [...fromPlugins(on).map(({ pluginId, entry }) => ({ from: `the plugin ${pluginId}`, note: entry })), ...fromOperator];
  };
}

/** A note's id for a site's recipe: `recipe-` and its host, in the id's letters. */
export function recipeNoteId(host: string): string {
  return `recipe-${host.replace(/[^a-z0-9]+/g, "-")}`.slice(0, 40).replace(/-+$/, "");
}

/**
 * A recipe proposed as a site note: the steps that led to results, as the
 * agent is shown them, for the operator to review, edit and turn on. Labels are
 * the site's own text, so the note is read as reference notes like any other.
 */
export function siteNoteFromRecipe(recipe: {
  readonly host: string;
  readonly steps: readonly { readonly [key in keyof SiteRecipeStep]: SiteRecipeStep[key] | undefined }[];
  readonly uses: number;
  readonly updatedAt: string;
}): SiteNote {
  const steps = recipe.steps.map(
    (step, index) =>
      `${String(index + 1)}. ${describeRecipeStep(step.label === undefined ? step : { ...step, label: step.label.slice(0, 60) })}`,
  );
  const lead = `These steps led to results here (${recipe.uses === 1 ? "once" : `${String(recipe.uses)} times`}, last ${recipe.updatedAt.slice(0, 10)}): `;
  const tail = ". Follow them with the task's own values where they still fit the page.";
  return SiteNoteSchema.parse({
    abi: SITE_NOTE_ABI,
    id: recipeNoteId(recipe.host),
    name: recipe.host.slice(0, 80),
    hosts: [recipe.host],
    notes: `${lead}${steps.join("; ")}`.slice(0, 1200 - tail.length) + tail,
  });
}

/** A host as recipes are kept: lower-cased, without `www.`. */
export const recipeHost = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");

/** A recipe as `siteNoteFromRecipe` takes it: what `browser recipes` answers and the repository lists. */
type ProposableRecipe = Parameters<typeof siteNoteFromRecipe>[0];

/**
 * `--propose <host>` and the canvas's *Save as a site note*: the host's
 * recipe written as a new note in `directory` (the data directory's
 * `site-notes/`), off until the operator turns it on. Never over a file
 * there: `CONFLICT` says to edit it, or remove it to propose again.
 */
export async function proposeRecipeNote(
  directory: string,
  recipes: readonly ProposableRecipe[],
  rawHost: string,
): Promise<{ readonly note: SiteNote; readonly file: string; readonly path: string }> {
  const host = recipeHost(rawHost);
  const recipe = recipes.find((candidate) => candidate.host === host);
  if (recipe === undefined) throw new TaviError("NOT_FOUND", `no recipe for ${host}: \`tavi browser recipes\` lists them`);
  let note: SiteNote;
  try {
    note = siteNoteFromRecipe(recipe);
  } catch {
    throw new TaviError("INVALID_INPUT", `${host}'s recipe does not make a site note (its host is not a plain domain)`);
  }
  const file = `${note.id}.json`;
  const path = join(directory, file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${JSON.stringify(note, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new TaviError("CONFLICT", `${path} is there already: edit it, or remove it to propose again`, { details: { id: note.id } });
    throw error;
  }
  return { note, file, path };
}
