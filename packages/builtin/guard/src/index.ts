import { realpathSync } from "node:fs";
import { posix } from "node:path";

import type { ModHookInput, ModHookResult, ModNext } from "@tavi/contracts";

export { GUARD_MODS, GUARD_PLUGIN_ID } from "./manifest.js";

/** One command of a line, as words, and the folder it runs in. */
interface Segment {
  readonly words: readonly string[];
  readonly cwd: string;
}

/** A `sandbox.run` call's command line: as it runs (`line`), without its quoted text and heredoc bodies (`bare`), and where. */
interface Line {
  readonly line: string;
  readonly bare: string;
  readonly cwd: string;
}

/**
 * Where the call runs, as `sandbox.run` resolves it, relative to the chat's
 * working folder (`.`): a relative `cwd` within it, an absolute one as it is.
 * A hook sees the folder by label only, so paths stay as relative as they
 * were given; the sandbox keeps a call inside the folder whatever it names.
 */
function workingFolder(cwd: unknown): string {
  return typeof cwd === "string" && cwd !== "" ? posix.normalize(cwd) : ".";
}

/** `path` from the folder `cwd`: relative stays relative to the working folder, absolute stays absolute. */
function fromFolder(cwd: string, path: string): string {
  return posix.isAbsolute(path) ? posix.normalize(path) : posix.join(cwd, path);
}

function lineOf(input: unknown): Line | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const call = input as { readonly command?: unknown; readonly args?: unknown; readonly cwd?: unknown };
  if (typeof call.command !== "string") return undefined;
  const args = Array.isArray(call.args) ? call.args.filter((arg): arg is string => typeof arg === "string") : [];
  // Each word on its own: the sandbox quotes every one, so a quote never pairs across them.
  // A backslash at a line's end joins it to the next: one command, not two.
  const parts = [call.command, ...args].map((part) => part.replace(/\\\r?\n/g, " "));
  // A heredoc's body is judged unless only text readers read it (`cat <<EOF`); its `>` redirects nothing unless a shell runs it.
  const raw = parts.map((part) => withoutHeredocs(part, "commands")).join(" ");
  const bare = parts.map((part) => unquoted(withoutHeredocs(part, "redirects"))).join(" ");
  return { line: raw.replace(/["'\\]/g, ""), bare, cwd: workingFolder(call.cwd) };
}

/**
 * What a redirect is read from: a quoted span keeps its text as one word,
 * without the characters that would redirect or cut a line — so a `>` inside
 * quotes redirects nothing, and `> "notes.md"` still names `notes.md`.
 */
function unquoted(text: string): string {
  // Its spaces kept as SPACE (shown again as spaces), and a space after it: `"key=">config.txt` is no arrow (`=>`).
  return text.replace(
    /'([^']*)'|"((?:[^"\\]|\\.)*)"/g,
    (_match, single: string | undefined, double: string | undefined) =>
      `${
        (single ?? double ?? "")
          .replace(/\\(.)/g, "$1")
          .replace(/[<>&|;()`]/g, "")
          .replace(/\s/g, SPACE) || "_"
      } `,
  );
}

/** A space inside a quoted word, while redirects are read: no word break. */
const SPACE = "\u0001";

/**
 * A line without its comment: from an unquoted `#` that starts a word,
 * which the shell reads as the rest of the line — so a `<<` after it opens no
 * heredoc.
 */
function uncommented(line: string): string {
  let quote: "'" | '"' | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quote === undefined && char === "\\") {
      at += 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === "\\") at += 1;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    // A word starts after whitespace, or after what cuts a command (`;#`, `&#`, `)#`).
    else if (char === "#" && (at === 0 || /[\s;&|()]/.test(line[at - 1] ?? ""))) return line.slice(0, at);
  }
  return line;
}

/** Commands that run what they read as a shell: a heredoc fed to one is commands, redirects and all (`bash <<EOF`, `cat <<EOF | sh`, `ssh host <<EOF`). */
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "ssh",
  "sudo",
  "su",
  "doas",
  "eval",
  "source",
  "xargs",
  "env",
  "nohup",
  "exec",
  "script",
]);
/** Commands that only read or print text: a heredoc only they read is text, judged for nothing. */
const TEXT_READERS = new Set([
  "cat",
  "tee",
  "head",
  "tail",
  "wc",
  "grep",
  "sort",
  "uniq",
  "less",
  "more",
  "tr",
  "cut",
  "nl",
  "fold",
  "column",
]);

/**
 * The heredocs a line opens, in order: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`
 * and `<<\EOF` — not a `<<` inside quotes, `$((…))` or a comment, nor one an
 * escape takes (`\<<EOF`), nor a `<<<` here-string.
 */
function heredocsOf(line: string): readonly { readonly delimiter: string; readonly tabs: boolean }[] {
  const opened: { delimiter: string; tabs: boolean }[] = [];
  for (const match of uncommented(line).matchAll(
    /'[^']*'|"(?:[^"\\]|\\.)*"|\$\(\([^)]*\)\)|\\.|(?<!<)<<(?!<)(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([\w.-]+))/g,
  )) {
    const delimiter = match[2] ?? match[3] ?? match[4];
    if (delimiter !== undefined) opened.push({ delimiter, tabs: match[1] === "-" });
  }
  return opened;
}

/**
 * A command line without the heredoc bodies it need not judge: from the line
 * after a `<<` marker through the delimiter's own line (tabs before it taken
 * off for `<<-`), so the commands after the delimiter are still judged. For
 * `commands`, a body is dropped only when every command on its marker line is
 * a text reader (`cat <<EOF`): a program's body (`psql`, `python3 -`) may run
 * what it holds. For `redirects`, it is kept only when a shell runs it, as a
 * `>` elsewhere is no redirect (`if x > 0:`). A body with no delimiter line is
 * kept.
 */
function withoutHeredocs(text: string, judged: "commands" | "redirects"): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const current = lines[at] ?? "";
    kept.push(current);
    const plain = current.replace(/["'\\]/g, "");
    const words = plain.split(/[\s;&|()]+/);
    if (words.some((word) => SHELLS.has(commandName(word)))) continue;
    const commands = plain
      .split(/;|&&|\|\||\||&/)
      .map((part) => commandName(part.trim().split(/\s+/)[0]))
      .filter((name) => name !== "");
    if (judged === "commands" && !commands.every((name) => TEXT_READERS.has(name))) continue;
    let next = at + 1;
    for (const { delimiter, tabs } of heredocsOf(current)) {
      const end = lines.findIndex(
        (body, index) => index >= next && (tabs ? body.replace(/^\t+/, "") : body).replace(/\r$/, "") === delimiter,
      );
      if (end === -1) break;
      next = end + 1;
    }
    at = next - 1;
  }
  return kept.join("\n");
}

/**
 * The commands a `sandbox.run` call runs, as words. Quotes and backslashes are
 * taken off, not their text — `sh -c 'rm -rf build'` runs what it quotes, and
 * `\rm` and `r''m` are `rm` — and a line is cut at `;`, `&&`, `||`, `|`, `&`,
 * newlines, backticks and `$(`, with parentheses read as spaces, so each
 * command, a substituted or subshell one too, is judged alone. `cd`
 * moves the folder the commands after it run in.
 */
function segmentsOf(line: Line): readonly Segment[] {
  let cwd = line.cwd;
  const segments: Segment[] = [];
  for (const part of line.line.split(/;|&&|\|\||\||&(?!>)|\n|\r|`|\$\(|[<>]\(/)) {
    const words = part
      .replace(/[()]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((word) => word !== "");
    if (words.length === 0) continue;
    if (commandName(words[0]) === "cd" && words[1] !== undefined) {
      cwd = fromFolder(cwd, words[1]);
      continue;
    }
    segments.push({ words, cwd });
  }
  return segments;
}

/**
 * The files a line's redirects overwrite: `>`, `>|`, `N>` and `&>` onto a
 * path, read from the line without its quoted text — not `>>`, which appends,
 * nor `N>&M`, `/dev/null`, or an arrow (`->`, `=>`).
 */
function redirectTargets(bare: string): readonly string[] {
  const targets: string[] = [];
  for (const match of bare.matchAll(/(?:^|[^\-=<>&\d])(?:\d+|&)?>\|?(?![>&])\s*([^\s&|;<>()]+)/g)) {
    const target = match[1];
    if (target !== undefined && target !== "/dev/null") targets.push(target.replaceAll(SPACE, " "));
  }
  return targets;
}

/** A command word's name, without its folder: `/bin/rm` is `rm`. */
function commandName(word: string | undefined): string {
  return word === undefined ? "" : word.slice(word.lastIndexOf("/") + 1);
}

/** The short flags a command's words set, `-Rf` and `-d -f` alike, lower-cased, and its long ones. */
function flagsOf(words: readonly string[]): { readonly short: ReadonlySet<string>; readonly long: ReadonlySet<string> } {
  const short = new Set<string>();
  const long = new Set<string>();
  for (const word of words) {
    if (word.startsWith("--")) long.add(word);
    else if (word.startsWith("-") && word.length > 1) for (const letter of word.slice(1)) short.add(letter.toLowerCase());
  }
  return { short, long };
}

/** The operands of a command: its words after the name that are not flags (nor `find`'s `{}`). */
function operandsOf(words: readonly string[], from: number): readonly string[] {
  return words.slice(from).filter((word) => !word.startsWith("-") && word !== "{}");
}

/** Commands run by another (`sudo rm …`, `xargs rm …`, `sh -c rm …`, `find -exec rm …`), and the shell's words a command follows (`then rm`, `! find`, `{ find`). */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "xargs",
  "nohup",
  "nice",
  "time",
  "command",
  "exec",
  "timeout",
  "stdbuf",
  "ionice",
  "setsid",
  "-c",
  "-exec",
  "-execdir",
  "-ok",
  "if",
  "while",
  "until",
  "then",
  "do",
  "else",
  "elif",
  "!",
  "{",
]);
/** Wrappers that take one word before the command they run (`flock /tmp/lock find …`, `chroot /mnt find …`). */
const POSITIONAL_WRAPPERS = new Set(["flock", "chroot"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Whether the word at `index` is where a command starts: the first word
 * after any `NAME=value` assignments, or one a wrapper or a shell word runs —
 * past the wrapper's options and their values (`nice -n 5 find`, `sudo -u root
 * find`, `timeout 5 find`).
 */
function startsCommand(words: readonly string[], index: number): boolean {
  if (words.slice(0, index).every((word) => ASSIGNMENT.test(word))) return true;
  for (let at = index - 1; at >= 0; at -= 1) {
    const word = words[at] ?? "";
    if (WRAPPERS.has(commandName(word))) return true;
    // A shell's `-c` among other flags: `bash -lc`, `sh -ec`.
    if (/^-[a-z]*c[a-z]*$/.test(word) && at > 0 && SHELLS.has(commandName(words[at - 1]))) return true;
    if (at > 0 && POSITIONAL_WRAPPERS.has(commandName(words[at - 1])) && !word.startsWith("-")) return true;
    const option = word.startsWith("-") || ASSIGNMENT.test(word) || /^\d+(\.\d+)?[smhd]?$/.test(word);
    const optionValue = at > 0 && (words[at - 1] ?? "").startsWith("-") && !(words[at - 1] ?? "").includes("=");
    if (!option && !optionValue) return false;
  }
  return false;
}
/** Words that are the guard's commands wherever they stand; `find` and `truncate` only as a command, since they are common words too. */
const ANYWHERE = new Set(["rm", "git", "chmod", "dd"]);
const AS_COMMAND = new Set(["find", "truncate"]);

/** What one command would do that the guard asks about, and the paths it would touch. */
function destructive(segment: Segment): { readonly does: string; readonly paths: readonly string[] } | undefined {
  const { words } = segment;
  // Printed, not run.
  const name = commandName(words[0]);
  if (name === "echo" || name === "printf") return undefined;
  if (/\bdrop\s+(table|database|schema)\b/i.test(words.join(" "))) return { does: "drops database objects", paths: [] };
  // Every place a command of the guard's may start: the first word, and a word a wrapper runs.
  for (const [index, word] of words.entries()) {
    const command = commandName(word).split(".")[0] ?? "";
    const isCommand = startsCommand(words, index);
    if (!(ANYWHERE.has(command) || command.startsWith("mkfs") || (AS_COMMAND.has(command) && isCommand))) continue;
    const hit = ruleOf(words.slice(index));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The guard's rule for one command's own words, from its name. */
function ruleOf(own: readonly string[]): { readonly does: string; readonly paths: readonly string[] } | undefined {
  const command = commandName(own[0]);
  const flags = flagsOf(own.slice(1));
  if (command === "rm" && (flags.short.has("r") || flags.long.has("--recursive")) && (flags.short.has("f") || flags.long.has("--force"))) {
    return { does: "deletes files and folders recursively", paths: operandsOf(own, 1) };
  }
  if (command === "git") return gitRuleOf(own);
  if (command === "chmod" && (flags.short.has("r") || flags.long.has("--recursive")) && own.some((word) => /^0?777$/.test(word)))
    return { does: "opens every file to everyone", paths: operandsOf(own, 1).filter((word) => !/^0?777$/.test(word)) };
  if (command === "dd") {
    const target = own.find((word) => word.startsWith("of="));
    if (target !== undefined) return { does: "overwrites a file or device", paths: [target.slice("of=".length)] };
  }
  if (command.startsWith("mkfs")) return { does: "formats a disk", paths: operandsOf(own, 1) };
  if (command === "find" && own.includes("-delete")) {
    // The folders it searches: its operands before the first expression.
    const start = own.slice(1);
    const until = start.findIndex((word) => word.startsWith("-") || word === "!");
    return { does: "deletes the files it finds", paths: until === -1 ? start : start.slice(0, until) };
  }
  if (command === "truncate")
    return {
      does: "cuts files short",
      paths: own.slice(1).filter((word, at, rest) => !word.startsWith("-") && !(rest[at - 1] === "-s" || rest[at - 1] === "--size")),
    };
  return undefined;
}

/** git's global options that take the next word as their value (`git -C dir …`), unless given as `--opt=value`. */
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--attr-source", "--config-env", "--super-prefix"]);

/**
 * The guard's rule for a `git` command: its subcommand is the first word after
 * git's global options (`git -C dir reset --hard`, `git -c k=v clean -fdx`), and
 * its operands are reached from any `-C` folder. Only `git clean` has a dry run
 * (`-n`, `--dry-run`), and it deletes nothing; a `--dry-run` elsewhere is not
 * one — `rm` reads it as a file once an operand is given.
 */
function gitRuleOf(own: readonly string[]): { readonly does: string; readonly paths: readonly string[] } | undefined {
  let at = 1;
  let folder = "";
  while (own[at]?.startsWith("-") === true) {
    const option = own[at] ?? "";
    if (GIT_VALUED.has(option)) {
      const value = own[at + 1] ?? "";
      if (option === "-C") folder = fromFolder(folder, value);
      at += 2;
    } else at += 1;
  }
  // Its own flags: not a pattern an option takes (`-e -node`), nor a path after `--`.
  const rest = own.slice(at + 1);
  const end = rest.indexOf("--");
  const its = (end === -1 ? rest : rest.slice(0, end)).filter(
    (_word, index, words) => !(words[index - 1] === "-e" || words[index - 1] === "--exclude"),
  );
  const flags = flagsOf(its);
  if (own[at] === "reset" && flags.long.has("--hard")) return { does: "discards uncommitted work", paths: [] };
  if (own[at] !== "clean" || !(flags.short.has("f") || flags.long.has("--force"))) return undefined;
  if (flags.short.has("n") || flags.long.has("--dry-run")) return undefined;
  return { does: "deletes untracked files", paths: operandsOf(own, at + 1).map((path) => fromFolder(folder, path)) };
}

/**
 * A path as the reason names it: from the folder the command runs in, and
 * through symlinks only where it is absolute. A relative one is never
 * resolved here, since this process's own folder is not the chat's.
 */
function shownPath(path: string, cwd: string): string {
  const full = fromFolder(cwd, path);
  if (!posix.isAbsolute(full)) return full;
  try {
    return realpathSync(full);
  } catch {
    return full;
  }
}

/** The guard's answer for one `sandbox.run` call. */
export async function guardCheck(e: ModHookInput<"tool.check">, next: ModNext<"tool.check">): Promise<ModHookResult<"tool.check">> {
  const verdict = await next(e);
  const line = lineOf(e.input);
  if (line === undefined) return verdict;
  // A redirect overwrites its target, whatever prints into it (`echo x > notes.md`).
  const redirected = redirectTargets(line.bare);
  const hits = [
    ...(redirected.length === 0 ? [] : [{ hit: { does: "overwrites a file", paths: redirected }, cwd: line.cwd }]),
    ...segmentsOf(line).flatMap((segment) => {
      const hit = destructive(segment);
      return hit === undefined ? [] : [{ hit, cwd: segment.cwd }];
    }),
  ];
  for (const { hit, cwd } of hits) {
    const paths = hit.paths.slice(0, 5).map((path) => shownPath(path, cwd));
    const reason = `This command ${hit.does}${paths.length === 0 ? "" : `: ${paths.join(", ")}`}.`;
    // Where nobody can answer an ask, a schedule would approve it: refuse instead.
    return e.envelope.attended
      ? { decision: "ask", reason }
      : { decision: "deny", reason: `${reason} Nobody can approve it in this run, so the tavi.guard plugin refused it.` };
  }
  return verdict;
}
