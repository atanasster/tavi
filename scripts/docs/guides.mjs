// The how-to guides under docs/use-cases/: where each folder sits and what it
// is called, how a guide page is read (title, lead, context box, numbered steps
// with one image each), and the folder indexes generated from the pages. Read by
// scripts/docs/guide-indexes.mjs (which writes the indexes), by
// tests/use-case-guides.test.ts (which checks every page against this shape)
// and by the guide walks in tests/guides/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { root } from "./browser.mjs";

export const guidesRoot = join(root, "docs/use-cases");
export const imagesRoot = join(root, "docs/assets/use-cases");

/**
 * Every folder a guide may live in, in reading order: its title and a one-line
 * lead for the indexes. An everyday folder holds the recipes for the Ideas
 * catalogue's templates.
 */
export const FOLDERS = [
  { id: "get-started", title: "Get started", lead: "Install Tavi, connect a model and meet each way of talking to it." },
  { id: "chat", title: "Chat", lead: "Home, side chats, approvals and everything a conversation can do." },
  { id: "memory-and-skills", title: "Memory and skills", lead: "What Tavi remembers about you, and the procedures it learns." },
  { id: "files-and-code", title: "Files and code", lead: "Working folders, file changes and the sandbox." },
  { id: "web-and-browser", title: "Web and browser", lead: "Search, research and the agent's own browser." },
  { id: "desktop", title: "Desktop", lead: "Experimental control of apps on your Mac." },
  { id: "documents", title: "Documents", lead: "Reading, scanning and filling PDFs, and the daily brief." },
  { id: "photos-and-video", title: "Photos and video", lead: "Questions about images, transcripts and movement coaching." },
  { id: "channels", title: "Channels", lead: "Telegram, email and Discord, and who may talk to Tavi." },
  { id: "automation", title: "Automation", lead: "Reminders, to-dos, schedules, routines and the heartbeat." },
  { id: "connected-apps", title: "Connected apps", lead: "Google apps, Home Assistant, task apps and MCP servers." },
  { id: "scripting", title: "Scripting", lead: "One-shot tasks, shell pipelines and unattended runs." },
  { id: "run-and-maintain", title: "Run and maintain", lead: "Models, credentials, permissions, backups and health." },
  { id: "extend", title: "Extend", lead: "Plugins, mods and channels of your own." },
  { id: "everyday/shopping-and-style", title: "Shopping and style", lead: "Landed costs, reviews, wardrobes and mending." },
  { id: "everyday/local-services", title: "Local services", lead: "Licensed specialists, in-network doctors and neighbourhoods." },
  { id: "everyday/work-and-career", title: "Work and career", lead: "Job watches, trends, comment threads and prospects." },
  { id: "everyday/travel", title: "Travel", lead: "Fares, hotels, routes, itineraries and entry rules." },
  { id: "everyday/vehicles", title: "Vehicles", lead: "Warning codes, bike wear and recalls." },
  { id: "everyday/life-admin", title: "Life admin", lead: "Morning briefs, meetings, inboxes, folders and subscriptions." },
  { id: "everyday/learning", title: "Learning", lead: "Tutoring, languages, flashcards, roadmaps and exams." },
  { id: "everyday/health-and-fitness", title: "Health and fitness", lead: "Form checks, meals, sleep and supplements." },
  { id: "everyday/home-family-and-pets", title: "Home, family and pets", lead: "Rentals, energy, forms, carpools and pets." },
  { id: "everyday/hobbies-and-games", title: "Hobbies and games", lead: "Art, gardens, recipes, woodworking, writing and games." },
  {
    id: "everyday/knowledge-and-archives",
    title: "Knowledge and archives",
    lead: "Old letters, records, family trees, notes and bookmarks.",
  },
  { id: "everyday/friends-and-culture", title: "Friends and culture", lead: "Recommendations, tour dates and keeping in touch." },
];

/** A step's key: its title in lower case, every run of other characters a hyphen. */
export function stepKey(title) {
  return title
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The images in a block of Markdown: `![alt](src)` and `<picture>`'s `<img>` (with its dark `<source>`). */
function imagesIn(text) {
  const images = [];
  for (const match of text.matchAll(/<picture>([\s\S]*?)<\/picture>/g)) {
    const dark = /<source[^>]*srcset="([^"]+)"/.exec(match[1])?.[1];
    const img = /<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/.exec(match[1]);
    if (img !== null) images.push({ src: img[1], alt: img[2], ...(dark === undefined ? {} : { dark }) });
  }
  const outside = text.replace(/<picture>[\s\S]*?<\/picture>/g, "");
  for (const match of outside.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) images.push({ src: match[2], alt: match[1] });
  return images;
}

/**
 * A guide page, read: `{ file, folder, slug, title, lead, context, steps,
 * sections, cover }`. `context` maps each bold label of the blockquote under
 * the lead (**Uses:**, **Before you start:**, …) to its text; each step is
 * `{ number, title, key, body, images }`; `sections` are the `##` headings that
 * are not steps, in order; `cover` is the image marked `<!-- cover -->`, else
 * the last step's.
 */
export function readGuide(file) {
  const text = readFileSync(file, "utf8");
  const folder = relative(guidesRoot, dirname(file)).split("\\").join("/");
  const slug = basename(file, ".md");
  const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const [head, ...blocks] = text.split(/^## /m);
  const afterTitle = head.replace(/^# .+$/m, "");
  const lead = afterTitle
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "" && !paragraph.startsWith(">"))
    .join("\n\n");
  const context = {};
  for (const line of afterTitle.split("\n")) {
    const match = /^>\s*\*\*([^*]+?):\*\*\s*(.*)$/.exec(line.trim());
    if (match !== null) context[match[1]] = match[2].trim();
  }
  const steps = [];
  const sections = [];
  let cover;
  for (const block of blocks) {
    const [heading, ...rest] = block.split("\n");
    const body = rest.join("\n");
    const step = /^(\d+)\. (.+)$/.exec(heading.trim());
    if (step === null) {
      sections.push(heading.trim());
      continue;
    }
    const images = imagesIn(body);
    if (/<!--\s*cover\s*-->/.test(body) && images[0] !== undefined) cover = images[0];
    steps.push({
      number: Number(step[1]),
      title: step[2].trim(),
      key: stepKey(step[2]),
      body: body
        .replace(/<picture>[\s\S]*?<\/picture>/g, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim(),
      images,
    });
  }
  cover ??= steps.at(-1)?.images[0];
  return { file, folder, slug, title, lead, context, steps, sections, cover, text };
}

/** Every guide page under docs/use-cases/, by folder (indexes and templates are not guides). */
export function listGuides() {
  const guides = [];
  for (const { id } of FOLDERS) {
    const directory = join(guidesRoot, id);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".md") || name === "README.md" || name.startsWith("_")) continue;
      guides.push(readGuide(join(directory, name)));
    }
  }
  return guides;
}

/** Where a guide's step image lives, relative to the repository: `docs/assets/use-cases/<folder>/<slug>/NN-<key>.<ext>`. */
export function stepImagePath(guide, step, extension) {
  const number = String(step.number).padStart(2, "0");
  return `docs/assets/use-cases/${guide.folder}/${guide.slug}/${number}-${step.key}.${extension}`;
}

const GENERATED = "<!-- Generated by scripts/docs/guide-indexes.mjs from the guides: edit the guides, not this file. -->";

/** A guide's lead cut to its first sentence, for an index line. */
function firstSentence(lead) {
  const flat = lead.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/** The cover image as an index shows it, relative to the index's own folder. */
function coverCell(guide, indexDirectory) {
  if (guide.cover === undefined) return "";
  const absolute = join(dirname(guide.file), guide.cover.src);
  const src = relative(indexDirectory, absolute).split("\\").join("/");
  const alt = guide.cover.alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<img src="${src}" alt="${alt}" width="240">`;
}

/**
 * Every index the guides need, as `{ path, text }` (repository-relative): the
 * hub `docs/use-cases/README.md`, `everyday/README.md` once a recipe exists, and
 * one `README.md` per folder that holds a guide.
 */
export function indexes(guides = listGuides()) {
  const byFolder = new Map();
  for (const guide of guides) byFolder.set(guide.folder, [...(byFolder.get(guide.folder) ?? []), guide]);
  const filled = FOLDERS.filter((folder) => byFolder.has(folder.id));
  const out = [];
  for (const folder of filled) {
    const directory = join(guidesRoot, folder.id);
    const rows = byFolder
      .get(folder.id)
      .map((guide) => `| ${coverCell(guide, directory)} | [${guide.title}](${guide.slug}.md)<br>${firstSentence(guide.lead)} |`);
    out.push({
      path: `docs/use-cases/${folder.id}/README.md`,
      text: [
        GENERATED,
        "",
        `# ${folder.title}`,
        "",
        folder.lead,
        "",
        "| | Guide |",
        "| :--- | :--- |",
        ...rows,
        "",
        folder.id.startsWith("everyday/") ? "[All everyday recipes](../README.md)" : "[All how-to guides](../README.md)",
        "",
      ].join("\n"),
    });
  }
  const everyday = filled.filter((folder) => folder.id.startsWith("everyday/"));
  const count = (folder) => byFolder.get(folder.id).length;
  if (everyday.length > 0) {
    out.push({
      path: "docs/use-cases/everyday/README.md",
      text: [
        GENERATED,
        "",
        "# Everyday recipes",
        "",
        "One page for each idea Tavi offers in **Ideas**: what to ask, what it uses, what to set up first, and what you get.",
        "",
        ...everyday.map(
          (folder) => `- [${folder.title}](${folder.id.slice("everyday/".length)}/README.md) — ${folder.lead} (${count(folder)})`,
        ),
        "",
        "[All how-to guides](../README.md)",
        "",
      ].join("\n"),
    });
  }
  const capability = filled.filter((folder) => !folder.id.startsWith("everyday/"));
  const recipes = guides.filter((guide) => guide.folder.startsWith("everyday/")).length;
  out.push({
    path: "docs/use-cases/README.md",
    text: [
      GENERATED,
      "",
      "# How-to guides",
      "",
      "Short, illustrated guides, one task each, in the order the product asks for things. Every step shows the real screen, taken from Tavi itself by the guide's own walk (`pnpm test:guides`). For the reference behind each guide, follow its **Related** links.",
      "",
      ...capability.map((folder) => `- [${folder.title}](${folder.id}/README.md) — ${folder.lead} (${count(folder)})`),
      ...(recipes > 0 ? [`- [Everyday recipes](everyday/README.md) — One page for each idea in **Ideas**. (${recipes})`] : []),
      "",
    ].join("\n"),
  });
  return out;
}
