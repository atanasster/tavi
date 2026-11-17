import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";

import {
  BROWSER_ACTION_KINDS,
  CHAT_FOLDER_PARENT_LABEL,
  desktopCommitShortcut,
  formSendCommits,
  browserActionNeedsRef,
  commitCategory,
  defaultDesktopAppGrantTier,
  desktopClickOnlyAllows,
  escapeGlob,
  type DesktopAppGrantTier,
  isBlockedDesktopApp,
  isDesktopAuthDialog,
  isDesktopCredentialNode,
  maxRisk,
  protectedFieldClass,
  protectedFieldRefusal,
  protectedValueClass,
  parseShellScript,
  readShellScript,
  SHELL_PARSE_DISAGREEMENT_REASON,
  shellParsesAgree,
  splitShellCommands,
  type BrowserActionKind,
  type BrowserStep,
  type CallAssessment,
  type ChatFolder,
  type CommitCategory,
  type InvocationContext,
  type ProtectedFieldClass,
  type RiskLevel,
  redactCredentialShapes,
  redactToolText,
  requestableSandboxDomain,
  SANDBOX_REQUEST_DOMAINS_MAX,
  UNPARSED_SUBJECT_PREFIX,
} from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";

import { sandboxArgv } from "../sandbox/command-line.js";
import { folderFileDetail, type FolderFileReading } from "../folders/promotion.js";

/**
 * Per-tool readings of one validated call for the approval gate.
 *
 * Each returns what a person is shown, the subjects rules match, the call's
 * risk with its reasons, and — for the few patterns no rule may lift — a hard
 * refusal. They are deterministic: a model cannot argue its way to a lower
 * risk, and an assessor that fails makes a call riskier, never safer (the
 * workflow's catch). Inputs arrive already validated by the tool's schema, so
 * the loose reads below only guard against a schema that later grows.
 */

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Shells whose `-c` body is itself a script the assessment reads (by program basename). */
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);

/** A shell word, by name, that a download may be piped into: the prefix allows the wrappers that still run it. */
const SHELL_WORD = String.raw`(?:(?:sudo|doas)(?:\s+(?:-[ugCDhpRrTU]\s+\S+|-\S+))*\s+|env(?:\s+(?:-\S+|[A-Za-z_]\w*=\S*))*\s+|(?:command|exec|nohup)\s+)*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)\b`;
/** A download command, optionally behind wrappers, as a substitution's or a process substitution's body. */
const DOWNLOAD = String.raw`\s*(?:\S*\/)?(?:curl|wget)\b`;

/**
 * The root or home as a delete names it: `/`, `~` or `$HOME` (`${HOME}` is
 * spelled `$HOME` first, `homeSpelled`), alone or with `/`, `/*` or `/.`.
 */
const ROOT_OR_HOME = String.raw`(?:\/(?:\*|\.)?|(?:~|\$HOME)(?:\/(?:\*|\.)?)?)\/?`;

/** `${HOME}` as `$HOME`, so the refusals read one spelling. */
const homeSpelled = (form: string): string => form.replace(/\$\{HOME\}/g, "$HOME");

/** Patterns refused outright, whatever a rule says. The sandbox would contain most of them; the refusal says so before it has to. */
const HARD_DENY: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    pattern: new RegExp(String.raw`\brm\s+(?:[^|;&]*\s)?(?:-[a-zA-Z]*[rR]|--recursive)[^|;&]*\s${ROOT_OR_HOME}(\s|$)`),
    reason: "deletes the root or home directory",
  },
  // `find ~ -delete`, `find / -depth -exec rm -rf {} +`: a delete with no test before it takes everything under its start.
  {
    pattern: new RegExp(
      String.raw`\bfind\s+(?:-[HLP]\s+)*${ROOT_OR_HOME}\s+(?:(?:-depth|-xdev|-mount|-(?:min|max)depth\s+\d+)\s+)*-(?:delete|(?:exec|execdir|ok|okdir)\s+(?:\S*\/)?rm)\b`,
    ),
    reason: "deletes the root or home directory",
  },
  { pattern: /:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*\}/, reason: "is a fork bomb" },
  // `curl x | sh`, `curl x | sudo -E bash`, `wget -qO- x | env /bin/sh`.
  { pattern: new RegExp(String.raw`\b(?:curl|wget)\b[^|]*\|\s*${SHELL_WORD}`), reason: "pipes a download into a shell" },
  // `bash -c "$(curl -fsSL x)"`, `eval "$(wget -qO- x)"`, and the backtick forms: the download is the script.
  {
    pattern: new RegExp(String.raw`(?:\b(?:sh|bash|zsh|dash|ksh)\b[^|;&]*?\s-[a-zA-Z]*c[a-zA-Z]*|\beval)\s+["']?(?:\$\(|\`)${DOWNLOAD}`),
    reason: "runs a download as a shell script",
  },
  // `bash <(curl x)`, `source <(curl x)`, `. <(wget -O- x)`.
  {
    pattern: new RegExp(String.raw`(?:\b(?:sh|bash|zsh|dash|ksh|source)\b|(?:^|[\s;&|(])\.)\s+(?:-\S+\s+)*<\(${DOWNLOAD}`),
    reason: "runs a download as a shell script",
  },
  { pattern: /\bmkfs(\.\w+)?\b|\bdd\s+[^|]*\bof=\/dev\//, reason: "writes a raw device" },
];

const RISKY: readonly { readonly pattern: RegExp; readonly risk: RiskLevel; readonly reason: string }[] = [
  { pattern: /^(sudo|doas|su|pkexec)\b/, risk: "critical", reason: "asks for elevated privileges" },
  { pattern: /^rm\b.*\s(?:-[a-zA-Z]*[rR]|--recursive(?:\s|$))/, risk: "high", reason: "deletes files recursively" },
  {
    pattern: /^find\b.*\s-(?:delete(?:\s|$)|(?:exec|execdir|ok|okdir)\s+(?:\S*\/)?(?:rm|shred|unlink|rmdir)(?:\s|$))/,
    risk: "high",
    reason: "deletes the files it finds",
  },
  { pattern: /^(rm|shred|truncate)\b/, risk: "medium", reason: "deletes or truncates files" },
  { pattern: /^(curl|wget|nc|ncat|ssh|scp|rsync)\b/, risk: "high", reason: "reaches the network" },
  { pattern: /^(chmod|chown|chgrp)\b/, risk: "medium", reason: "changes file permissions" },
  { pattern: /^(git\s+(push|reset\s+--hard|clean))\b/, risk: "high", reason: "rewrites or publishes repository state" },
  {
    // An interpreter given its program on the line: `-c`/`-e`, Node's `--eval`/`-p`/`--print`, Deno's `eval`, awk's `system()`.
    // Only among the interpreter's own options (with their values: `-W ignore`, `-r x`, `-I lib`, `-d k=v`), before a script
    // or module: `python3 -m pip install -e .` and `perl -MFile::Temp x.pl` run none.
    pattern:
      /^(?:python[\d.]*\s+(?:(?:-[WXQ]\s+\S+|-(?!m)[a-zA-Z]+)\s+)*-[a-zA-Z]*c(?=\s|$)|(?:ruby|perl|lua)\s+(?:(?:-[IrM]\s*\S+|-(?![IMr])[a-zA-Z]+)\s+)*-(?![IMr])[a-zA-Z]*[eE](?=\s|$)|php\s+(?:(?:-[dc]\s+\S+|-[a-zA-Z]+)\s+)*-r(?=\s|$)|(?:node|bun)\s+(?:(?:-r\s+\S+|--require\s+\S+|--[a-zA-Z-]+(?:=\S+)?|-[a-zA-Z]+)\s+)*(?:-[a-zA-Z]*[ep][a-zA-Z]*(?=\s|$)|--eval\b|--print\b)|deno\s+eval\b|g?awk\b.*\bsystem\s*\()/,
    risk: "medium",
    reason: "runs inline code",
  },
  // A package fetched and run on the spot: what runs is whatever the registry serves now.
  {
    pattern: /^(?:npx|bunx|uvx|pipx\s+run|(?:pnpm|yarn)\s+dlx|npm\s+(?:exec|x))\b/,
    risk: "medium",
    reason: "fetches and runs a package",
  },
  { pattern: /^(kill|pkill|killall)\b/, risk: "medium", reason: "stops processes" },
];

/**
 * The script a shell's arguments give it with `-c`: the first operand after
 * its options, where `-c` may be bundled (`-lc`, `-ce`) and `-o`/`+o`,
 * `--rcfile` and `--init-file` take a value. `undefined` without `-c`.
 */
function shellScriptArg(args: readonly string[]): string | undefined {
  let index = 0;
  let hasC = false;
  while (index < args.length && /^[-+]./.test(args[index]!)) {
    const word = args[index]!;
    index += 1;
    if (word === "--") break;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) hasC = true;
    if (/^[-+][oO]$|^--(?:rcfile|init-file)$/.test(word)) index += 1;
  }
  return hasC ? args[index] : undefined;
}

/** How much of `stdin` an approval card shows. */
const STDIN_SHOWN_CHARS = 2_000;

/**
 * Programs that only read and print, and the options each may be given
 * while staying that way. Options are allowed by name, never refused by name:
 * a program that takes long options abbreviated (`sort --compress-prog`) or
 * one this list does not know is not read-only. `short` lists the letters a
 * short option or cluster may use (`*` any: the program has none that
 * writes, runs another program or reaches out); `long` the long options
 * (`*` any, for the same reason).
 */
const READ_ONLY_PROGRAMS: Readonly<Record<string, { readonly short: string; readonly long: readonly string[] | "*" }>> = {
  ls: { short: "*", long: "*" },
  cat: { short: "*", long: [] },
  head: { short: "nc", long: [] },
  tail: { short: "nc", long: [] },
  wc: { short: "lwcm", long: [] },
  stat: { short: "Lf", long: [] },
  file: { short: "biLzkhN", long: [] },
  pwd: { short: "LP", long: [] },
  echo: { short: "neE", long: [] },
  printf: { short: "", long: [] },
  which: { short: "a", long: [] },
  du: { short: "shacdHkm", long: [] },
  df: { short: "hkiPT", long: [] },
  cut: { short: "dfcbs", long: [] },
  tr: { short: "dscC", long: [] },
  diff: { short: "uqrNwbiBy", long: ["--brief", "--recursive", "--unified", "--ignore-all-space", "--stat"] },
  cmp: { short: "ls", long: [] },
  jq: { short: "rcSesn", long: ["--raw-output", "--compact-output", "--sort-keys", "--slurp", "--tab", "--null-input"] },
  basename: { short: "", long: [] },
  dirname: { short: "", long: [] },
  realpath: { short: "", long: [] },
  uname: { short: "asnrvmpo", long: [] },
  id: { short: "ugnG", long: [] },
  whoami: { short: "", long: [] },
  date: { short: "uIR", long: [] },
  true: { short: "", long: [] },
  false: { short: "", long: [] },
  nl: { short: "ba", long: [] },
  rev: { short: "", long: [] },
  grep: {
    short: "rRnicvlLwxEFhHosqAB0-9",
    long: [
      "--color",
      "--include",
      "--exclude",
      "--exclude-dir",
      "--line-number",
      "--recursive",
      "--ignore-case",
      "--count",
      "--files-with-matches",
      "--word-regexp",
      "--fixed-strings",
      "--extended-regexp",
      "--context",
      "--after-context",
      "--before-context",
      "--max-count",
      "--only-matching",
      "--invert-match",
      "--no-filename",
      "--with-filename",
    ],
  },
  egrep: { short: "rRnicvlLwxhHosqAB0-9", long: [] },
  fgrep: { short: "rRnicvlLwxhHosqAB0-9", long: [] },
  uniq: { short: "cdui", long: [] },
  sort: { short: "bdfgnrRuVhkMt", long: [] },
  tree: { short: "adfilLsDughCFPI", long: [] },
  rg: {
    short: "nNiIsSwvlcCABAFUeEgtTuL0-9",
    long: [
      "--files",
      "--hidden",
      "--no-ignore",
      "--glob",
      "--type",
      "--type-not",
      "--line-number",
      "--no-heading",
      "--heading",
      "--color",
      "--count",
      "--files-with-matches",
      "--ignore-case",
      "--smart-case",
      "--fixed-strings",
      "--word-regexp",
      "--context",
      "--after-context",
      "--before-context",
      "--max-count",
      "--max-depth",
      "--follow",
      "--json",
      "--stats",
      "--type-list",
      "--column",
      "--only-matching",
      "--multiline",
    ],
  },
  find: { short: "HLP", long: [] },
  git: { short: "", long: [] },
};
/** The git subcommands that only read, and the options each may take (git takes no abbreviations of those it refuses). */
const GIT_READ_ONLY: Readonly<Record<string, readonly string[]>> = {
  status: ["-s", "--short", "-b", "--branch", "--porcelain", "-u", "--untracked-files", "--ignored", "--long"],
  diff: [
    "--stat",
    "--name-only",
    "--name-status",
    "--cached",
    "--staged",
    "--shortstat",
    "--numstat",
    "-U",
    "--unified",
    "--word-diff",
    "--color",
    "--no-color",
    "-w",
    "--ignore-all-space",
    "--patience",
    "--histogram",
    "--minimal",
    "--check",
    "--summary",
  ],
  log: [
    "--oneline",
    "--graph",
    "--stat",
    "-p",
    "--patch",
    "-n",
    "--max-count",
    "--since",
    "--until",
    "--author",
    "--grep",
    "--format",
    "--pretty",
    "--decorate",
    "--all",
    "--reverse",
    "--first-parent",
    "--no-merges",
    "--name-only",
    "--name-status",
    "--follow",
    "-U",
    "--color",
    "--no-color",
    "--date",
  ],
  show: [
    "--stat",
    "--oneline",
    "-p",
    "--patch",
    "--name-only",
    "--name-status",
    "--format",
    "--pretty",
    "--color",
    "--no-color",
    "-s",
    "--quiet",
    "--summary",
  ],
  "rev-parse": ["--abbrev-ref", "--show-toplevel", "--short", "--verify", "--git-dir", "--is-inside-work-tree", "--show-prefix"],
  "ls-files": ["-m", "-o", "-c", "-d", "-s", "--modified", "--others", "--cached", "--deleted", "--stage", "--exclude-standard", "-z"],
  blame: ["-L", "-w", "-M", "-C", "-e", "--porcelain", "--line-porcelain", "-s"],
  branch: ["-a", "-r", "-v", "-vv", "--all", "--remotes", "--list", "--show-current", "--verbose", "--no-color", "--color"],
};
/** `find` predicates that only test or print: every action that runs, deletes or writes is absent. */
const FIND_TESTS =
  /^-(name|iname|path|ipath|type|maxdepth|mindepth|newer|mtime|mmin|ctime|cmin|atime|amin|size|empty|perm|user|group|print|print0|prune|not|o|or|a|and|follow|regex|iregex|wholename|iwholename|links|nouser|nogroup|depth|xdev|mount|readable|writable|executable|samefile|ls)$/;

/** Whether a path reaches outside the working folder: absolute (a drive or `\` root on Windows), the home, a parent, or a variable. */
const pathLeaves = (path: string): boolean => /^([/~\\]|[A-Za-z]:)/.test(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path) || path.includes("$");

/**
 * Whether a word reaches outside the working folder: as written, as the value
 * of an option (`--ignore-file=/etc/x`, `-f/etc/passwd`), or as an element of
 * a brace expansion (`{~/.ssh/id_rsa,x}`).
 */
function leavesFolder(word: string): boolean {
  const values = [word, word.slice(word.indexOf("=") + 1), ...(/^-[^-]./.test(word) ? [word.slice(2)] : [])];
  const braces = [...word.matchAll(/\{([^}]*)\}/g)].flatMap((match) => (match[1] ?? "").split(","));
  return [...values, ...braces].some(pathLeaves);
}

/** Whether every option of `rest` is one `allowed` names: short letters from `short`, long names from `long`. */
function optionsAllowed(rest: readonly string[], short: string, long: readonly string[] | "*"): boolean {
  return rest.every((word) => {
    if (!word.startsWith("-") || word === "-") return true;
    if (word.startsWith("--")) return long === "*" || long.includes(word.split("=")[0] ?? word);
    if (short === "*") return true;
    // A cluster's letters (or a single option with its value attached, `-n5`): the option letters must all be known.
    const letters = word.slice(1).replace(/\d+$/, "");
    return [...letters].every((letter) => short.includes(letter) || (/\d/.test(letter) && short.includes("0-9")));
  });
}

/**
 * Whether one command only reads inside the working folder and prints: a
 * program `READ_ONLY_PROGRAMS` names, given only options it names there,
 * and no path out of the folder. What it prints is all it does, so it can
 * run without a person's say.
 */
function readOnlyCommand(words: readonly string[]): boolean {
  const [program, ...rest] = words;
  if (program === undefined || ASSIGNMENT.test(program) || !Object.hasOwn(READ_ONLY_PROGRAMS, program)) return false;
  const allowed = READ_ONLY_PROGRAMS[program]!;
  if (program !== "echo" && program !== "printf" && rest.some(leavesFolder)) return false;
  switch (program) {
    case "uniq":
      // `uniq in out` writes out.
      return optionsAllowed(rest, allowed.short, allowed.long) && rest.filter((word) => !word.startsWith("-")).length <= 1;
    case "find":
      // Paths first, then predicates: only those that test or print.
      return rest.every((word) => !word.startsWith("-") || FIND_TESTS.test(word));
    case "git": {
      const [subcommand, ...options] = rest;
      if (subcommand === undefined || !Object.hasOwn(GIT_READ_ONLY, subcommand)) return false;
      const known = GIT_READ_ONLY[subcommand]!;
      // `git branch` given a name makes one: only its listing options, never a name.
      if (subcommand === "branch") return options.every((word) => known.includes(word));
      return options.every(
        (word) => !word.startsWith("-") || known.includes(word.split("=")[0] ?? word) || /^-n\d+$|^-\d+$|^-U\d+$/.test(word),
      );
    }
    default:
      return optionsAllowed(rest, allowed.short, allowed.long);
  }
}

/** The files a script's redirects write, as written (`/dev/null` and the like left out). */
function writtenFiles(script: string): readonly string[] | undefined {
  const parsed = parseShellScript(script);
  if (!parsed.ok) return undefined;
  return parsed.redirects
    .filter((each) => WRITING_REDIRECT.test(each.operator) && !(each.operator.includes(">&") && /^(\d+|-)$/.test(each.target.text)))
    .map((each) => each.target.text)
    .filter((target) => !STREAM_TARGET.test(target));
}

/**
 * The build and test commands a grant for the rest of a chat may cover by
 * pattern, by program and the subcommands that keep it one: each already
 * runs the project's own code (its scripts, build files, config), which the
 * chat can edit, so any variant of it grants nothing an exact approval did
 * not. Never a shell, an interpreter, a wrapper, a read tool (those that only
 * read run without asking; the rest are shown whole), or a subcommand that
 * runs a downloaded package or changes standing config (`npm exec`, `go env`).
 */
const PATTERN_COMMANDS: Readonly<Record<string, readonly string[] | null>> = {
  npm: ["test", "run"],
  pnpm: ["test", "run"],
  yarn: ["test", "run"],
  bun: ["test", "run"],
  cargo: ["build", "check", "test", "clippy", "fmt", "doc", "bench"],
  go: ["build", "test", "vet"],
  mvn: ["test", "compile", "package", "verify"],
  gradle: ["test", "build", "check"],
  pytest: null,
  tsc: null,
  vitest: null,
  jest: null,
  eslint: null,
  prettier: null,
  biome: null,
  ruff: null,
  mypy: null,
  black: null,
};

/**
 * The matchers a grant for the rest of a chat stores for a command: its
 * program and subcommand alone and with anything after (`cargo check`,
 * `cargo check *`), or `undefined` where only the exact line may be granted.
 */
function chatPatterns(subject: string): readonly string[] | undefined {
  if (/[<>|;&`$(){}\n]/.test(subject) || RISKY.some((entry) => entry.pattern.test(subject))) return undefined;
  const [program, first, second] = shellWords(subject);
  if (program === undefined || !Object.hasOwn(PATTERN_COMMANDS, program)) return undefined;
  const subcommands = PATTERN_COMMANDS[program];
  const head =
    subcommands === null || subcommands === undefined
      ? [program]
      : first !== undefined && subcommands.includes(first)
        ? // `npm run test`, `pnpm run build`: the script is the run's own.
          first === "run"
          ? second !== undefined && /^[\w:.-]+$/.test(second)
            ? [program, first, second]
            : undefined
          : [program, first]
        : undefined;
  if (head === undefined) return undefined;
  const base = head.map(escapeGlob).join(" ");
  return [base, `${base} *`];
}

/** Shells that are not `sh`: what they read from standard input is their own language, pinned rather than read as `sh`. */
const OTHER_SHELLS = new Set(["fish", "csh", "tcsh", "nu", "pwsh"]);
/** Interpreters that run standard input as their program unless given inline code or a script file. */
const STDIN_INTERPRETER =
  /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|ts-node|tsx|perl|ruby|irb|php|lua[0-9.]*|luajit|R|Rscript|osascript|tclsh|wish|expect|jshell|ghci)$/;
/** Database clients: what they read on standard input is statements, some of which run commands (`\!`, `.shell`). */
const STDIN_DATABASE = /^(sqlite3|psql|mysql|mariadb)$/;
/** Programs that run, or apply, what standard input holds whatever their operands: commands, patches. */
const STDIN_SINKS = new Set(["xargs", "parallel", "at", "batch", "patch", "m4", "ed", "ex"]);
/** What names standard input as a file. */
const STDIN_PATH = /^(-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
/** Flags that give an interpreter or shell its code inline (or a module or file to run), so standard input is data. */
const INLINE_CODE = /^(-[a-zA-Z]*[ce]|-p|--eval|--print|--command|--execute|-m|-x?f|--file)(=.*)?$/;

/** Whether a word names a script file: a path, or a name with a script's extension. */
const scriptFile = (word: string): boolean => !STDIN_PATH.test(word) && (word.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(word));

/** Whether `-f`/`--file` (joined or separate) names standard input as the program file. */
function programFromStdin(rest: readonly string[]): boolean {
  return rest.some((word, index) => {
    if (/^(-[a-zA-Z]*f|--file)$/.test(word)) return STDIN_PATH.test(rest[index + 1] ?? "");
    const joined = /^(?:-[a-zA-Z]*f|--file=)(.+)$/.exec(word)?.[1];
    return joined !== undefined && STDIN_PATH.test(joined);
  });
}

/**
 * How an argv treats standard input: as a shell script it reads (`shell`),
 * as another program it runs or applies (`program`), or as data
 * (`undefined`). Read conservatively, since a flag's value cannot be told
 * from an operand: a shell or interpreter runs standard input unless it is
 * given its code inline or a script file to run.
 */
function runsStandardInput([program, ...rest]: readonly string[]): "shell" | "program" | undefined {
  if (program === undefined) return undefined;
  const inline = rest.some((word) => INLINE_CODE.test(word));
  const named = rest.some(scriptFile);
  // `. /dev/stdin` and `source /dev/stdin` read the script from standard input.
  if ((program === "." || program === "source") && STDIN_PATH.test(rest[0] ?? "")) return "shell";
  if (SHELL_NAMES.has(program)) return shellScriptArg(rest) === undefined && !named ? "shell" : undefined;
  if (OTHER_SHELLS.has(program)) return inline || named ? undefined : "program";
  if (STDIN_SINKS.has(program)) return "program";
  if (program === "crontab") return rest.some((word) => /^-[lre]$/.test(word)) || named ? undefined : "program";
  if (program === "git") return rest[0] === "apply" || rest[0] === "am" ? "program" : undefined;
  if (program === "vim" || program === "nvim" || program === "vi")
    return rest.some((word) => /^-[a-zA-Z]*[es]/.test(word)) ? "program" : undefined;
  if (/^(g?sed|g?make|[gmn]?awk)$/.test(program)) return programFromStdin(rest) ? "program" : undefined;
  if (STDIN_DATABASE.test(program))
    return rest.some((word) => /^(-[a-zA-Z]*[cfe]|--command|--file|--execute)(=.*)?$/.test(word)) ? undefined : "program";
  if (STDIN_INTERPRETER.test(program)) return inline || named ? undefined : "program";
  return undefined;
}

/** The script a shell `command` runs with `-c`, or `undefined` when it is not a shell given one. */
function shellScriptOf(command: string, args: readonly string[]): string | undefined {
  return SHELL_NAMES.has(command.split("/").pop() ?? command) ? shellScriptArg(args) : undefined;
}

/** The simple commands a `sandbox.run` call executes: a shell script is split, an argv is one command. */
export function sandboxCommands(command: string, args: readonly string[]): readonly string[] {
  const script = shellScriptOf(command, args);
  return script === undefined ? [[command, ...args].join(" ").trim()] : splitShellCommands(script);
}

/**
 * What in a shell script no rule can read safely. With any, no allow rule or
 * grant covers the call and only `once` is offered, so its card always shows;
 * deny rules still see every command the splitter found. Over-matching only
 * asks: a false positive costs a card, never a grant.
 */
const OPAQUE_SHELL: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /\$\(|`/, reason: "runs a command substitution" },
  { pattern: /(^|[\s;&|(])eval(\s|$)/, reason: "evaluates a string as a command" },
  { pattern: /<<[-<]?\s*[^\s<>&|;()]/, reason: "feeds a here-document" },
  {
    pattern: /(^|[;&|(\n])\s*(if|then|elif|else|fi|for|while|until|do|done|case|esac|function|select)(\s|;|$)/,
    reason: "uses shell control flow",
  },
  { pattern: /\(\s*\)\s*\{/, reason: "defines a shell function" },
  // `/bin/sh` skips a comment to its line's end, quotes and all; the splitter does not read comments.
  { pattern: /(^|[\s;&|()])#/, reason: "holds a shell comment" },
];

/**
 * Why no rule may cover `script`: what `OPAQUE_SHELL` finds, and what the
 * splitter read but shells disagree on or a line can hide a command behind
 * (`$'…'`, a backslash-newline, `${…}` beyond a plain name, `<(…)`). A line
 * with none of these is read a second time by the shell grammar, and any
 * command the grammar finds that the splitter did not makes it opaque too: a
 * future desync between the two fails closed, while a line already opaque
 * (here-documents and control flow, which the grammar does not read) is not
 * asked about twice.
 */
function opaqueReasons(script: string): readonly string[] {
  const reading = readShellScript(script);
  const reasons = [...OPAQUE_SHELL.filter((entry) => entry.pattern.test(script)).map((entry) => entry.reason), ...reading.opaque];
  const unparsed = reading.commands.some((subject) => subject.startsWith(UNPARSED_SUBJECT_PREFIX));
  if (reasons.length === 0 && !unparsed && !shellParsesAgree(script, reading.commands)) reasons.push(SHELL_PARSE_DISAGREEMENT_REASON);
  return reasons;
}

/** A redirection's operator and target: `>x`, `2>>x`, `>|x`, `&>x`, `>&x`. */
const REDIRECT = /(?:\d*|&)(?:>&|>>?\|?)\s*(\S+)/g;
/** Targets a redirect may name and stay in bounds: a standard stream. */
const STREAM_TARGET = /^\/dev\/(?:null|stdout|stderr|fd\/\d+)$/;

/** The redirections that write: everything but `<`, `<&` and `<<<`, which only read. */
const WRITING_REDIRECT = />/;
/** A redirect to a stream rather than a file, as a subject spells it: `> /dev/null`, `2>&1`. */
const STREAM_REDIRECT = /\s*(?:\d|&)?>>?\s*(?:\/dev\/(?:null|stdout|stderr)|&\d)(?=\s|$)/g;

/**
 * Whether a script redirects output outside the working folder: to an
 * absolute path, `~`, a variable (but `$TMPDIR`), or anywhere a `..` segment
 * climbs to. A `>&` onto a number or `-` duplicates a stream; onto anything
 * else it is a file. The redirections are the shell grammar's
 * (`parseShellScript`), so a `>` inside quotes (`grep 'a>/b'`) is no
 * redirection and a target is read unquoted (`>\/etc/x` is `/etc/x`); a
 * script the grammar cannot read falls back to a pattern over
 * the whole text, which over-matches. Over-matching only asks.
 */
function redirectsOutside(script: string): boolean {
  const parsed = parseShellScript(script);
  const found = parsed.ok
    ? parsed.redirects.filter((each) => WRITING_REDIRECT.test(each.operator)).map((each) => [each.operator, each.target.text] as const)
    : [...script.matchAll(REDIRECT)].map(([whole, raw]) => [whole, (raw ?? "").replace(/["']/g, "")] as const);
  for (const [operator, target] of found) {
    if (operator.includes(">&") && /^(\d+|-)$/.test(target)) continue;
    if (STREAM_TARGET.test(target)) continue;
    if (/(^|\/)\.\.(\/|$)/.test(target)) return true;
    const scratch = /^\$(?:TMPDIR|\{TMPDIR\})(\/|$)/.test(target);
    if (!scratch && (/^[/~]/.test(target) || target.includes("$"))) return true;
  }
  return false;
}

/** A shell `find` runs per file (`-exec sh -c '…' \;`), which its forms never derive. */
const FIND_EXEC_SHELL = /\s-(?:exec|execdir|ok|okdir)\s+(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|mksh|ash)\s/;

/** A shell run inside a command (`env sh -c`, `busybox sh -c`, `xargs bash -c`), read by its derived forms. */
const NESTED_SHELL = /^(sh|bash|zsh|dash|ksh|mksh|ash)(\s+[-+]\S+)*\s+-[a-zA-Z]*c[a-zA-Z]*(\s|$)/;
/**
 * Whether a command starts a shell that reads startup files: a login or
 * interactive one, or one given `--rcfile`/`--init-file`. Only the shell's own
 * options count, up to its script or first operand.
 */
function startsStartupShell(form: string): boolean {
  const [program, ...rest] = shellWords(form);
  if (program === undefined || !SHELL_NAMES.has(program.split("/").pop() ?? program)) return false;
  for (let index = 0; index < rest.length && /^[-+]./.test(rest[index]!); index += 1) {
    const word = rest[index]!;
    if (/^--(rcfile|init-file|login|interactive)$/.test(word) || /^-[a-zA-Z]*[il]/.test(word)) return true;
    if (/^[-+][oO]$/.test(word)) index += 1;
  }
  return false;
}

/** An argv as the card shows it: each word quoted as the shell needs it, with newlines, tabs and long runs of spaces spelled out. */
function shownArgv(words: readonly string[]): string {
  return words
    .map(quoteWord)
    .join(" ")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/ {4,}/g, (run) => ` ⟨${run.length} spaces⟩ `);
}

/** `$'…'` escapes bash decodes by letter. */
const ANSI_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/** `$'…'` code-point escapes (bash 4.2+): `\u` takes up to 4 hex digits, `\U` up to 8. */
const UNICODE_ESCAPES: Readonly<Record<string, RegExp>> = { u: /^[0-9a-fA-F]{1,4}/, U: /^[0-9a-fA-F]{1,8}/ };

/** The `$'…'` escape whose letter is at `at`, decoded (`\x73` and `\u0073` are `s`): its text and how many characters it takes. */
function ansiEscape(text: string, at: number): readonly [string, number] {
  const char = text[at]!;
  if (Object.hasOwn(ANSI_ESCAPES, char)) return [ANSI_ESCAPES[char]!, 1];
  const octal = /^[0-7]{1,3}/.exec(text.slice(at, at + 3))?.[0];
  if (octal !== undefined) return [String.fromCharCode(Number.parseInt(octal, 8) & 0xff), octal.length];
  const hex = char === "x" ? /^[0-9a-fA-F]{1,2}/.exec(text.slice(at + 1, at + 3))?.[0] : undefined;
  if (hex !== undefined) return [String.fromCharCode(Number.parseInt(hex, 16)), 1 + hex.length];
  const unicode = UNICODE_ESCAPES[char]?.exec(text.slice(at + 1, at + 9))?.[0];
  if (unicode !== undefined) {
    const point = Number.parseInt(unicode, 16);
    if (point <= 0x10ffff) return [String.fromCodePoint(point), 1 + unicode.length];
  }
  return [`\\${char}`, 1];
}

/**
 * The words of one simple command, quotes removed: enough to find the program
 * it runs, not a full shell grammar. `$'…'` is decoded, a backslash-newline
 * outside single quotes joins its lines, and a `${…}` stays one word.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  const stack: ("'" | "$'" | '"' | "${")[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const top = stack.at(-1);
    if (top === "'") {
      if (char === "'") stack.pop();
      else current += char;
      continue;
    }
    if (top === "$'") {
      if (char === "\\" && index + 1 < command.length) {
        const [decoded, length] = ansiEscape(command, index + 1);
        current += decoded;
        index += length;
      } else if (char === "'") stack.pop();
      else current += char;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      if (command[index + 1] !== "\n") {
        current += command[index + 1]!;
        started = true;
      }
      index += 1;
      continue;
    }
    if (char === "$" && command[index + 1] === "{") {
      stack.push("${");
      current += "${";
      started = true;
      index += 1;
      continue;
    }
    if (char === "$" && (command[index + 1] === "'" || command[index + 1] === '"') && top !== '"') {
      stack.push(command[index + 1] === "'" ? "$'" : '"');
      started = true;
      index += 1;
      continue;
    }
    if (top === '"') {
      if (char === '"') stack.pop();
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      stack.push(char);
      started = true;
      continue;
    }
    if (top === "${") {
      if (char === "}") stack.pop();
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

/**
 * Programs that run the command after them. `flags` take the next word as
 * their value; `positional` counts the operands before the command (`timeout
 * 5 cmd`). `sudo` is here so `sudo rm -rf x` also reads as the deletion it
 * is — its own pattern still rates the whole call critical.
 */
const WRAPPERS: Readonly<
  Record<
    string,
    {
      readonly flags?: readonly string[];
      readonly positional?: number;
      readonly assignments?: boolean;
      readonly queries?: readonly string[];
    }
  >
> = {
  env: { flags: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], assignments: true },
  nohup: {},
  time: { flags: ["-f", "--format", "-o", "--output"] },
  command: { queries: ["-v", "-V"] },
  builtin: {},
  exec: { flags: ["-a"] },
  xargs: { flags: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs"] },
  nice: { flags: ["-n", "--adjustment"] },
  ionice: { flags: ["-c", "-n", "-p", "--class", "--classdata"] },
  timeout: { flags: ["-s", "-k", "--signal", "--kill-after"], positional: 1 },
  stdbuf: { flags: ["-i", "-o", "-e"] },
  setsid: {},
  busybox: {},
  sudo: { flags: ["-u", "-g", "-C", "-D", "-h", "-p", "-R", "-r", "-T", "-t", "-U"], assignments: true },
  doas: { flags: ["-u", "-C"] },
  // Launchers that run the command after them as it is (macOS's first).
  xcrun: { flags: ["--sdk", "--toolchain"] },
  arch: { flags: ["-arch", "-e"] },
  caffeinate: { flags: ["-t", "-w"] },
  flock: { flags: ["-w", "--timeout", "-E", "--conflict-exit-code"], positional: 1 },
  chrt: { flags: ["-T", "-P", "-D"], positional: 1 },
  strace: { flags: ["-e", "-o", "-p", "-s", "-u", "-E", "-P", "-a", "-b", "-I", "-O", "-S", "-X"] },
  watch: { flags: ["-n", "--interval"] },
  script: { flags: ["-F", "-t", "-T", "-I", "-O"], positional: 1 },
};

/** How deep `bash -c "sh -c '…'"` is followed; deeper nesting is rated high rather than read. */
const MAX_SHELL_DEPTH = 4;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `find`'s actions that run a command, up to its `;` or `+`. */
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** git's options before its subcommand that take the next word as their value (`-C dir`, `-c k=v`, `--git-dir x`). */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--attr-source",
]);

/**
 * git settings whose value is a command git runs, a program it starts, or a
 * place it loads either from: a pager, an editor, an `!` alias, a hook path,
 * a diff, merge or filter driver, a credential helper, an `ssh` command, an
 * included config file. Matched on the lower-cased key.
 */
const GIT_COMMAND_SETTING =
  /^(?:core\.(?:pager|editor|sshcommand|fsmonitor|hookspath|gitproxy|askpass|alternaterefscommand)|sequence\.editor|diff\.external|pager\..+|alias\..+|interactive\.difffilter|uploadpack\.packobjectshook|init\.templatedir|include\.path|includeif\..+\.path|credential\.(?:.+\.)?helper|gpg\.(?:.+\.)?program|diff\..+\.(?:textconv|command)|merge\..+\.driver|filter\..+\.(?:clean|smudge|process)|(?:mergetool|difftool|man|browser)\..+\.(?:cmd|path)|remote\..+\.(?:uploadpack|receivepack)|protocol\.(?:.+\.)?allow|submodule\..+\.update|hook\..+\.command|trailer\..+\.(?:command|cmd)|sendemail\.(?:smtpserver|tocmd|cccmd|headercmd)|web\.browser|tar\..+\.command|guitool\..+\.cmd|lfs\.customtransfer\..+\.path|lfs\.extension\..+\.(?:clean|smudge))$/;

/**
 * Environment variables git reads as one of those settings, by the key it
 * stands for, or `hidden` when it can carry any setting (`GIT_CONFIG_COUNT`
 * with its `GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`) or moves where git finds
 * its own programs.
 */
const GIT_COMMAND_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_PAGER: "core.pager",
  PAGER: "core.pager",
  GIT_EDITOR: "core.editor",
  EDITOR: "core.editor",
  VISUAL: "core.editor",
  GIT_SEQUENCE_EDITOR: "sequence.editor",
  GIT_SSH_COMMAND: "core.sshcommand",
  GIT_SSH: "core.sshcommand",
  GIT_EXTERNAL_DIFF: "diff.external",
  GIT_ASKPASS: "core.askpass",
  SSH_ASKPASS: "core.askpass",
  GIT_PROXY_COMMAND: "core.gitproxy",
  GIT_CONFIG_COUNT: "hidden",
  GIT_CONFIG_PARAMETERS: "hidden",
  GIT_CONFIG: "hidden",
  GIT_CONFIG_GLOBAL: "hidden",
  GIT_CONFIG_SYSTEM: "hidden",
  GIT_EXEC_PATH: "hidden",
  GIT_TEMPLATE_DIR: "hidden",
};

/** A setting's value that runs nothing beyond what its key always runs: a plain pager, or an alias that is git's own subcommand. */
function harmlessGitSetting(key: string, value: string): boolean {
  if (/^(?:core\.pager|pager\..+)$/.test(key)) return /^(?:|cat|more|less(?:\s+-[A-Za-z]+)*)$/.test(value.trim());
  if (/^alias\./.test(key)) return !value.trimStart().startsWith("!");
  return false;
}

/**
 * git's global options before its subcommand: where the subcommand starts,
 * and the commands its `-c`/`--config-env` settings run. A setting that runs
 * a command (`-c core.pager='sh x'`, `-c alias.x='!rm -rf ~'`) gives that
 * command as a script, and `--config-env` such a setting or `--exec-path=…`
 * — whose command no line spells out — marks the call `hidden`. The
 * `environment` assignments before git (`GIT_SSH_COMMAND=… git fetch`) are
 * read as the settings they stand for.
 */
function gitGlobals(
  rest: readonly string[],
  environment: readonly string[],
): {
  readonly subcommand: number;
  readonly scripts: readonly string[];
  readonly hidden: boolean;
} {
  const scripts: string[] = [];
  let hidden = false;
  const setting = (assignment: string, fromEnvironment: boolean) => {
    const equals = assignment.indexOf("=");
    const key = (equals < 0 ? assignment : assignment.slice(0, equals)).toLowerCase();
    if (!GIT_COMMAND_SETTING.test(key)) return;
    if (fromEnvironment || equals < 0) hidden = true;
    else {
      const value = assignment.slice(equals + 1);
      if (harmlessGitSetting(key, value)) return;
      hidden = true;
      scripts.push(/^alias\./.test(key) ? value.trimStart().slice(1) : value);
    }
  };
  // `GIT_PAGER='sh x' git log` runs its pager as `-c core.pager='sh x'` would.
  for (const assignment of environment) {
    const equals = assignment.indexOf("=");
    const key = GIT_COMMAND_ENVIRONMENT[assignment.slice(0, equals)];
    if (key === "hidden") hidden = true;
    else if (key !== undefined) setting(`${key}${assignment.slice(equals)}`, false);
  }
  let index = 0;
  while (index < rest.length && rest[index]!.startsWith("-")) {
    const word = rest[index]!;
    const [name, inline] =
      word.startsWith("--") && word.includes("=")
        ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)]
        : [word, undefined];
    const value = GIT_VALUE_OPTIONS.has(name) ? (inline ?? rest[index + 1]) : inline;
    index += GIT_VALUE_OPTIONS.has(name) && inline === undefined ? 2 : 1;
    if (name === "-c" && value !== undefined) setting(value, false);
    if (name === "--config-env" && value !== undefined) setting(value, true);
    if (name === "--exec-path" && value !== undefined) hidden = true;
  }
  return { subcommand: index, scripts, hidden };
}

/**
 * Every form of one simple command a risk or refusal pattern must see:
 * the command as written, then — with leading `VAR=value`
 * assignments and wrappers (`env`, `nohup`, `timeout 5`, `sudo -E`, …)
 * stripped one at a time — each program it runs, named by basename, and the
 * commands of any `sh -c '<script>'` body, followed to a bounded depth. The
 * patterns are anchored at the program, so without this `/usr/bin/sudo ls`,
 * `env sudo ls` and `bash -c "sudo ls"` read as ordinary commands. The
 * `sh -c` bodies it followed come back as `scripts`, for the opaque checks.
 *
 * Risk, refusal, and deny and ask rules (`CallAssessment.forms`) read
 * these. Allow rules and grants match only the commands as written, so an
 * allow rule for `ls *` does not start covering `env ls` or `nice ls`:
 * normalizing can raise a call's risk or hold it to a rule, never widen one.
 */
function commandForms(
  command: string,
  depth = 0,
): {
  readonly forms: readonly string[];
  readonly argvs: readonly (readonly string[])[];
  readonly scripts: readonly string[];
  readonly tooDeep: boolean;
  readonly gitRuns: boolean;
} {
  const forms = [command];
  // Each derived form's words, unjoined: a path with spaces stays one operand.
  const argvs: (readonly string[])[] = [];
  const scripts: string[] = [];
  let tooDeep = false;
  let gitRuns = false;
  /** The `NAME=value` assignments before the program, a wrapper's (`env X=1 git`) included. */
  const environment: string[] = [];
  /** Read `inner`'s forms as this command's own. */
  const include = (inner: ReturnType<typeof commandForms>) => {
    forms.push(...inner.forms);
    argvs.push(...inner.argvs);
    scripts.push(...inner.scripts);
    tooDeep ||= inner.tooDeep;
    gitRuns ||= inner.gitRuns;
  };
  let words = shellWords(command);
  for (let guard = 0; guard < 16 && words.length > 0; guard += 1) {
    let start = 0;
    while (start < words.length && ASSIGNMENT.test(words[start]!)) start += 1;
    environment.push(...words.slice(0, start));
    if (start >= words.length) break;
    const program = words[start]!.split("/").pop() ?? words[start]!;
    const rest = words.slice(start + 1);
    forms.push([program, ...rest].join(" "));
    argvs.push([program, ...rest]);
    if (SHELL_NAMES.has(program)) {
      const body = shellScriptArg(rest);
      if (body !== undefined) {
        if (depth >= MAX_SHELL_DEPTH) tooDeep = true;
        else {
          scripts.push(body);
          for (const inner of splitShellCommands(body)) include(commandForms(inner, depth + 1));
        }
      }
      break;
    }
    // `find … -exec rm -rf {} +` runs `rm -rf` on what it finds: each command it runs is a form of its own.
    if (program === "find") {
      for (let index = 0; index < rest.length; index += 1) {
        if (!FIND_RUNS.has(rest[index]!)) continue;
        const end = rest.findIndex((word, at) => at > index && (word === ";" || word === "+"));
        const run = rest.slice(index + 1, end < 0 ? undefined : end);
        if (run.length > 0) include(commandForms(run.map(quoteWord).join(" "), depth));
        if (end < 0) break;
        index = end;
      }
      break;
    }
    // `git -C dir -c k=v push` is a push; a setting that runs a command is read as the script it is (`sh -c` runs it).
    if (program === "git") {
      const globals = gitGlobals(rest, environment);
      if (globals.subcommand > 0) {
        forms.push(["git", ...rest.slice(globals.subcommand)].join(" "));
        argvs.push(["git", ...rest.slice(globals.subcommand)]);
      }
      gitRuns ||= globals.hidden;
      for (const script of globals.scripts) {
        if (depth >= MAX_SHELL_DEPTH) tooDeep = true;
        else {
          scripts.push(script);
          for (const inner of splitShellCommands(script)) include(commandForms(inner, depth + 1));
        }
      }
      break;
    }
    const wrapper = Object.hasOwn(WRAPPERS, program) ? WRAPPERS[program] : undefined;
    if (wrapper === undefined) break;
    let index = 0;
    while (index < rest.length) {
      const word = rest[index]!;
      if (word === "--") {
        index += 1;
        break;
      }
      if (wrapper.assignments === true && ASSIGNMENT.test(word)) {
        environment.push(word);
        index += 1;
        continue;
      }
      // `env -` starts from an empty environment, as `-i` does: a flag, not the program.
      if (word === "-" && program === "env") {
        index += 1;
        continue;
      }
      if (!word.startsWith("-") || word === "-") break;
      // `command -v sudo` looks a program up; it runs nothing.
      if (wrapper.queries?.includes(word) === true) return { forms, argvs, scripts, tooDeep, gitRuns };
      if ((word === "-S" || word === "--split-string") && program === "env" && rest[index + 1] !== undefined) {
        // `env -S 'sudo ls'` splits its value into the command it runs.
        rest.splice(index, 2, ...shellWords(rest[index + 1]!));
        continue;
      }
      if (program === "env" && word.startsWith("--split-string=")) {
        rest.splice(index, 1, ...shellWords(word.slice("--split-string=".length)));
        continue;
      }
      if (wrapper.flags?.includes(word) === true || word.startsWith("--")) {
        index += wrapper.flags?.includes(word) === true ? 2 : 1;
        continue;
      }
      // Short flags read letter by letter, as getopt does: the first that takes a value takes the rest of
      // the word (`-uroot`, `-etrace`), or the next word when none is left (`-iu FOO`); env's `-S` splits it.
      let consumed = 1;
      for (let at = 1; at < word.length; at += 1) {
        const letter = word[at]!;
        if (wrapper.flags?.includes(`-${letter}`) !== true) continue;
        const attached = word.slice(at + 1);
        const value = attached === "" ? rest[index + 1] : attached;
        if (program === "env" && letter === "S" && value !== undefined) {
          rest.splice(index, attached === "" ? 2 : 1, ...shellWords(value));
          consumed = 0;
        } else if (attached === "") consumed = 2;
        break;
      }
      index += consumed;
    }
    index += wrapper.positional ?? 0;
    words = rest.slice(index);
  }
  return { forms, argvs, scripts, tooDeep, gitRuns };
}

/** Programs that change the directory the commands after them run in, and `env -C` / `--chdir`, which runs its command elsewhere. */
const CHANGES_DIRECTORY = /^(?:cd|pushd|popd)(?:\s|$)|^env\s(?:.*\s)?(?:-[a-zA-Z]*C|--chdir\b)/;

/**
 * Whether a recursive `rm` names a writable root of the chat's folder whole:
 * its primary, managed or home folder or a read-write attachment, spelled as
 * the folder itself, `.`, `..` or `*` from inside, or with a trailing `/`,
 * `/.` or `/*`. A relative operand resolves against the call's `cwd` (the
 * primary when it names none), as does `$PWD`, and neither is read at all
 * once the line changes directory. Words the shell would expand otherwise (`$X`, a glob mid-path)
 * are not guessed at. Roots and operands are compared both as spelled and
 * through their links (the run's `cwd` is resolved so), which reads the
 * filesystem.
 */
function deletesWritableRoot(
  argvs: readonly (readonly string[])[],
  forms: readonly string[],
  folder: ChatFolder,
  requestedCwd: string | undefined,
): boolean {
  // As the run reads them: `cwd` through every link (`cwdFor`), so `cwd: "sub/link"` with `link -> ..` is the folder above.
  const roots = new Set(
    [
      folder.primary,
      folder.managed,
      folder.home,
      ...folder.attachments.filter((each) => each.mode === "rw").map((each) => each.path),
    ].flatMap((path) => [posix.resolve(path), resolvedPath(posix.resolve(path))]),
  );
  const cwd = resolvedPath(posix.resolve(folder.primary, requestedCwd ?? "."));
  const relativeKnown = !forms.some((form) => CHANGES_DIRECTORY.test(form));
  for (const [program, ...rest] of argvs) {
    if (program !== "rm") continue;
    const dash = rest.indexOf("--");
    const options = dash === -1 ? rest : rest.slice(0, dash);
    if (!options.some((word) => /^-[a-zA-Z]*[rR][a-zA-Z]*$|^--recursive$/.test(word))) continue;
    const operands = [...options.filter((word) => !word.startsWith("-")), ...(dash === -1 ? [] : rest.slice(dash + 1))];
    for (const operand of operands) {
      let path = homeSpelled(operand).replace(/^(?:~|\$HOME)(?=\/|$)/, folder.home);
      // `$PWD` is the folder the line runs in, known while it has not changed directory.
      if (relativeKnown) path = path.replace(/^\$(?:PWD|\{PWD\})(?=\/|$)/, cwd);
      if (path === "*") path = ".";
      while (path.length > 1 && /(?:\/\.|\/\*|\/)$/.test(path)) path = path.replace(/(?:\/\.|\/\*|\/)$/, "") || "/";
      if (/[$*?[`]/.test(path)) continue;
      if (!path.startsWith("/") && !relativeKnown) continue;
      const target = posix.resolve(cwd, path);
      if (roots.has(target) || roots.has(resolvedPath(target))) return true;
    }
  }
  return false;
}

/** `path` with every link resolved, as far as it exists; as spelled when it does not. */
function resolvedPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** A `cd` / `pushd` operand that is the home directory, or none (bare `cd` goes home). */
const HOME_WORD = /^(?:~|\$HOME|\$\{HOME\})\/?$/;

/**
 * Whether a recursive `rm` names the home directory or an ancestor of it
 * (`/` included) by a spelling the patterns do not: a path that normalises
 * there (`~/foo/..`, `~/Documents/../`), the home spelled out, or `.`, `*`
 * and `./*` after a `cd` home earlier in the line (`cd && rm -rf *`,
 * `cd $HOME; rm -rf ./*`). Each operand is resolved lexically — `~` and
 * `$HOME` expanded, against the last `cd` the line made, which starts
 * unknown — and one still holding a variable or a glob mid-path is not
 * guessed at. Pure: no path is looked up.
 */
function deletesHomeLexically(argvs: readonly (readonly string[])[], home: string): boolean {
  const homePath = posix.resolve(home);
  const expand = (word: string): string => homeSpelled(word).replace(/^(?:~|\$HOME)(?=\/|$)/, homePath);
  /** The directory the line has moved to; `undefined` until a `cd` says, or once one cannot be read. */
  let cwd: string | undefined;
  for (const [program, ...rest] of argvs) {
    if (program === "cd" || program === "pushd") {
      const operands = rest.filter((word) => !/^-[LPe@]+$/.test(word) && word !== "--");
      const target = operands[0];
      if (target === undefined) cwd = program === "cd" ? homePath : undefined;
      else if (HOME_WORD.test(target)) cwd = homePath;
      else {
        const path = expand(target);
        if (/[$*?[`]/.test(path) || target === "-") cwd = undefined;
        else if (path.startsWith("/")) cwd = posix.normalize(path);
        else if (cwd !== undefined) cwd = posix.resolve(cwd, path);
      }
      continue;
    }
    if (program === "popd") {
      cwd = undefined;
      continue;
    }
    if (program !== "rm") continue;
    const dash = rest.indexOf("--");
    const options = dash === -1 ? rest : rest.slice(0, dash);
    if (!options.some((word) => /^-[a-zA-Z]*[rR][a-zA-Z]*$|^--recursive$/.test(word))) continue;
    const operands = [...options.filter((word) => !word.startsWith("-")), ...(dash === -1 ? [] : rest.slice(dash + 1))];
    for (const operand of operands) {
      // A trailing `/*` deletes everything in the folder: read it as the folder.
      let path = expand(operand);
      if (path === "*") path = ".";
      path = path.replace(/\/\*$/, "/");
      if (/[$*?[`]/.test(path)) continue;
      const resolved = path.startsWith("/") ? posix.normalize(path) : cwd === undefined ? undefined : posix.resolve(cwd, path);
      if (resolved === undefined) continue;
      const target = resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
      if (target === "/" || homePath === target || homePath.startsWith(`${target}/`)) return true;
    }
  }
  return false;
}

/**
 * `sandbox.run`: its subjects are the commands it runs. In a side chat (the
 * workflow stamps its parent on the turn) or a side chat's worker (whose
 * folder, the side chat's, has its parent's attached as `parent-chat`) it is
 * rated at least `high`, which
 * withholds `always`: a standing rule for a command applies in every chat,
 * the side chat's parent included, and a side chat's approval never does.
 * `session` stays — a grant is the side chat's own.
 */
export function assessSandboxRun(input: unknown, context?: Pick<InvocationContext, "parentChatId" | "folder">): CallAssessment {
  const call = record(input);
  // What runs, read as `sandbox.run` runs it: a whole command line in `command` is its program and arguments (`sandboxArgv`).
  const argv = sandboxArgv(text(call["command"]) ?? "", Array.isArray(call["args"]) ? call["args"].map((arg) => text(arg) ?? "") : []);
  const command = argv.command;
  const args = argv.args;
  const script = shellScriptOf(command, args);
  const commands = sandboxCommands(command, args);
  // The line as a shell would read it: an argv's words quoted, so `echo` + `["rm -rf /"]` is the text it prints, as
  // `echo "rm -rf /"` is in a script, not the deletion it spells.
  const whole = script === undefined ? [command, ...args].map(quoteWord).join(" ") : [command, ...args].join(" ");
  // An argv (`command` + `args`) that is no `sh -c` script is one command whose words need no quoting:
  // read its forms from the words themselves, so `["env", "sudo", "ls"]` and an
  // argument holding spaces are seen as the shell would run them.
  const readings =
    script === undefined ? [commandForms([command, ...args].map(quoteWord).join(" "))] : commands.map((subject) => commandForms(subject));
  const forms = [...new Set(readings.flatMap((reading) => reading.forms))];
  const reasons: string[] = [];
  let risk: RiskLevel = "medium";
  for (const entry of RISKY) {
    if (forms.some((form) => entry.pattern.test(form))) {
      risk = maxRisk(risk, entry.risk);
      reasons.push(entry.reason);
    }
  }
  if (readings.some((reading) => reading.tooDeep)) {
    risk = maxRisk(risk, "high");
    reasons.push("nests shells too deeply to read");
  }
  // What no rule can read: the card shows every time, with why.
  const derived = readings.flatMap((reading) => reading.forms.slice(1));
  // A nested `sh -c` body is read as closely as the line itself.
  const scripts = [...(script === undefined ? [] : [script]), ...readings.flatMap((reading) => reading.scripts)];
  const opaque = [
    ...new Set(scripts.flatMap(opaqueReasons)),
    ...(commands.some((subject) => subject.startsWith(UNPARSED_SUBJECT_PREFIX)) ? ["cannot be read as plain commands"] : []),
    ...(script !== undefined && redirectsOutside(script) ? ["redirects output outside the working folder"] : []),
    ...(derived.some((form) => NESTED_SHELL.test(form) || FIND_EXEC_SHELL.test(` ${form}`)) ? ["runs a shell inside a command"] : []),
    ...([[command, ...args].map(quoteWord).join(" "), ...derived].some(startsStartupShell)
      ? ["starts a shell that reads startup files"]
      : []),
    ...(readings.some((reading) => reading.tooDeep) ? ["nests shells too deeply to read"] : []),
    ...(readings.some((reading) => reading.gitRuns) ? ["runs a command through a git setting"] : []),
  ];
  for (const reason of opaque) if (!reasons.includes(reason)) reasons.push(reason);
  // What `stdin` runs is part of the command: a shell's script is read as a `-c` line would be, an
  // interpreter's program pins its grant, and plain data (`jq`, `wc`) is shown but changes no subject.
  const stdin = text(call["stdin"]);
  const runners =
    stdin === undefined
      ? []
      : readings
          .flatMap((reading) => reading.argvs)
          .flatMap((argv) => {
            const kind = runsStandardInput(argv);
            return kind === undefined ? [] : [{ argv, kind }];
          });
  let fromStdin: CallAssessment | undefined;
  const stdinSubjects: string[] = [];
  if (stdin !== undefined && runners.length > 0) {
    if (runners.some((runner) => runner.kind === "shell")) {
      // Read where it runs, so a deletion of the working folder from `cwd` is refused as the same line would be.
      fromStdin = assessSandboxRun(
        { command: "sh", args: ["-c", stdin], ...(call["cwd"] === undefined ? {} : { cwd: call["cwd"] }) },
        context,
      );
      stdinSubjects.push(...fromStdin.subjects);
    }
    const digest = createHash("sha256").update(stdin).digest("hex").slice(0, 12);
    stdinSubjects.push(
      ...runners.filter((runner) => runner.kind === "program").map((runner) => `${runner.argv.join(" ")} <stdin:${digest}>`),
    );
    risk = maxRisk(risk, fromStdin?.risk ?? "medium");
    for (const reason of ["runs a script given on standard input", ...(fromStdin?.reasons ?? [])])
      if (!reasons.includes(reason)) reasons.push(reason);
  }
  // A script no text form can show (a NUL in it), or longer than a card shows, is asked about every time:
  // an approval for good would cover code the person never saw.
  const stdinOpaque =
    stdinSubjects.length > 0 &&
    (stdin?.includes("\0") === true || (stdin?.length ?? 0) > STDIN_SHOWN_CHARS || fromStdin?.onceOnly === true);
  if (
    context?.parentChatId !== undefined ||
    context?.folder?.attachments.some((attachment) => attachment.label === CHAT_FOLDER_PARENT_LABEL) === true
  ) {
    risk = maxRisk(risk, "high");
    reasons.push("a side chat's standing rule for this command would also apply in its parent chat");
  }
  // A derived form has its quotes removed, so it is refused only when the
  // pattern starts at its program: `echo "rm -rf /"` must not read as the
  // deletion it quotes, while `rm -rf "/"` and `env rm -rf /` still do.
  const denied =
    HARD_DENY.find(
      (entry) =>
        forms.some((form) => entry.pattern.exec(homeSpelled(form))?.index === 0) ||
        (script === undefined ? [] : commands).some((subject) => entry.pattern.test(homeSpelled(subject))) ||
        entry.pattern.test(homeSpelled(whole)),
    ) ??
    (deletesHomeLexically(
      readings.flatMap((reading) => reading.argvs),
      homedir(),
    )
      ? { reason: "deletes the root or home directory" }
      : undefined) ??
    (context?.folder !== undefined &&
    deletesWritableRoot(
      readings.flatMap((reading) => reading.argvs),
      forms,
      context.folder,
      text(call["cwd"]),
    )
      ? { reason: "deletes the chat's working folder or an attached folder whole" }
      : undefined);
  const stdinShown =
    stdin === undefined
      ? undefined
      : stdin.length > STDIN_SHOWN_CHARS
        ? `${stdin.slice(0, STDIN_SHOWN_CHARS)}\n… (${stdin.length - STDIN_SHOWN_CHARS} more characters)`
        : stdin;
  // A command's other spellings (and a stdin script's) for deny and ask rules: never one its subjects already hold.
  const spellings = [...new Set([...forms, ...(fromStdin?.forms ?? [])])].filter(
    (form) => !commands.includes(form) && !stdinSubjects.includes(form),
  );
  // What a line writes through its redirects is its own subject: an allow rule for `echo *` never covers
  // `echo hi > package.json`, since the rule must cover `>file:package.json` too.
  const written = script === undefined ? [] : writtenFiles(script);
  const fileSubjects = (written ?? []).filter((target) => !leavesFolder(target)).map((target) => `>file:${target}`);
  // Domains the run asks the person for (`requestDomains`, under `sandbox.network ask`): each its own subject, so an
  // approval for one never covers another, and a host the call names wrongly is shown as it was written.
  const requested = requestedDomainsOf(call["requestDomains"]);
  if (requested.length > 0) {
    risk = maxRisk(risk, "high");
    reasons.push(`asks to reach ${clip(requested.join(", "), 300)} for this run`);
  }
  // A host no run may ask for is refused before its card, and a program spelled as a domain's subject would let an
  // approval of the command later cover that domain.
  const unrequestable = requested.find((domain) => requestableSandboxDomain(domain) === undefined);
  const spelledAsDomain = commands.some((subject) => subject.startsWith(SANDBOX_DOMAIN_SUBJECT_PREFIX));
  const subjects = [
    ...(opaque.length > 0 && !commands.some((subject) => subject.startsWith(UNPARSED_SUBJECT_PREFIX))
      ? [...commands, `${UNPARSED_SUBJECT_PREFIX}${script ?? whole}`]
      : commands),
    ...stdinSubjects.filter((subject) => !commands.includes(subject)),
    ...fileSubjects.filter((subject) => !commands.includes(subject)),
    ...requested.map((domain) => `${SANDBOX_DOMAIN_SUBJECT_PREFIX}${domain}`),
  ];
  // Only reads inside the folder and prints: the shipped read-only rule runs it without asking.
  const readOnly =
    opaque.length === 0 &&
    stdinSubjects.length === 0 &&
    requested.length === 0 &&
    written !== undefined &&
    written.length === 0 &&
    denied === undefined &&
    fromStdin?.hardDeny === undefined &&
    risk !== "critical" &&
    commands.length > 0 &&
    // A redirect to a stream (`2>/dev/null`, `2>&1`) writes no file, so it is read past.
    commands.every((subject) => {
      const words = shellWords(subject.replace(STREAM_REDIRECT, ""));
      // git runs what its repository's config names (a diff driver, a filter, fsmonitor): only from the folder's
      // root, whose `.git/config` and bare `HEAD` the sandbox never lets a command write, never from a subfolder
      // a command could have made into a repository of its own.
      if (words[0] === "git" && text(call["cwd"]) !== undefined && text(call["cwd"]) !== ".") return false;
      return readOnlyCommand(words);
    });
  // A grant for the rest of the chat may cover a build or test command's variants, as the card says.
  const offered = subjects.map((subject) => chatPatterns(subject));
  const patterns = [...new Set(offered.flatMap((entry, index) => entry ?? [escapeGlob(subjects[index] ?? "")]))];
  const widened = offered.flatMap((entry) => (entry === undefined ? [] : [entry[1] ?? ""]));
  return {
    display: {
      title: clip(
        // A card's title is plain text: the command in quotes, not Markdown backticks.
        `Run “${clip(commands.join(" && "), 120)}” in the sandbox${requested.length === 0 ? "" : `, reaching ${requested.join(", ")}`}`,
        300,
      ),
      command: clip(shownArgv([command, ...args]), 4_000),
      ...(stdinShown === undefined ? {} : { stdin: stdinShown }),
      ...(widened.length === 0 ? {} : { forThisChat: clip(widened.join(", "), 600) }),
      ...(opaque.length > 0
        ? {
            detail: `asked every time: it ${opaque.join("; ")}. Split into separate commands without these, it could be approved for good`,
          }
        : commands.length > 1
          ? { detail: `${commands.length} commands; each must be allowed on its own` }
          : {}),
    },
    // An opaque script also carries a subject no realistic allow glob covers.
    subjects,
    ...(widened.length === 0 || patterns.length > 64 ? {} : { sessionMatchers: patterns }),
    ...(readOnly ? { readOnly: true } : {}),
    ...(opaque.length > 0 || stdinOpaque ? { onceOnly: true } : {}),
    // No allow rule or grant lifts a line no rule can read, but one written for it (`--match-unparsed`).
    ...(opaque.length > 0 || fromStdin?.unparsed === true ? { unparsed: true } : {}),
    // Deny and ask rules also match what runs as it would be spelled bare: `env curl x` as `curl x`.
    ...(spellings.length > 0 ? { forms: spellings } : {}),
    risk,
    reasons,
    // A host nobody granted is a person's to approve, for this call alone: no rule, chat grant or unattended run answers it.
    ...(requested.length > 0 ? { attendedOnly: true } : {}),
    ...(denied === undefined
      ? fromStdin?.hardDeny === undefined
        ? unrequestable === undefined
          ? spelledAsDomain
            ? { hardDeny: `sandbox.run refused: a program named ${SANDBOX_DOMAIN_SUBJECT_PREFIX}… cannot be told from a requested domain` }
            : {}
          : {
              hardDeny: `sandbox.run refused: requestDomains takes one host by name, with an optional :port (pypi.org, api.example.com:443): ${JSON.stringify(unrequestable)} is a pattern, an address, a paste site or no host`,
            }
        : { hardDeny: fromStdin.hardDeny.replace("the command", "the script on standard input") }
      : { hardDeny: `sandbox.run refused: the command ${denied.reason}` }),
  };
}

/** The subject of a domain a `sandbox.run` asks for (`requestDomains`). */
const SANDBOX_DOMAIN_SUBJECT_PREFIX = "net:";

/** `requestDomains` as asked: each in stored form where it is one, else as written (the handler refuses it). */
function requestedDomainsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const domains = value.flatMap((entry) => {
    const written = text(entry);
    return written === undefined ? [] : [requestableSandboxDomain(written) ?? clip(written.trim().toLowerCase(), 260)];
  });
  return [...new Set(domains)].slice(0, SANDBOX_REQUEST_DOMAINS_MAX);
}

/** One argv word as the shell would need it written, so `shellWords` reads it back unchanged. */
function quoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function assessHttpRequest(input: unknown): CallAssessment {
  const call = record(input);
  const method = text(call["method"]) ?? "GET";
  const url = text(call["url"]) ?? "";
  const credential = text(call["credentialRef"]);
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const reasons: string[] = [];
  // A DELETE removes what it names: it is rated high, as a credentialed change is.
  let risk: RiskLevel = method === "GET" ? "low" : method === "DELETE" ? "high" : "medium";
  if (method !== "GET")
    reasons.push(
      method === "DELETE" ? "sends a DELETE request that removes remote data" : `sends a ${method} request that may change remote state`,
    );
  if (credential !== undefined) {
    risk = maxRisk(risk, method === "GET" ? "medium" : "high");
    reasons.push(`authenticates with credential ${credential}`);
  }
  const body = text(call["body"]);
  return {
    display: {
      title: clip(`${method} ${host}${credential === undefined ? "" : ` with credential ${credential}`}`, 300),
      command: clip(`${method} ${url}`, 4_000),
      host: clip(host, 300),
      ...(body === undefined ? {} : { detail: clip(`Body: ${body}`, 2_000) }),
    },
    // A credential is its own subject: a rule must cover spending it,
    // and the messaging profile's deny matches `credential:*`.
    subjects: [`${method} ${url}`, ...(credential === undefined ? [] : [`credential:${credential}`])],
    risk,
    reasons,
    // Its sink, per call: a stored credential is `credential`; a bare GET's
    // only model-chosen payload is its URL, judged as a known URL; a body or a header is a payload.
    ...(credential !== undefined
      ? { sink: "credential" as const }
      : method === "GET" && text(call["body"]) === undefined && !hasHeaders(call["headers"])
        ? { sink: "network" as const, urlOnly: true, urls: [url] }
        : { sink: "network" as const, urlOnly: false }),
  };
}

/** Whether a request names any header of its own. */
function hasHeaders(headers: unknown): boolean {
  return typeof headers === "object" && headers !== null && Object.keys(headers).length > 0;
}

export function assessMessagingSend(input: unknown, context?: Pick<InvocationContext, "messagingReplyTo">): CallAssessment {
  const content = text(record(input)["content"]) ?? "";
  const artifactId = text(record(input)["artifactId"]);
  return {
    display: {
      title: artifactId === undefined ? "Reply in this conversation" : clip(`Reply in this conversation with artifact ${artifactId}`, 300),
      detail: clip(content, 2_000),
    },
    subjects: [],
    risk: "low",
    reasons: [],
    // Others may read a reply not known at admission to be one-to-one (`private-group-reply`).
    ...(context?.messagingReplyTo !== undefined && context.messagingReplyTo.audience !== "one-to-one" ? { groupDestination: true } : {}),
  };
}

/**
 * `messaging.send_to`. A file sent by `path` is read by the caller and
 * passed as `file`: the card shows its name, size and sha256, and the hash is
 * the call's `contentHash`, so the handler sends only the bytes shown. A path
 * the chat may not read, or both or neither of `artifactId` and `path`, is
 * refused here.
 */
export function assessMessagingSendTo(input: unknown, file?: FolderFileReading): CallAssessment {
  const call = record(input);
  // The recipient as the call names it (`to`, or the older `chatId`): shown, and what a rule matches.
  const destination = `${text(call["connectionId"]) ?? "?"}:${text(call["to"]) ?? text(call["chatId"]) ?? "?"}`;
  const isFile = call["kind"] === "file";
  const byPath = isFile && text(call["path"]) !== undefined;
  const base: CallAssessment = {
    display: {
      title: clip(isFile ? `Send artifact ${text(call["artifactId"]) ?? "?"} to ${destination}` : `Send a message to ${destination}`, 300),
      destination: clip(destination, 300),
      detail: clip((isFile ? text(call["caption"]) : text(call["content"])) ?? "", 2_000),
    },
    subjects: [destination],
    risk: "medium",
    reasons: ["sends a message to another conversation"],
  };
  if (!byPath) return base;
  if (text(call["artifactId"]) !== undefined) return { ...base, hardDeny: "messaging.send_to takes exactly one of artifactId and path" };
  if (file === undefined || "refused" in file)
    return {
      ...base,
      hardDeny: clip(
        `messaging.send_to refused: ${file === undefined ? "files from the chat's folder cannot be sent here" : file.refused}`,
        500,
      ),
    };
  const caption = text(call["caption"]);
  return {
    ...base,
    display: {
      ...base.display,
      title: clip(`Send ${file.name} (${file.size} bytes) to ${destination}`, 300),
      detail: clip(`${folderFileDetail(file)}${caption === undefined ? "" : `\nCaption: ${caption}`}`, 2_000),
    },
    reasons: [...base.reasons, "sends a file from the chat's folder"],
    contentHash: file.sha256,
  };
}

/**
 * The browser is one permission to a person: "use the browser". Allowing any
 * browser call for the task, or always, allows them all — a session, each page
 * of a site, a click — instead of asking once per step.
 */
const BROWSER_SCOPE_GROUP = "browser.*";
/** Web search's group: the tool alone, so allowing it for a task or always never allows `web_fetch` too. */
const WEB_SCOPE_GROUP = "web_search";

/** The host of a URL as a card names it, or the text as given. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A URL as a card's title names a page: its host, then its path and query (a site's root is the host alone), no fragment. */
function hostAndPathOf(url: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
    return `${parsed.host}${clip(rest, 160)}`;
  } catch {
    return url;
  }
}

export function assessBrowserCreateSession(input: unknown): CallAssessment {
  const url = text(record(input)["url"]);
  if (url === undefined)
    return {
      display: { title: "Use the browser" },
      subjects: [],
      risk: "low",
      reasons: [],
      scopeGroup: BROWSER_SCOPE_GROUP,
      browserSteps: [],
    };
  const host = hostOf(url);
  // A navigation, judged by the known-URL rule under taint, fragment included.
  return {
    // The page, not only its site: two pages on one site are two questions, and must not read as one asked twice.
    display: { title: clip(`Use the browser to open ${hostAndPathOf(url)}`, 300), host: clip(host, 300), command: clip(url, 4_000) },
    subjects: [host],
    risk: "medium",
    reasons: [],
    scopeGroup: BROWSER_SCOPE_GROUP,
    urls: [url],
    browserSteps: [{ kind: "navigate", url }],
  };
}

/** A browser call that reaches nothing new: a screenshot, closing the session. */
export function assessBrowserSession(title: string): (input: unknown) => CallAssessment {
  return () => ({ display: { title }, subjects: [], risk: "low", reasons: [], scopeGroup: BROWSER_SCOPE_GROUP });
}

/**
 * The words of a control that commits something — pays, buys, books, orders,
 * confirms, sends, submits: a click on it is asked about as a submit, never
 * covered by "the browser".
 */
/**
 * The fields where Enter searches or picks a suggestion rather than submitting
 * a form: a search box, and a field that suggests as you type. Enter there is
 * a step of the browser like any other (Google Flights' fields take Enter to
 * choose an airport and to search).
 */
const SEARCHING_ROLES = new Set(["searchbox", "combobox"]);
/** The roles a person presses: a button-like control whose label says what pressing it does. */
const PRESSED_ROLES = new Set(["button", "link", "menuitem", "submit"]);

/** The roles a person checks or picks: a protected field's answer is one of these as much as typed text. */
const CHOSEN_ROLES = new Set(["checkbox", "radio", "switch", "option", "menuitemcheckbox", "menuitemradio"]);
/** The roles of fields that can hold a password, one-time code, PIN or card detail. */
const SECRET_ELEMENT_ROLES = new Set(["textbox", "combobox", "spinbutton", "searchbox"]);
const SECRET_FIELD_LABEL =
  /\b(?:otp|one[- ]?time|passcode|password|passwd|pin|cvc|cvv|csc|card[- ]?num(?:ber)?|cc-(?:number|num|csc|exp|[a-z-]+)|security[- ]?code|iban|ssn)\b/i;
const SECRET_FIELD_HARD_DENY = "This is a password/code/card field: ask the person to fill it (`browser.request_handoff`)";

function isSecretElement(element: ObservedElement | undefined): boolean {
  if (element === undefined) return false;
  if (element.secret === true) return true;
  if (element.role !== undefined && !SECRET_ELEMENT_ROLES.has(element.role)) return false;
  return element.text !== undefined && SECRET_FIELD_LABEL.test(element.text);
}

/**
 * Whether a step would fill a protected field, from
 * what the observation said of its element and the value it would type or
 * pick. A typing, a choice, or a check of one is refused on every host; the
 * browser checks the field's own name, id and labels again before it acts.
 */
function protectedStepOf(call: Readonly<Record<string, unknown>>, element: ObservedElement | undefined): ProtectedFieldClass | undefined {
  const kind = text(call["kind"]) ?? "click";
  const filling = kind === "type" || kind === "select";
  const choosing = (kind === "click" || kind === "press") && element?.role !== undefined && CHOSEN_ROLES.has(element.role);
  if (!filling && !choosing) return undefined;
  // A value counts only as a first-person attestation: it is also every search a person types.
  return protectedFieldClass([element?.text]) ?? (filling ? protectedValueClass(text(call["value"])) : undefined);
}

/** What the latest observation said of an action's element, when the browser tools know it. */
export interface ObservedElement {
  readonly role?: string | undefined;
  readonly text?: string | undefined;
  /** A control that submits its form: "Apply" on it commits. */
  readonly submitsForm?: boolean | undefined;
  /** A control or field inside a strict search form. */
  readonly searchForm?: boolean | undefined;
  /** A searchbox or combobox inside a form that is not a search form: Enter in it may submit that form. */
  readonly inForm?: boolean | undefined;
  /** A stage profile's final step: pressing it is refused. */
  readonly finalStep?: boolean | undefined;
  /** A password, one-time-code, PIN or card field: filling it is refused and its value is never shown on a card. */
  readonly secret?: boolean | undefined;
  /** Origin of the child frame this element is inside, when the element belongs to a child frame. */
  readonly frame?: string | undefined;
  /** A link's absolute destination, as the observation listed it: where `open_in_tab` on its ref goes. */
  readonly href?: string | undefined;
}

/**
 * `browser.act`. An upload by `path` is read by the caller and passed as
 * `file`: the card shows the file's name, size and sha256, and the hash is
 * the call's `contentHash`. A path the chat may not read, a path on any other
 * kind, or both or neither of `artifactId` and `path` on an upload, is
 * refused here. `dismissedDialog` is the message of the last dialog Tavi
 * dismissed on the session's page: an armed accept is asked about as what
 * that dialog asked.
 */
export function assessBrowserAct(
  input: unknown,
  element?: ObservedElement,
  file?: FolderFileReading,
  page?: string,
  dismissedDialog?: string,
): CallAssessment {
  const call = record(input);
  const kind = text(call["kind"]) ?? "click";
  const assessment =
    kind === "open_in_tab" ? assessBrowserOpenInTab(call, element) : assessBrowserActCall(input, element, page, dismissedDialog);
  // A stage profile's final step is refused, not asked: the person reviews and submits it themselves.
  if (element?.finalStep === true && ["click", "press", "submit", "open_in_tab"].includes(kind)) {
    return {
      ...assessment,
      hardDeny:
        "browser.act refused: this is the form's or booking's last step; Tavi stops before it, and the person reviews and submits it in the live view (browser.request_handoff)",
    };
  }
  if (isSecretElement(element) && (kind === "type" || kind === "select" || (kind === "press" && pressTypes(text(call["value"]) ?? "")))) {
    return { ...assessment, hardDeny: SECRET_FIELD_HARD_DENY };
  }
  const dialog = record(call["dialog"]);
  if (dialog["promptText"] !== undefined && text(dialog["promptText"]) !== undefined) {
    return {
      ...assessment,
      hardDeny: "answering a prompt dialog with text is the person's: ask the person in the live view (`browser.request_handoff`)",
    };
  }
  const shielded = protectedStepOf(call, element);
  if (shielded !== undefined) return { ...assessment, hardDeny: clip(`browser.act refused: ${protectedFieldRefusal(shielded)}`, 500) };
  if (text(call["path"]) === undefined) return assessment;
  if (call["kind"] !== "upload") return { ...assessment, hardDeny: "browser.act takes a path only to upload a file" };
  if (text(call["artifactId"]) !== undefined)
    return { ...assessment, hardDeny: "browser.act upload takes exactly one of artifactId and path" };
  if (file === undefined || "refused" in file)
    return {
      ...assessment,
      hardDeny: clip(
        `browser.act refused: ${file === undefined ? "files from the chat's folder cannot be uploaded here" : file.refused}`,
        500,
      ),
    };
  return {
    ...assessment,
    display: {
      title: clip(`Browser upload of ${file.name} (${file.size} bytes) on ${text(call["ref"]) ?? "an element"}`, 300),
      detail: clip(folderFileDetail(file), 2_000),
    },
    reasons: [...assessment.reasons, "sends a file from the chat's folder to the page"],
    contentHash: file.sha256,
  };
}

/**
 * `browser.act {kind:"open_in_tab"}`: a navigation, in a new tab of the
 * session, so it is asked about as `browser.navigate` is — for the host it
 * opens, under the same rules (`ruleAliases`) — never as an action on the page
 * it leaves. The URL is the link's `href` as the session's observation listed
 * it, or the one in `value`; the tools layer reads the destination's policy
 * (the allowlist, a refused scheme or private address) on top of this.
 */
function assessBrowserOpenInTab(call: Readonly<Record<string, unknown>>, element: ObservedElement | undefined): CallAssessment {
  const ref = text(call["ref"]);
  const value = text(call["value"]);
  const url = ref === undefined ? value : element?.href;
  const refusal =
    ref !== undefined && value !== undefined
      ? "browser.act open_in_tab takes a link's ref or a URL in value, not both"
      : url === undefined
        ? ref === undefined
          ? "browser.act open_in_tab needs a link's ref or the URL to open in value"
          : `${ref} is not a link with an href in the session's latest observation: open_in_tab takes a link's ref, or the URL in value`
        : undefined;
  const navigation = assessBrowserNavigate({ url: url ?? "" });
  const host = navigation.display.host ?? "";
  return {
    ...navigation,
    display: { ...navigation.display, title: clip(`Open ${host} in a new browser tab`, 300) },
    // A rule a person set on browser.navigate holds a new tab's navigation too.
    ruleAliases: ["browser.navigate"],
    ...(refusal === undefined ? {} : { hardDeny: refusal }),
  };
}

/**
 * What one browser step is to the taint step: typing
 * text (`type`, a printable key, a `select` is a choice the page offers so
 * not), a submit, upload, download or committing press (`send`, asked once
 * under taint and refused in a run nobody attends), or nothing that leaves (`inert`: a click, a scroll, a
 * named key, going back to a page already visited).
 */
function browserStepOf(kind: string, value: string, governed: boolean, page: string | undefined): BrowserStep {
  if (governed) return { kind: "send" };
  const typing = kind === "type" || (kind === "press" && pressTypes(value));
  if (typing) return { kind: "type", ...(page === undefined ? {} : { url: page }) };
  return { kind: "inert" };
}

/** Keys that put no character in a field: moving, deleting, leaving, and the function keys. */
const NON_PRINTING_KEYS = new Set([
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "tab",
  "escape",
  "esc",
  "pageup",
  "pagedown",
  "home",
  "end",
  "backspace",
  "delete",
  "insert",
  "enter",
  "return",
  "numpadenter",
  "capslock",
  "numlock",
  "scrolllock",
  "pause",
  "printscreen",
  "contextmenu",
  "shift",
  "control",
  "alt",
  "meta",
  "controlormeta",
]);
/** Modifiers that make a press a shortcut rather than a character. */
const SHORTCUT_MODIFIERS = new Set(["control", "alt", "meta", "controlormeta"]);

/**
 * Whether a `press` types a character, as Playwright presses it: one
 * character, or a named key that types one (`KeyA`, `Shift+A`, `Digit5`,
 * `Minus`, `Space`), anything but a key on the non-printing list or a
 * shortcut held with Control, Alt or Meta.
 */
function pressTypes(value: string): boolean {
  // One character, `+` included, is itself.
  if ([...value].length === 1) return /\S/u.test(value);
  const parts = value
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
  const key = parts.at(-1);
  if (key === undefined) return false;
  if (parts.slice(0, -1).some((modifier) => SHORTCUT_MODIFIERS.has(modifier))) return false;
  return !NON_PRINTING_KEYS.has(key) && !/^f([1-9]|1\d|2[0-4])$/u.test(key);
}

/**
 * Whether `element` is a search field: Enter in it searches, and typing a query
 * into it fills nothing. A searchbox or combobox on its own, or any field of a
 * strict search form; in another form (a checkout's), Enter may submit it.
 */
export function exemptAsSearch(element: ObservedElement | undefined): boolean {
  return element?.searchForm === true || (element?.role !== undefined && SEARCHING_ROLES.has(element.role) && element.inForm !== true);
}

/**
 * Whether pressing `element` sends its form whatever its label says: a submit
 * outside a strict search form, other than a filter form's own buttons.
 */
export function commitsFormSubmit(element: ObservedElement | undefined): boolean {
  return formSendCommits(element?.submitsForm === true, element?.searchForm, element?.text);
}
const POSTING_LABEL =
  /(?<![\p{L}\p{N}_])(?:post|publish|reply|veröffentlichen|posten|antworten|publier|poster|répondre|publicar|responder|plaatsen|publiceren|beantwoorden|publicera|posta|svara|pubblica|pubblicare|rispondi|rispondere|opublikuj|odpowiedz|публикувай|отговори)(?![\p{L}\p{N}_])/iu;

function commitHeadline(category: CommitCategory | undefined, label: string): string {
  switch (category) {
    case "pay":
      return "Pays or orders";
    case "send":
      return POSTING_LABEL.test(label) ? "Posts" : "Sends or submits";
    case "account":
      return "Registers or authorizes";
    case "legal":
      return "Accepts or approves";
    case "destructive":
      return "Deletes or cancels";
    case undefined:
      return "Submits a form";
  }
}

function assessBrowserActCall(input: unknown, element?: ObservedElement, page?: string, dismissedDialog?: string): CallAssessment {
  const call = record(input);
  const kind = text(call["kind"]) ?? "click";
  // Enter in a form field submits it, as `submit` does: asked about the same way — with a modifier
  // (Control+Enter), as a bare newline, and as a newline typed key by key, which Playwright presses as Enter.
  const typed = text(call["value"]);
  const value = typed ?? "";
  // A plain link is observed by its href with no role, and the browser re-checks its press as one (QA 1803).
  const pressed = element !== undefined && (element.role === undefined ? element.href !== undefined : PRESSED_ROLES.has(element.role));
  const label = element?.text ?? "";
  // "Apply" commits only on a control that submits its form; "Check all that apply" and "Apply filters" never do.
  const category = pressed ? commitCategory(label, element?.submitsForm === true) : undefined;
  const commitsForm = pressed && commitsFormSubmit(element);
  const committing = category !== undefined || commitsForm;
  const searching = exemptAsSearch(element);
  const submitsByKey =
    !searching &&
    ((kind === "press" &&
      (/(^|\+)(enter|return|numpadenter)$/i.test(value) || /^[\r\n]+$/.test(value) || (pressed && /^( |space)$/i.test(value)))) ||
      (kind === "type" && call["mode"] === "keys" && /[\r\n]/.test(value)));
  // A click (or key) on a control that commits — "Place order", "Pay", "Book", "Send", or a non-search form submit — is a submit.
  const submitsByClick = committing && (kind === "click" || kind === "press");
  const dialogAccept = record(call["dialog"])["accept"] === true;
  const dialogCategory = dialogAccept ? (commitCategory(dismissedDialog ?? "") ?? "confirm") : undefined;
  const details = [
    ...(typed === undefined || isSecretElement(element) ? [] : [`Value: ${typed}`]),
    ...(dialogAccept && dismissedDialog !== undefined ? [`Dialog: ${dismissedDialog}`] : []),
  ];
  const governed = kind === "submit" || kind === "upload" || kind === "download" || submitsByKey || submitsByClick || dialogAccept;
  const effectivePage = element?.frame ?? page;
  const pageHost = effectivePage === undefined ? "" : hostOf(effectivePage);
  const commitTitle = submitsByClick && pageHost !== "" ? `${commitHeadline(category, label)} on ${pageHost}` : undefined;
  return {
    display: {
      title: clip(
        commitTitle ??
          // The element by what it shows (its text), never its internal ref (`el-2`), which says nothing to a person.
          `Browser ${kind} on ${label.trim() !== "" ? `“${clip(label.replace(/\s+/g, " ").trim(), 80)}”` : (BROWSER_ACTION_KINDS as readonly string[]).includes(kind) && !browserActionNeedsRef(kind as BrowserActionKind) ? "the page" : "an element"}`,
        300,
      ),
      ...(commitTitle !== undefined ? { host: clip(pageHost, 300) } : {}),
      ...(details.length === 0 ? {} : { detail: clip(details.join("\n"), 2_000) }),
    },
    // An Enter that can submit a form, or an armed dialog accept, is a submit to the rules that ask about one.
    subjects: [submitsByKey || submitsByClick || dialogAccept ? "submit" : kind],
    risk: governed ? "high" : "medium",
    reasons: governed
      ? [
          submitsByClick
            ? `presses ${JSON.stringify(clip(label, 80))}${category === undefined ? "" : ` (${category})`}, which can pay, book, order or send`
            : dialogAccept
              ? `accepts a page dialog (${dialogCategory}), which can confirm or commit an action`
              : submitsByKey
                ? "presses Enter, which can submit a form"
                : `${kind}s through the browser`,
        ]
      : [],
    // A submit, upload or download is its own question, never "the browser".
    ...(governed ? {} : { scopeGroup: BROWSER_SCOPE_GROUP }),
    browserSteps: [browserStepOf(kind, value, governed, effectivePage)],
  };
}

/** The most steps a batch takes; one past `BROWSER_BATCH_FILL_STEPS` is only filling a form's fields. */
export const BROWSER_BATCH_MAX_STEPS = 12;
/** The most steps a batch of any kind takes. */
export const BROWSER_BATCH_FILL_STEPS = 5;
/**
 * The roles a long batch may click: a box ticked or a choice made. Not a
 * switch or a menu item, which often save the moment they are clicked.
 */
const FILL_CLICK_ROLES = new Set(["checkbox", "radio"]);

/**
 * Why a batch of more than `BROWSER_BATCH_FILL_STEPS` steps is refused, or
 * `undefined`: past five, a batch may only fill a form — type (without a
 * trailing Enter, or any newline when typed key by key), select, or tick an observed checkbox or radio that submits
 * nothing — so a long one never hides a click that moves on or commits behind
 * its many fields.
 */
export function longBatchRefusal(actions: readonly unknown[], elementOf: (ref: string) => ObservedElement | undefined): string | undefined {
  if (actions.length <= BROWSER_BATCH_FILL_STEPS) return undefined;
  const refuse = (index: number, why: string) =>
    `a batch of more than ${BROWSER_BATCH_FILL_STEPS} steps only fills a form (type, select, or a checkbox or radio click); step ${index + 1} ${why}: send at most ${BROWSER_BATCH_FILL_STEPS} steps, or that one through browser.act`;
  for (const [index, action] of actions.entries()) {
    const step = record(action);
    const kind = text(step["kind"]) ?? "click";
    if (kind === "select") continue;
    if (kind === "type") {
      // `value` is the schema's field (`BatchActionSchema`); `text` is read too, for a step written the old way.
      // Typed key by key, a newline anywhere in the value is pressed as Enter, as the single-step rule reads it.
      const typedValue = text(step["value"]) ?? text(step["text"]) ?? "";
      const enter = step["mode"] === "keys" ? /[\r\n]/ : /[\r\n]$/;
      if (enter.test(typedValue) || step["submit"] === true) return refuse(index, "types an Enter");
      continue;
    }
    if (kind !== "click") return refuse(index, `is a ${kind}`);
    const ref = text(step["ref"]);
    const element = ref === undefined ? undefined : elementOf(ref);
    if (element === undefined) return refuse(index, "clicks an element not in the latest observation");
    if (!FILL_CLICK_ROLES.has(element.role ?? "")) return refuse(index, `clicks a ${element.role ?? "control"}`);
    if (element.submitsForm === true || element.finalStep === true) return refuse(index, "clicks a control that sends the form");
  }
  return undefined;
}

/**
 * `browser.batch`: its actions as `browser.act`
 * assesses each, at the highest risk among them, asked about as the browser. A
 * submit, upload, download or Enter (outside a search box or suggesting field) is its own question, so it is never part
 * of a batch: refused before anyone is asked.
 */
export function assessBrowserBatch(
  input: unknown,
  elementOf?: (sessionId: string, ref: string) => ObservedElement | undefined,
  pageOf?: (sessionId: string) => string | undefined,
): CallAssessment {
  const call = record(input);
  const actions = Array.isArray(call["actions"]) ? call["actions"] : [];
  const sessionId = text(call["sessionId"]);
  const page = sessionId === undefined ? undefined : pageOf?.(sessionId);
  const assessed = actions.map((action) => {
    const ref = text(record(action)["ref"]);
    return assessBrowserAct(
      { ...record(action), sessionId: call["sessionId"] },
      sessionId === undefined || ref === undefined ? undefined : elementOf?.(sessionId, ref),
      undefined,
      page,
    );
  });
  const governed = assessed.some((assessment) => assessment.scopeGroup === undefined);
  // A step refused alone (a protected field) refuses the batch, and so does a long batch that does more than fill fields.
  const refused =
    assessed.find((assessment) => assessment.hardDeny !== undefined)?.hardDeny ??
    longBatchRefusal(actions, (ref) => (sessionId === undefined ? undefined : elementOf?.(sessionId, ref)));
  const kinds = actions.map((action) => text(record(action)["kind"]) ?? "click");
  // Each step by the field it acts on, as a single step's card names it, and each value by that field: the
  // values are what is approved, and "type, type, type" ties none of them to a field.
  const named = actions.map((action, index) => {
    const step = record(action);
    const kind = kinds[index] ?? "click";
    const ref = text(step["ref"]);
    const element = sessionId === undefined || ref === undefined ? undefined : elementOf?.(sessionId, ref);
    const label = element?.text?.replace(/\s+/g, " ").trim() ?? "";
    const field = label === "" ? undefined : `“${clip(label, 60)}”`;
    // What is written into the page: typed text, or the option picked; a scroll's direction is no value.
    const value = kind === "type" || kind === "select" ? (text(step["value"]) ?? text(step["text"])) : undefined;
    return {
      title: field !== undefined ? `${kind} ${field}` : ref !== undefined ? `${kind} an element` : kind,
      row: value === undefined || isSecretElement(element) ? undefined : `${field ?? `Step ${index + 1}`} ← ${clip(value, 200)}`,
    };
  });
  const rows = named.flatMap((step) => (step.row === undefined ? [] : [step.row]));
  return {
    display: {
      title: clip(`Browser: ${named.map((step) => step.title).join(", ")}`, 300),
      ...(rows.length === 0 ? {} : { detail: clip(rows.join("\n"), 2_000) }),
    },
    subjects: [...new Set(kinds)],
    risk: assessed.reduce<RiskLevel>((risk, assessment) => maxRisk(risk, assessment.risk), "medium"),
    reasons: [...new Set(assessed.flatMap((assessment) => assessment.reasons))],
    scopeGroup: BROWSER_SCOPE_GROUP,
    // A person's rules on browser.act hold its steps here too.
    ruleAliases: ["browser.act"],
    // Judged one step at a time under taint.
    browserSteps: assessed.flatMap((assessment) => assessment.browserSteps ?? []),
    ...(refused !== undefined
      ? { hardDeny: refused }
      : governed
        ? {
            hardDeny:
              "a submit, upload, download, an Enter key outside a search box, or a press of a control that pays, books, orders or sends goes alone, through browser.act, so it is asked about on its own",
          }
        : {}),
  };
}

export function assessBrowserNavigate(input: unknown): CallAssessment {
  const url = text(record(input)["url"]) ?? "";
  const host = hostOf(url);
  // The subject is the host, not the URL: a subject of the exact URL made
  // "Approve for this task" re-allow only that page, so browsing a site asked
  // once per link. The host is what the card names and what the browser
  // allowlist is kept in, so a grant covers what the person was shown.
  // A navigation, judged by the known-URL rule under taint, fragment included.
  // The title names the page (its path and query), so cards for three records of one site are told apart.
  return {
    display: { title: clip(`Open ${hostAndPathOf(url)} in the browser`, 300), host: clip(host, 300), command: clip(url, 4_000) },
    subjects: [host],
    risk: "medium",
    reasons: [],
    scopeGroup: BROWSER_SCOPE_GROUP,
    urls: [url],
    browserSteps: [{ kind: "navigate", url }],
  };
}

/**
 * `agents.spawn`: a worker as one named agent. Its subject is
 * that agent, so "Approve for this chat" lets the chat start more workers as
 * the same agent — within the tree's limits — not as any agent.
 */
export function assessAgentsSpawn(input: unknown): CallAssessment {
  const call = record(input);
  const agent = text(call["agentDefinitionId"]) ?? "?";
  return {
    display: { title: clip(`Start a worker as ${agent}`, 300), detail: clip(text(call["input"]) ?? "", 2_000) },
    subjects: [`agent:${agent}`],
    risk: "medium",
    reasons: ["runs another agent with this chat's tools, within its limits"],
  };
}

/**
 * Why a search query is shaped like data leaving rather than a question, or
 * `undefined`. Read once the chat holds untrusted content, where an injected
 * page could have written the query to carry data out: a link with a query
 * string, a fragment or a long path segment (the query made the address that
 * collects), a domain whose name is itself a payload, a long encoded run, a
 * card, ID or email, a secret's shape, or a query past 300 characters. An
 * ordinary site in a query (`github.com/facebook/react issues`) is none of these.
 */
export function suspiciousSearchQuery(raw: string): string | undefined {
  // Fullwidth and compatibility forms (`＠`, `．`, `／`) read as what they look like.
  const query = raw.normalize("NFKC");
  if (/\bhttps?:\/\/|\bwww\./i.test(query)) return "the query holds a link";
  if (/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?[?#=]\S/i.test(query) || /(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*[^\s/]{20,}/i.test(query))
    return "the query holds a link that carries data";
  if (/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\/\S/.test(query)) return "the query holds a link to an address";
  if (
    /(?:^|\s)(?:[a-z0-9]+-){3,}[a-z0-9]*\d[a-z0-9-]*\.(?:[a-z0-9-]+\.)*[a-z]{2,}\b/i.test(query) ||
    /\b[a-z0-9-]{25,}\.(?:[a-z0-9-]+\.)*[a-z]{2,}\b/i.test(query)
  )
    return "the query holds a domain whose name carries data";
  const words = query.replace(/\b[a-z]+\b/g, " ");
  if (/[A-Za-z0-9+/=_-]{24,}/.test(words) && /\d/.test(query) && /[A-Za-z]/.test(query)) return "the query holds a long code";
  // Base64 with no digit still switches case often within one word.
  if (query.split(/\s+/).some((word) => word.length >= 20 && (word.match(/[a-z][A-Z]|[A-Z][a-z]/g)?.length ?? 0) >= 6))
    return "the query holds a long code";
  if (/\b(?:\d[ -]?){13,19}\b/.test(query) || /\b\d{3}-\d{2}-\d{4}\b/.test(query)) return "the query holds a card or ID number";
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(query)) return "the query holds an email address";
  if (redactCredentialShapes(query) !== query) return "the query holds what looks like a secret";
  if (query.length > 300) return "the query is over 300 characters";
  return undefined;
}

/**
 * Why a search query carries a credential, or `undefined`: a key, token or
 * private key in the shapes tool output is masked for (`redactToolText`), each
 * anchored on its own prefix, so prose — `bearer bonds`, `max tokens: 512` —
 * never matches. Read in every chat, tainted or not: a secret sent to a search
 * provider is out of the machine whoever wrote the query, so the person who
 * pasted it is asked once before it goes.
 */
export function secretShapedSearchQuery(raw: string): string | undefined {
  const normalized = raw.normalize("NFKC");
  // A private key's armour too, which tool-output masking leaves to the key's own lines.
  const masked = [...redactToolText(normalized).masked, ...(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(normalized) ? ["private-key"] : [])];
  return masked.length === 0
    ? undefined
    : `the query holds what looks like a secret (${[...new Set(masked)].join(", ")}): searching would send it to the search provider`;
}

export function assessWebSearch(input: unknown): CallAssessment {
  const call = record(input);
  const query = text(call["query"]) ?? "";
  const site = text(call["site"]);
  const recency = text(call["recency"]);
  const searched = site === undefined ? query : `${query} ${site}`;
  // Under taint, a query shaped like data leaving asks a person, whatever a rule allows, and an unattended run is
  // refused it; in a chat that read nothing untrusted no injected page wrote it, and it runs as any search.
  const suspicious = suspiciousSearchQuery(searched);
  // A secret's shape asks in every chat, once, whatever a rule or grant allows (`attendedOnly`): the seeded allow
  // rule is for questions, and a key pasted into a query would leave the machine without anyone seeing it go.
  const secret = secretShapedSearchQuery(searched);
  // No subjects: a subject of the exact query would make `session`
  // re-allow only that query, so every rephrasing would ask again. A search is
  // low-risk and its query is not a destination, so the grant a person gives
  // covers the tool for the rest of the task — and survives the taint the
  // first result brings. `always` is a rule for any search, offered
  // under taint too: no query shapes what it allows.
  // A group (approved stays approved): allowing one search allows the task's
  // searches, rather than asking again for each rephrasing — the Sofia–Tampa run asked three times.
  const narrowing = [site === undefined ? undefined : `on ${site}`, recency === undefined ? undefined : `from the last ${recency}`].filter(
    (part): part is string => part !== undefined,
  );
  return {
    display: {
      title: clip(`Search the web for “${clip(query, 200)}”${narrowing.length === 0 ? "" : ` ${narrowing.join(", ")}`}`, 300),
      detail: clip(
        `Query: ${query}${site === undefined ? "" : `\nSite: ${site}`}${recency === undefined ? "" : `\nRecency: ${recency}`}`,
        2_000,
      ),
    },
    subjects: [],
    risk: "low",
    reasons: [
      "sends the query to a search provider",
      ...(secret === undefined ? [] : [secret]),
      ...(suspicious === undefined || (secret !== undefined && /secret/.test(suspicious)) ? [] : [suspicious]),
    ],
    alwaysAnyCall: true,
    scopeGroup: WEB_SCOPE_GROUP,
    ...(suspicious === undefined && secret === undefined ? {} : { askWhenTainted: true }),
    ...(secret === undefined ? {} : { attendedOnly: true }),
  };
}

export interface ObservedDesktopNodeFacts {
  readonly app?: string | undefined;
  readonly bundleId?: string | undefined;
  readonly windowTitle?: string | undefined;
  readonly role?: string | undefined;
  readonly subrole?: string | undefined;
  readonly title?: string | undefined;
}

export function assessDesktopObserve(input: unknown): CallAssessment {
  const call = record(input);
  const app = text(call["app"]) ?? "focused application";
  const blocked = app !== "focused application" && isBlockedDesktopApp(app, app);
  // A screenshot of the screen is for a person watching: no unattended run takes one.
  const captures = call["capture"] === true;
  return {
    display: { title: clip(`Observe desktop application ${app}`, 300) },
    subjects: [app],
    risk: blocked ? "high" : "low",
    reasons: blocked ? [`${app} is a blocked desktop application`] : [],
    ...(blocked ? { hardDeny: `${app} is on the desktop application blocklist` } : {}),
    ...(captures ? { attendedOnly: true } : {}),
  };
}

/**
 * `desktop.act`: every desktop action (clicks included) is `attendedOnly: true` and `askWhenTainted: true`.
 * Unattended runs never drive the desktop.
 */
export function assessDesktopAct(
  input: unknown,
  node?: ObservedDesktopNodeFacts,
  /** The workspace's grant tier for an app, as the gate reads it; absent, the built-in defaults. */
  tierOf: (bundleId: string, app: string) => DesktopAppGrantTier | undefined = defaultDesktopAppGrantTier,
): CallAssessment {
  const call = record(input);
  const kind = text(call["kind"]) ?? "click";
  const app = node?.app ?? text(call["app"]) ?? "";
  const bundleId = node?.bundleId ?? app;
  const ref = text(call["ref"]);
  const title = node?.title ?? "";

  if ((app.length > 0 || bundleId.length > 0) && isBlockedDesktopApp(bundleId, app)) {
    return {
      display: { title: clip(`Desktop ${kind} in ${app || bundleId}`, 300) },
      subjects: [app || bundleId],
      risk: "critical",
      reasons: [`${app || bundleId} is a blocked desktop application`],
      hardDeny: `${app || bundleId} is on the desktop application blocklist`,
      attendedOnly: true,
      askWhenTainted: true,
      onceOnly: true,
    };
  }

  if (node !== undefined && isDesktopCredentialNode(node)) {
    return {
      display: { title: clip(`Desktop ${kind} on credential field`, 300) },
      subjects: [kind],
      risk: "critical",
      reasons: ["targets a desktop credential or password field (AXSecureTextField)"],
      hardDeny: "acting on a desktop password or credential field (AXSecureTextField) is not allowed",
      attendedOnly: true,
      askWhenTainted: true,
      onceOnly: true,
    };
  }

  if (
    node !== undefined &&
    isDesktopAuthDialog({
      bundleId,
      appName: app,
      windowTitle: node.windowTitle,
      role: node.role,
      subrole: node.subrole,
      text: title,
    })
  ) {
    return {
      display: { title: clip(`Desktop ${kind} on authentication dialog`, 300) },
      subjects: [kind],
      risk: "critical",
      reasons: ["targets a system authentication dialog"],
      hardDeny: "acting on a system authentication dialog is not allowed",
      attendedOnly: true,
      askWhenTainted: true,
      onceOnly: true,
    };
  }

  const tier = app.length > 0 || bundleId.length > 0 ? tierOf(bundleId, app) : "full";
  // An app the workspace never granted is refused before anyone is asked: the gate would refuse it anyway.
  if (tier === undefined) {
    return {
      display: { title: clip(`Desktop ${kind} in ${app || bundleId}`, 300) },
      subjects: [app || bundleId],
      risk: "high",
      reasons: [`${app || bundleId} is not granted to this workspace`],
      hardDeny: `${app || bundleId} is not granted desktop control in this workspace: add it to desktop.grantedApps (tavi config set desktop.grantedApps)`,
      attendedOnly: true,
      askWhenTainted: true,
      onceOnly: true,
    };
  }
  if (tier === "view-only") {
    return {
      display: { title: clip(`Desktop ${kind} in ${app || bundleId}`, 300) },
      subjects: [app || bundleId],
      risk: "high",
      reasons: ["browsers have a view-only desktop grant tier"],
      hardDeny: `${app || bundleId} is a web browser (view-only on desktop); use the browser tools instead`,
      attendedOnly: true,
      askWhenTainted: true,
      onceOnly: true,
    };
  }
  // As the gate: a plain left click or a scroll, nothing else (a right click's menu has Paste, a drag drops text).
  const clickOnlyAllowed = desktopClickOnlyAllows({
    kind,
    button: text(call["button"]),
    modifiers: Array.isArray(call["modifiers"]) ? call["modifiers"] : undefined,
  });
  if (tier === "click-only" && !clickOnlyAllowed) {
    return {
      display: { title: clip(`Desktop ${kind} in ${app || bundleId}`, 300) },
      subjects: [app || bundleId],
      risk: "high",
      reasons: ["terminals and IDEs have a click-only desktop grant tier"],
      hardDeny: `${app || bundleId} has a click-only desktop grant tier; only a plain left click or a scroll is allowed`,
      attendedOnly: true,
      askWhenTainted: true,
      onceOnly: true,
    };
  }

  // A ⌘ or Ctrl shortcut that sends or deletes is a commit of its own, named by the keys, as the gate names it.
  const shortcut =
    kind === "press"
      ? desktopCommitShortcut(
          text(call["key"]) ?? "Enter",
          Array.isArray(call["modifiers"])
            ? call["modifiers"].filter((modifier): modifier is string => typeof modifier === "string")
            : undefined,
        )
      : undefined;
  const commitLabel = shortcut ?? title;
  const commit =
    shortcut !== undefined
      ? /enter|return/.test(shortcut)
        ? "send"
        : "destructive"
      : title.length > 0
        ? commitCategory(title)
        : undefined;
  const reasons: string[] = ["controls a desktop application"];
  if (commit !== undefined) {
    reasons.push(
      shortcut === undefined
        ? `presses a ${commit} commit control ("${clip(title, 80)}")`
        : `presses ${shortcut}, which can ${commit === "send" ? "send" : "delete"}`,
    );
  }
  if (tier === "warning") {
    reasons.push(`${app || bundleId} is in the warning grant tier`);
  }

  // The element as a person sees it: its label, else its kind ("the text area"), never its internal `ax-N` ref.
  const role = desktopRoleWords(node?.role);
  const target = title.length > 0 ? `“${clip(title, 80)}”` : role !== undefined ? `the ${role}` : ref !== undefined ? "an element" : "";
  const targetLabel = target === "" ? "" : ` ${kind === "type" ? "into" : "on"} ${target}`;
  const appLabel = (app || bundleId).length > 0 ? ` in ${app || bundleId}` : "";
  // What is typed or pressed is what the person approves: on the card, not only under Details.
  const typedText = kind === "type" ? text(call["text"]) : undefined;
  const pressedKey =
    kind === "press"
      ? [...(Array.isArray(call["modifiers"]) ? call["modifiers"].filter((key) => typeof key === "string") : []), text(call["key"]) ?? ""]
          .filter((key) => key !== "")
          .join("+")
      : "";
  const detail = typedText !== undefined ? `Text: ${typedText}` : pressedKey !== "" ? `Key: ${pressedKey}` : undefined;

  return {
    display: {
      title: clip(`Desktop ${kind}${targetLabel}${appLabel}`, 300),
      ...(detail === undefined ? {} : { detail: clip(detail, 2_000) }),
    },
    // `commit` and `warning-tier` are what an approval of this card lets the gate pass, and nothing else.
    // The app and the commit's label are carried with them, so the call acts on what the card showed.
    subjects: [
      kind,
      ...(app || bundleId
        ? [...(reservedDesktopSubject(app || bundleId) ? [] : [app || bundleId]), `${DESKTOP_APP_SUBJECT}${bundleId || app}`]
        : []),
      ...(commit === undefined ? [] : ["commit", `${DESKTOP_COMMIT_LABEL_SUBJECT}${commitLabel}`]),
      ...(tier === "warning" ? ["warning-tier"] : []),
    ],
    risk: commit !== undefined || tier === "warning" ? "high" : "medium",
    reasons,
    attendedOnly: true,
    askWhenTainted: true,
    ...(commit !== undefined || tier === "warning" ? { onceOnly: true } : {}),
  };
}

/** An accessibility role in words: `AXTextArea` → "text area"; `undefined` for none or a bare `AXUnknown`. */
function desktopRoleWords(role: string | undefined): string | undefined {
  const words = (role ?? "")
    .replace(/^AX/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words === "" || words === "unknown" ? undefined : clip(words, 40);
}

/** The subject naming the app a `desktop.act` card read its element in. */
const DESKTOP_APP_SUBJECT = "desktop-app:";
/** The subject naming the label of the commit control a `desktop.act` card named. */
const DESKTOP_COMMIT_LABEL_SUBJECT = "commit-label:";

/** Whether `subject` reads as one of the subjects an approval binds: an app's own name never stands as one. */
function reservedDesktopSubject(subject: string): boolean {
  return subject.startsWith(DESKTOP_APP_SUBJECT) || subject.startsWith(DESKTOP_COMMIT_LABEL_SUBJECT);
}

/** What an approved `desktop.act` card named, from the checkpointed verdict: its app, and its commit's label. */
export function approvedDesktopTarget(assessedSubjects: readonly string[] | undefined): {
  readonly app?: string;
  readonly commitLabel?: string;
} {
  // The last: the plain app subject before them is the app's own name, which never takes a reserved prefix.
  const named = (prefix: string): string | undefined =>
    assessedSubjects?.findLast((subject) => subject.startsWith(prefix))?.slice(prefix.length);
  const app = named(DESKTOP_APP_SUBJECT);
  const commitLabel = named(DESKTOP_COMMIT_LABEL_SUBJECT);
  return { ...(app === undefined ? {} : { app }), ...(commitLabel === undefined ? {} : { commitLabel }) };
}

export function assessDesktopComputerUse(input: unknown): CallAssessment {
  const call = record(input);
  const app = text(call["app"]) ?? "";
  const goal = text(call["goal"]) ?? "";
  const blocked = app.length > 0 && isBlockedDesktopApp(app, app);
  return {
    display: {
      title: clip(`Desktop computer use${app.length > 0 ? ` in ${app}` : ""}: ${clip(goal, 160)}`, 300),
      detail: clip(goal, 2_000),
    },
    subjects: app.length > 0 ? [app] : ["desktop"],
    risk: "high",
    reasons: ["runs a multi-step desktop computer-use loop"],
    attendedOnly: true,
    askWhenTainted: true,
    onceOnly: true,
    ...(blocked ? { hardDeny: `${app} is on the desktop application blocklist` } : {}),
  };
}
