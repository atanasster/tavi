#!/usr/bin/env node
// Builds assets/skills.json: Tavi's seed list, then the ESCO
// v1.2.1 skill concepts and O*NET 31.0 software names that real postings
// name, with their aliases in eight languages and Norwegian.
//
//   node scripts/build-skills.mjs --esco <dir of ESCO API search pages> \
//     --onet "<O*NET 31.0 Software Skills.txt>" --corpus <postings.jsonl>... [--out assets/skills.json]
//
// The ESCO pages are the API's `search?type=skill&full=true&selectedVersion=v1.2.1`
// answers (100 a page); the corpus is RawPosting JSON lines ({ raw }) gathered
// through jobs-kit's own adapters. Neither is kept in the repository: the
// asset records their versions, the corpus's size and date, and what was
// changed (ESCO and O*NET ask that a modified version say so).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createSkillIndex } = await import(join(root, "dist", "index.mjs"));

const args = process.argv.slice(2);
const option = (name) => {
  const values = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name) values.push(args[index + 1]);
  return values;
};
const [escoDir] = option("--esco");
const [onetFile] = option("--onet");
const corpusFiles = option("--corpus");
const out = option("--out")[0] ?? join(root, "assets", "skills.json");
if (escoDir === undefined || onetFile === undefined || corpusFiles.length === 0)
  throw new Error("usage: build-skills.mjs --esco <dir> --onet <file> --corpus <file>... [--out <file>]");

/** The asset's budget. */
const MAX_BYTES = 2 * 1024 * 1024;
/** The eight languages aliases are read in, and Norwegian for NAV. */
const LANGUAGES = ["en", "de", "fr", "es", "nl", "sv", "it", "pt", "no"];
/** At most this many concepts from ESCO and O*NET together (about 4,000). */
const MAX_CONCEPTS = 4_000;
/** A concept is kept when at least this many postings name it. */
const MIN_POSTINGS = 1;
/** An alias other than a concept's own label that more than this share of postings holds is too general to mean the concept. */
const GENERIC_SHARE = 0.08;
/** A one-word alias in lower case is kept only when at most this share of postings holds it: a specific word ("phlebotomy"), not a general one ("plan"). */
const SPECIFIC_SHARE = 0.003;
/** Words a posting's legal boilerplate holds (equal opportunity, benefits), never a skill it asks for. */
const BOILERPLATE = new Set([
  "pregnancy",
  "religion",
  "gender",
  "veteran",
  "disability",
  "race",
  "age",
  "ancestry",
  "ethnicity",
  "citizenship",
  "marital",
  "genetics",
  "history",
  "energy",
  "integrity",
  "ethics",
  "moral",
  "morale",
  "plan",
  "planning",
  "insurance",
  "health",
  "wellness",
  "equity",
  "benefits",
  "vacation",
  "travel",
  "family",
  "community",
  "culture",
  "diversity",
  "inclusion",
  "communication",
  "interaction",
  "conversation",
  "correspondence",
  "innovate",
  "experiment",
  "detect",
  "decide",
  "choose",
  "schedule",
  "measurement",
  "measuring",
  "fuel",
  "brands",
  "chip",
  "financials",
  "finances",
  "administration",
  "invent",
  "moral",
]);
/** Concepts postings name only in their boilerplate (a law's "…Act", E-Verify, "the application process") or as a company. */
const NOT_SKILLS = new Set([
  "act",
  "e verify",
  "google",
  "application process",
  "hybrid model",
  "sex education",
  "reduce",
  "analyze",
  "exchange",
  "smoke",
  "iq",
  "inventor",
  "world",
]);
/** Aliases of more words than this are a sentence, never written as such in a posting. */
const MAX_ALIAS_WORDS = 5;
/** Software vendors whose names O*NET puts before a product; the product alone is how postings write it ("Excel", "Jira"). */
const VENDORS = [
  "Microsoft",
  "Adobe",
  "Oracle",
  "Atlassian",
  "Amazon",
  "Google",
  "IBM",
  "SAP",
  "Apache",
  "Salesforce",
  "Autodesk",
  "Intuit",
  "Apple",
  "Cisco",
  "VMware",
  "Red Hat",
  "JetBrains",
  "HashiCorp",
  "Meta",
  "Facebook",
  "Tableau Software",
  "Elastic",
];
/** Product names that are also everyday words: kept with their vendor only. */
const COMMON_WORDS = new Set([
  "word",
  "access",
  "project",
  "teams",
  "outlook",
  "publisher",
  "paint",
  "notes",
  "forms",
  "lists",
  "sheets",
  "docs",
  "slides",
  "drive",
  "analytics",
  "cloud",
  "connect",
  "office",
  "search",
  "maps",
  "photos",
  "keep",
  "sites",
  "calendar",
  "chat",
  "meet",
  "mail",
  "dynamics",
  "fabric",
  "stream",
  "planner",
  "bookings",
  "sway",
  "visio",
  "go",
  "r",
  "c",
  "swift",
  "rust",
  "spring",
  "express",
  "dart",
  "ruby",
  "crystal",
  "camel",
  "flex",
  "pig",
  "hive",
  "storm",
  "spark",
  "kafka",
  "beam",
  "airflow",
]);

const tokens = (text) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*|\.[\p{L}][\p{L}\p{N}]*/gu)
    ?.map((word) => word.replace(/\.+$/, "")) ?? [];
const key = (text) => tokens(text).join(" ");

// Tavi's seed list first (scripts/seed-skills.json): its labels and as-written aliases ("Go", "R") keep their meaning.
const seed = {
  skills: JSON.parse(readFileSync(join(root, "scripts", "seed-skills.json"), "utf8")).map(([id, label, aliases, exact]) => ({
    id: `tavi:${id}`,
    label,
    aliases,
    ...(exact === undefined ? {} : { exact }),
  })),
};

// ESCO v1.2.1: every released skill concept, its preferred and alternative labels in the languages above.
const esco = [];
for (const file of readdirSync(escoDir)
  .filter((name) => /^page\d+\.json$/.test(name))
  .sort()) {
  for (const concept of JSON.parse(readFileSync(join(escoDir, file), "utf8"))._embedded.results) {
    if (concept.status !== "released") continue;
    const english = concept.preferredLabel?.en;
    if (typeof english !== "string") continue;
    const labels = [];
    for (const language of LANGUAGES) {
      const preferred = concept.preferredLabel?.[language];
      if (typeof preferred === "string") labels.push(preferred);
      for (const alternative of concept.alternativeLabel?.[language] ?? []) labels.push(alternative);
    }
    esco.push({ id: `esco:${concept.uri.split("/").pop()}`, label: english, candidates: labels });
  }
}
if (esco.length < 13_000) throw new Error(`only ${String(esco.length)} ESCO concepts read: the download is incomplete`);

// O*NET 31.0 software names (its "Software Skills" file, formerly "Technology Skills"): each product once, hot ones first.
const onet = new Map();
for (const line of readFileSync(onetFile, "utf8").split("\n").slice(1)) {
  const [, example, , , hot] = line.split("\t");
  if (example === undefined || example.trim() === "") continue;
  const name = example.trim();
  const known = onet.get(name) ?? { hot: false, occupations: 0 };
  onet.set(name, { hot: known.hot || hot === "Y", occupations: known.occupations + 1 });
}
/** A product name alone is its name when it is clearly one: several words, a capital inside ("PowerPoint"), or a known product. */
const PRODUCTS = new Set([
  "excel",
  "jira",
  "confluence",
  "photoshop",
  "illustrator",
  "indesign",
  "tableau",
  "azure",
  "bigquery",
  "redshift",
  "dynamodb",
  "lambda",
  "sagemaker",
  "quickbooks",
  "netsuite",
  "looker",
  "figma",
  "premiere",
  "acrobat",
  "lightroom",
  "autocad",
  "revit",
  "maya",
  "solidworks",
]);
const productAlone = (product) => tokens(product).length > 1 || /\p{Ll}\p{Lu}/u.test(product) || PRODUCTS.has(product.toLowerCase());
const onetEntries = [...onet].map(([name, { hot, occupations }]) => {
  const candidates = [name];
  for (const vendor of VENDORS) {
    if (!name.startsWith(`${vendor} `)) continue;
    const product = name.slice(vendor.length + 1).trim();
    if (product.length > 1 && !COMMON_WORDS.has(product.toLowerCase()) && productAlone(product)) candidates.push(product);
  }
  return { id: `onet:${createHash("sha1").update(name).digest("hex").slice(0, 12)}`, label: name, candidates, hot, occupations };
});

// The corpus: the postings' titles and texts, once each.
const postings = [];
const seen = new Set();
for (const file of corpusFiles) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const { raw } = JSON.parse(line);
    const text = `${raw.title ?? ""}\n${raw.descriptionText ?? (raw.descriptionHtml ?? "").replace(/<[^>]+>/g, " ")}`;
    const id = createHash("sha1").update(text).digest("hex");
    if (seen.has(id)) continue;
    seen.add(id);
    postings.push(text);
  }
}

// Each word as written, in how many postings: a capitalised word postings mostly write in lower case ("Act", "World",
// "Database") is an everyday word at a sentence's start, not the product or skill it names.
const writtenIn = new Map();
for (const text of postings) {
  for (const word of new Set(
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu) ?? [],
  ))
    writtenIn.set(word, (writtenIn.get(word) ?? 0) + 1);
}
const everyday = (alias) => {
  const [word] =
    alias
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu) ?? [];
  if (word === undefined || word === word.toLowerCase()) return false;
  return (writtenIn.get(word.toLowerCase()) ?? 0) >= (writtenIn.get(word) ?? 0);
};

// How many postings hold each alias: one entry per alias, read by the index the plugin uses.
const aliasOf = new Map();
const probe = [];
/** A one-word alias written with a capital ("Act!", "LESS", "Informatik") is matched only as written, so "act" and "less" are not it. */
const asWritten = (alias) => tokens(alias).length === 1 && /\p{Lu}/u.test(alias);
const addProbe = (owner, alias) => {
  const words = tokens(alias);
  if (words.length === 0 || words.length > MAX_ALIAS_WORDS || words.join(" ").length < 2) return;
  if (words.length === 1 && !asWritten(alias) && BOILERPLATE.has(words[0])) return;
  if (asWritten(alias) && everyday(alias)) return;
  const id = `${owner}\u0000${words.join(" ")}`;
  if (aliasOf.has(id)) return;
  aliasOf.set(id, { owner, alias, key: words.join(" ") });
  probe.push({ id, label: alias, aliases: [], ...(asWritten(alias) ? { exact: [alias] } : {}) });
};
for (const entry of [...esco, ...onetEntries]) for (const alias of entry.candidates) addProbe(entry.id, alias);
// Each alias is its own entry here, so an alias two concepts share is counted for each.
const counts = new Map();
const chunks = new Map();
for (const item of probe) {
  const alias = aliasOf.get(item.id).key;
  const group = chunks.get(alias) ?? [];
  group.push(item);
  chunks.set(alias, group);
}
// Index the probe in layers: an alias claimed by one concept in a layer, so shared aliases are each counted.
const layers = [];
for (const group of chunks.values()) group.forEach((item, index) => (layers[index] ??= []).push(item));
for (const layer of layers) {
  const index = createSkillIndex({ version: "probe", attribution: [], skills: layer });
  for (const text of postings) for (const found of index.extract(text)) counts.set(found.id, (counts.get(found.id) ?? 0) + 1);
}

// A concept's aliases: not so general that they mean anything, in every language; a lower-case word only when
// postings show it is specific. Those no posting held are kept (the corpus is mostly English), but a lower-case word.
const usefulAliases = (entry) => {
  const kept = [];
  for (const alias of entry.candidates) {
    const id = `${entry.id}\u0000${key(alias)}`;
    if (!aliasOf.has(id)) continue;
    const held = counts.get(id) ?? 0;
    const single = tokens(alias).length === 1 && !asWritten(alias);
    if (single && (held === 0 || held / postings.length > SPECIFIC_SHARE)) continue;
    if (key(alias) !== key(entry.label) && held / postings.length > GENERIC_SHARE) continue;
    if (!kept.some((each) => key(each) === key(alias))) kept.push(alias);
  }
  return kept;
};
const reachOf = (entry, aliases) => Math.max(0, ...aliases.map((alias) => counts.get(`${entry.id}\u0000${key(alias)}`) ?? 0));
const scored = [...esco, ...onetEntries]
  .map((entry) => {
    const aliases = usefulAliases(entry);
    const reach = reachOf(entry, aliases);
    return { entry, aliases, reach };
  })
  .filter(({ entry, aliases, reach }) => aliases.length > 0 && reach >= MIN_POSTINGS && !NOT_SKILLS.has(key(entry.label)));
scored.sort((a, b) => b.reach - a.reach || a.entry.id.localeCompare(b.entry.id));
// One entry a name: a concept whose label the seed or a commoner concept already has adds nothing.
const named = new Set(seed.skills.flatMap((skill) => [skill.label, ...skill.aliases]).map(key));
const chosen = scored
  .filter(({ entry }) => {
    if (named.has(key(entry.label))) return false;
    named.add(key(entry.label));
    return true;
  })
  .slice(0, MAX_CONCEPTS);

// Each alias to the first entry that has it, as-written ones too: a posting's "SEO" is the seed's SEO, once.
const claimed = new Set(seed.skills.flatMap((skill) => [skill.label, ...skill.aliases, ...(skill.exact ?? [])]).map(key));
const unclaimed = (alias) => {
  if (claimed.has(key(alias))) return false;
  claimed.add(key(alias));
  return true;
};
const skills = [
  ...seed.skills,
  ...chosen.flatMap(({ entry, aliases: all }) => {
    // Every name, its label's too, to the first entry that has it; one left with none of its own adds nothing.
    const aliases = all.filter(unclaimed);
    if (aliases.length === 0) return [];
    // The English label when it is still this concept's; else the alias postings use most stands as the label.
    const label = aliases.some((alias) => key(alias) === key(entry.label)) ? entry.label : aliases[0];
    // A two-letter abbreviation means many things ("IC" is an individual contributor more often than a circuit): only a concept's own name.
    const exact = aliases.filter((alias) => asWritten(alias) && (tokens(alias)[0].length > 2 || key(alias) === key(label)));
    return [
      {
        id: entry.id,
        label,
        aliases: aliases.filter((alias) => key(alias) !== key(label) && !asWritten(alias)),
        ...(exact.length === 0 ? {} : { exact }),
      },
    ];
  }),
];
const fromEsco = skills.filter((skill) => skill.id.startsWith("esco:")).length;
const fromOnet = skills.filter((skill) => skill.id.startsWith("onet:")).length;
const corpusDate = new Date().toISOString().slice(0, 10);
const dictionary = {
  version: "",
  attribution: [
    "Tavi's own seed list of common skills and their aliases.",
    "This service uses the ESCO classification of the European Commission (https://esco.ec.europa.eu). Modified: a subset of ESCO v1.2.1 skill concepts — those named in a sample of real job postings — with their preferred and alternative labels in nine languages, labels of more than five words and labels too general to mean the skill left out, and one-word labels with a capital matched only as written; ESCO is not responsible for this version.",
    "This site incorporates information from O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET® is a trademark of USDOL/ETA. Tavi has modified all or some of this information. USDOL/ETA has not approved, endorsed, or tested these modifications.",
  ],
  build: {
    sources: { esco: "v1.2.1", onet: "31.0 (Software Skills)" },
    corpus: { postings: postings.length, gathered: corpusDate, through: "jobs-kit's own adapters, public boards" },
    concepts: { seed: seed.skills.length, esco: fromEsco, onet: fromOnet },
    rules: {
      languages: LANGUAGES,
      minPostings: MIN_POSTINGS,
      genericShare: GENERIC_SHARE,
      specificShare: SPECIFIC_SHARE,
      maxAliasWords: MAX_ALIAS_WORDS,
      maxConcepts: MAX_CONCEPTS,
      oneWordWithACapital: "as written",
    },
  },
  skills,
};
// The same inputs give the same asset: its version is a hash of what it holds, and names its sources.
dictionary.version = `${createHash("sha256").update(JSON.stringify(skills)).digest("hex").slice(0, 12)}+esco-1.2.1+onet-31.0`;
const text = `${JSON.stringify(dictionary)}\n`;
if (Buffer.byteLength(text) > MAX_BYTES)
  throw new Error(`the skills asset is ${String(Buffer.byteLength(text))} bytes, past its ${String(MAX_BYTES)}-byte budget`);
writeFileSync(out, text);
console.log(
  JSON.stringify({
    out,
    bytes: Buffer.byteLength(JSON.stringify(dictionary)),
    postings: postings.length,
    ...dictionary.build.concepts,
    aliases: skills.reduce((sum, skill) => sum + skill.aliases.length, 0),
  }),
);
