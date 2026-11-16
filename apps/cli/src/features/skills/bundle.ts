/**
 * An Agent Skills package (`SKILL.md` with YAML frontmatter, and its
 * `references/`, `scripts/` and other files) read for `tavi skills import`:
 * from a folder, a lone `SKILL.md`, or a `.zip`. Strict: no symbolic link,
 * no absolute path or `..`, at most 32 files and 512 KiB in all (a `.zip` at
 * most 1 MiB), each sized from its stat before it is read and read no further
 * than what is left. The files are stored as one deterministic bundle (`skillBundleText`); a script is
 * kept as text to read, never run — Tavi installs nothing and runs no hook.
 */
import { closeSync, fstatSync, lstatSync, readSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { openNoFollowSync } from "@tavi/node-kit";

import {
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_FILE_PATH_CHARS,
  MAX_SKILL_PACKAGE_BYTES,
  TaviError,
  skillBundleText,
  type SkillBundleFile,
} from "@tavi/contracts";

import { unzipBundle } from "../mcp/mcpb.js";

/** What a package's frontmatter declares, and its files as a bundle's stored text. */
export interface AgentSkillPackage {
  readonly skillId: string;
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly allowedTools?: readonly string[];
  readonly compatibility?: string;
  readonly files: readonly string[];
  /** The bundle as stored: `skillBundleText` of its files. */
  readonly text: string;
}

const refuse = (why: string): never => {
  throw new TaviError("INVALID_INPUT", `not an Agent Skills package Tavi imports: ${why}`);
};

/**
 * A zip's own size cap, read before the zip is: the package's 512 KiB plus room for
 * its headers, folder entries and what macOS adds (`__MACOSX/` holds a resource file
 * per file). What it unpacks to is held to the package's bytes by `unzipBundle`.
 */
const MAX_SKILL_ZIP_BYTES = 2 * MAX_SKILL_PACKAGE_BYTES;

/**
 * A regular file's bytes, at most `limit`: its size is checked from the open descriptor
 * before a byte is read, and the read stops one past `limit`, so a file that grows
 * after its stat is refused rather than read whole. The open follows no link (one swapped
 * in after the walk's `lstat` is refused, not read through) and does not block on a FIFO,
 * which `fstat` then refuses as not a file.
 */
function readBounded(path: string, label: string, limit: number, over: string): Buffer {
  let fd: number;
  try {
    fd = openNoFollowSync(path, "read");
  } catch (error) {
    // ELOOP on Linux and macOS, EMLINK on FreeBSD.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") refuse(`${label} is a symbolic link`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) refuse(`${label} is not a file`);
    if (stat.size > limit) refuse(over);
    // Read to the end, a file that grew included, but never more than one byte past `limit`.
    let buffer = Buffer.alloc(Math.min(stat.size, limit) + 1);
    let length = 0;
    for (;;) {
      if (length === buffer.length) {
        if (length > limit) refuse(over);
        const grown = Buffer.alloc(Math.min(buffer.length * 2, limit + 1));
        buffer.copy(grown);
        buffer = grown;
      }
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

const OVER_PACKAGE = `it is over ${MAX_SKILL_PACKAGE_BYTES / 1024} KiB`;

/** A path inside the package: relative, `/`-separated, with no `..`, drive, backslash or NUL. */
function safePath(path: string): string {
  if (path === "" || path.length > MAX_SKILL_FILE_PATH_CHARS || /[\\\0]/.test(path) || path.startsWith("/") || /^[a-zA-Z]:/.test(path))
    refuse(`the path ${JSON.stringify(path.slice(0, 80))} is not inside it`);
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    refuse(`the path ${JSON.stringify(path.slice(0, 80))} climbs out`);
  return parts.join("/");
}

/**
 * A folder's files, walked without following a link: a symbolic link anywhere is refused.
 * The bytes read so far are a running total, and each file is sized before it is read
 * against what the package has left, so an oversized package fails before a large read.
 */
function folderFiles(root: string): { path: string; data: Buffer }[] {
  const files: { path: string; data: Buffer }[] = [];
  let total = 0;
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder).sort()) {
      if (entry === ".DS_Store" || entry === ".git") continue;
      const full = join(folder, entry);
      const stat = lstatSync(full);
      const path = prefix === "" ? entry : `${prefix}/${entry}`;
      if (stat?.isSymbolicLink() === true) refuse(`${path} is a symbolic link`);
      if (stat.isDirectory()) walk(full, path);
      else if (stat.isFile()) {
        if (files.length >= MAX_SKILL_BUNDLE_FILES) refuse(`it holds more than ${MAX_SKILL_BUNDLE_FILES} files`);
        const safe = safePath(path);
        const data = readBounded(full, path, MAX_SKILL_PACKAGE_BYTES - total, OVER_PACKAGE);
        total += data.length;
        files.push({ path: safe, data });
      } else refuse(`${path} is not a file`);
    }
  };
  walk(root, "");
  return files;
}

/** The files of a zip whose `SKILL.md` may sit in one top folder: that folder becomes the package's root. */
function zipFiles(zip: Buffer): { path: string; data: Buffer }[] {
  const read = unzipBundle(zip, { maxFiles: MAX_SKILL_BUNDLE_FILES, maxDirectories: 16, maxDepth: 4, maxBytes: MAX_SKILL_PACKAGE_BYTES });
  // An executable bit is dropped: every file is kept as text or bytes to read, and nothing here is ever run.
  // What macOS adds to a zip it makes (`__MACOSX/`, `.DS_Store`) is no file of the package.
  const files = read
    .filter((file) => !file.path.startsWith("__MACOSX/") && !/(^|\/)\.DS_Store$/.test(file.path))
    .map((file) => ({ path: safePath(file.path), data: file.data }));
  if (files.some((file) => file.path === "SKILL.md")) return files;
  const tops = new Set(files.map((file) => file.path.split("/")[0]));
  const [top] = [...tops];
  if (tops.size === 1 && top !== undefined && files.some((file) => file.path === `${top}/SKILL.md`))
    return files.map((file) => ({ path: file.path.slice(top.length + 1), data: file.data }));
  return files;
}

/** The frontmatter between the opening and closing `---` lines, read as the YAML subset a SKILL.md uses. */
export function skillFrontmatter(text: string): Readonly<Record<string, unknown>> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) refuse("SKILL.md has no frontmatter (a --- block naming the skill)");
  const lines = (match?.[1] ?? "").split(/\r?\n/);
  const root: Record<string, unknown> = {};
  let section: Record<string, unknown> | undefined;
  let list: string[] | undefined;
  const scalar = (raw: string): string => {
    const value = raw.trim();
    return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item !== null && list !== undefined) {
      list.push(scalar(item[1] ?? ""));
      continue;
    }
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested !== null && section !== undefined) {
      section[nested[1] ?? ""] = scalar(nested[2] ?? "");
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top === null) refuse(`SKILL.md's frontmatter line ${JSON.stringify(line.slice(0, 60))} is not a key`);
    const key = top?.[1] ?? "";
    const value = top?.[2] ?? "";
    const block = /^([>|])[+-]?\s*$/.exec(value);
    if (block !== null) {
      // A block (`description: >-` then indented lines): folded into one line with `>`, kept as lines with `|`.
      const held: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1] ?? "") || (lines[index + 1] ?? "").trim() === "")) {
        index += 1;
        held.push((lines[index] ?? "").trim());
      }
      while (held.at(-1) === "") held.pop();
      section = undefined;
      list = undefined;
      root[key] = block[1] === ">" ? held.filter((part) => part !== "").join(" ") : held.join("\n");
    } else if (value.trim() === "") {
      // A section (`metadata:`) or a list (`allowed-tools:` then `- Read` lines) follows.
      section = {};
      list = [];
      root[key] = { section, list };
    } else {
      section = undefined;
      list = undefined;
      root[key] = scalar(value);
    }
  }
  // A key that held a list keeps its list; one that held a section, its section.
  for (const [key, value] of Object.entries(root)) {
    if (typeof value === "object" && value !== null && "list" in value) {
      const { section: held, list: items } = value as { section: Record<string, unknown>; list: string[] };
      root[key] = items.length > 0 ? items : held;
    }
  }
  return root;
}

/** `allowed-tools` as a list: written as a list, or as one comma- or space-separated line (`Read, Bash(git:*)`). */
function allowedToolsOf(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter((tool) => tool !== "");
  if (typeof value !== "string" || value.trim() === "") return undefined;
  // A flow list (`[Read, Grep]`) is the same list without its brackets.
  const line = /^\s*\[(.*)\]\s*$/.exec(value)?.[1] ?? value;
  return (line.match(/[^\s,()]+(?:\([^)]*\))?/g) ?? []).filter((tool) => tool !== "");
}

/** Reads an Agent Skills package at `path`: a folder, a lone `SKILL.md`, or a `.zip`. */
export function readAgentSkillPackage(path: string): AgentSkillPackage {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return refuse(`no such folder, SKILL.md or .zip: ${path}`);
  if (stat.isSymbolicLink()) refuse(`${path} is a symbolic link`);
  const raw = stat.isDirectory()
    ? folderFiles(path)
    : path.toLowerCase().endsWith(".zip")
      ? zipFiles(readBounded(path, path, MAX_SKILL_ZIP_BYTES, `the zip is over ${MAX_SKILL_ZIP_BYTES / 1024} KiB`))
      : basename(path) === "SKILL.md"
        ? [{ path: "SKILL.md", data: readBounded(path, path, MAX_SKILL_PACKAGE_BYTES, OVER_PACKAGE) }]
        : refuse("give a folder holding SKILL.md, a SKILL.md, or a .zip of one");
  if (raw.length > MAX_SKILL_BUNDLE_FILES) refuse(`it holds more than ${MAX_SKILL_BUNDLE_FILES} files`);
  const main = raw.find((file) => file.path === "SKILL.md");
  if (main === undefined) refuse("it has no SKILL.md at its root");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: SkillBundleFile[] = raw.map((file) => {
    try {
      return { path: file.path, text: decoder.decode(file.data) };
    } catch {
      return { path: file.path, base64: file.data.toString("base64") };
    }
  });
  const skillText = files.find((file) => file.path === "SKILL.md")?.text;
  if (skillText === undefined) refuse("SKILL.md is not UTF-8 text");
  const front = skillFrontmatter(skillText ?? "");
  const name = typeof front["name"] === "string" ? front["name"] : refuse("SKILL.md's frontmatter has no name");
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(name))
    refuse(`its name ${JSON.stringify(name.slice(0, 60))} is not a skill id (lower case, digits and hyphens)`);
  const metadata =
    typeof front["metadata"] === "object" && front["metadata"] !== null ? (front["metadata"] as Record<string, unknown>) : {};
  const version =
    typeof metadata["version"] === "string" ? metadata["version"] : typeof front["version"] === "string" ? front["version"] : undefined;
  const allowedTools = allowedToolsOf(front["allowed-tools"]);
  const text = skillBundleText(files);
  // The raw bytes were held to the cap as they were read; the stored text (escaped, a binary file as base64) is held here.
  if (Buffer.byteLength(text) > MAX_SKILL_PACKAGE_BYTES) refuse(OVER_PACKAGE);
  return {
    skillId: name,
    name,
    ...(typeof front["description"] === "string" ? { description: front["description"].slice(0, 2000) } : {}),
    ...(version === undefined ? {} : { version }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(typeof front["compatibility"] === "string" ? { compatibility: front["compatibility"].slice(0, 500) } : {}),
    files: [
      "SKILL.md",
      ...files
        .map((file) => file.path)
        .filter((file) => file !== "SKILL.md")
        .sort(),
    ],
    text,
  };
}
