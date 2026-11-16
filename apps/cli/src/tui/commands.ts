import { parsePluginCommandLine } from "@tavi/contracts";

import { FORM_COMMANDS, type FormId } from "./forms.js";
import { PANES, type Pane } from "./panes.js";
import { divider } from "./theme.js";

/**
 * What a line typed at `tavi chat`'s prompt asks for, when it is a command: a
 * status pane, a form, the list of them, or a command that does not exist. Anything else is a prompt, or an answer.
 */
export type ChatCommand =
  | { readonly kind: "pane"; readonly pane: Pane }
  | { readonly kind: "form"; readonly form: FormId; readonly words: readonly string[] }
  | { readonly kind: "help" }
  /**
   * The next prompt starts a chat of its own (a side chat while Home is on),
   * rather than continuing the one followed; `topic`, when
   * typed, is that prompt.
   */
  | { readonly kind: "side"; readonly topic?: string }
  /** With Home on, the same as `/side`, with no topic. */
  | { readonly kind: "new" }
  /** Back to the person's Home. */
  | { readonly kind: "home" }
  /** The recent chats, Home first. */
  | { readonly kind: "chats" }
  /** Follow chat `taskId` and continue it, as `--attach` does; undefined when no id was typed. */
  | { readonly kind: "open"; readonly taskId?: string }
  /** Fresh context: the chat shown's next message starts a new epoch. */
  | { readonly kind: "compact" }
  /** What the chat shown read that Tavi does not trust: the status line's chip, in full. */
  | { readonly kind: "taint" }
  /** `text` sent into the running turn; undefined when none was typed. */
  | { readonly kind: "steer"; readonly text?: string }
  /**
   * The open questions of the chat shown — its own and its workers' —
   * listed, or, with a number, that one answered with `text`.
   */
  | { readonly kind: "answer"; readonly index?: number; readonly text?: string }
  /**
   * The chat shown's own model: named, or — with a connection and a
   * model — set for its next turn, and made the default for new chats.
   */
  | { readonly kind: "model"; readonly target?: { readonly connectionId: string; readonly model: string } }
  /**
   * The chat shown's working folder:
   * shown, or — with a change — changed from its next message.
   */
  | { readonly kind: "folder"; readonly change?: FolderChange }
  | { readonly kind: "unknown"; readonly typed: string };

/**
 * A `/folder` change: a host folder as the chat's primary (`set`), one
 * attached (`add`, read-only unless `--rw`), one detached by its label
 * (`drop`), or back to the chat's defaults (`reset`). A path is as typed.
 */
export type FolderChange =
  | { readonly kind: "set"; readonly path: string }
  | { readonly kind: "add"; readonly path: string; readonly rw: boolean }
  | { readonly kind: "drop"; readonly label: string }
  | { readonly kind: "reset" };

const HELP = ["/help", "/?"];
const NEW = "/new";
/** The commands that take no words. */
const BARE = { "/home": "home", "/chats": "chats", "/compact": "compact", "/taint": "taint" } as const;
/** The commands whose words follow them: `/side <topic>`, `/open <task-id>`, `/answer <n> <text>`, `/steer <text>`, `/model <connection> <model>`, `/folder <change>`. */
const WITH_WORDS = ["/side", "/open", "/answer", "/steer", "/model", "/folder"];
const PANE_WORDS = PANES.map((pane) => `/${pane}`);
const FORM_WORDS = Object.values(FORM_COMMANDS);
/** Every command as typed, forms' two words included. */
const COMMANDS = [...HELP, NEW, ...Object.keys(BARE), ...WITH_WORDS, ...PANE_WORDS, ...FORM_WORDS];

/** The names `tavi chat` keeps for itself: a plugin's command of the same name is listed as `<plugin>:<name>`. */
export const CHAT_COMMAND_NAMES: readonly string[] = [...new Set(COMMANDS.map((command) => command.split(" ")[0]!.slice(1)))];

/**
 * The line as a command. A line is one when its first word is a command's —
 * `/models foo` is an unknown command, not a prompt a typo would send to the
 * model — or when it is a lone slash-word. Anything else (`/etc/hosts?`) is a
 * prompt. A form's command may be followed by the words that fill its fields.
 */
export function chatCommand(line: string): ChatCommand | undefined {
  const typed = line.trim();
  const lower = typed.toLowerCase();
  if (HELP.includes(lower)) return { kind: "help" };
  if (lower === NEW) return { kind: "new" };
  const bare = (BARE as Record<string, "home" | "chats" | "compact" | "taint">)[lower];
  if (bare !== undefined) return { kind: bare };
  const [word = "", ...rest] = typed.split(/\s+/);
  if (word.toLowerCase() === "/side") {
    const topic = typed.slice(word.length).trim();
    return topic === "" ? { kind: "side" } : { kind: "side", topic };
  }
  if (word.toLowerCase() === "/steer") {
    const text = typed.slice(word.length).trim();
    return text === "" ? { kind: "steer" } : { kind: "steer", text };
  }
  if (word.toLowerCase() === "/model") {
    if (rest.length === 0) return { kind: "model" };
    const [connectionId, model] = rest;
    return rest.length === 2 && connectionId !== undefined && model !== undefined
      ? { kind: "model", target: { connectionId, model } }
      : { kind: "unknown", typed };
  }
  if (word.toLowerCase() === "/folder") return folderCommand(typed, word, rest[0]);
  if (word.toLowerCase() === "/open") {
    if (rest.length > 1) return { kind: "unknown", typed };
    return rest[0] === undefined ? { kind: "open" } : { kind: "open", taskId: rest[0] };
  }
  if (word.toLowerCase() === "/answer") {
    if (rest[0] === undefined) return { kind: "answer" };
    const index = /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined;
    if (index === undefined || index < 1) return { kind: "unknown", typed };
    const text = typed.slice(word.length).trim().slice(rest[0].length).trim();
    return text === "" ? { kind: "answer", index } : { kind: "answer", index, text };
  }
  const pane = PANES.find((name) => lower === `/${name}`);
  if (pane !== undefined) return { kind: "pane", pane };
  for (const [form, words] of Object.entries(FORM_COMMANDS) as [FormId, string][]) {
    if (lower === words || lower.startsWith(`${words} `)) {
      return {
        kind: "form",
        form,
        words: typed
          .slice(words.length)
          .trim()
          .split(/\s+/)
          .filter((word) => word !== ""),
      };
    }
  }
  // An MCP server's prompt (`/mcp-<server>-<prompt>`) is a message: the owner runs it in the turn.
  if (/^\/mcp-[a-z][a-z0-9]*-[a-z0-9]/.test(lower)) return undefined;
  const first = lower.split(/\s+/)[0] ?? "";
  if (COMMANDS.some((command) => command.split(" ")[0] === first) || /^\/[a-z?-]+$/.test(lower)) return { kind: "unknown", typed };
  return undefined;
}

/** `/folder [show|set <path>|add <path> [--rw]|drop <label>|reset]`; anything else is unknown. */
function folderCommand(typed: string, word: string, sub: string | undefined): ChatCommand {
  if (sub === undefined) return { kind: "folder" };
  // The rest of the line after the sub-command: a path may hold spaces.
  const tail = typed.slice(word.length).trim().slice(sub.length).trim();
  switch (sub.toLowerCase()) {
    case "show":
      return tail === "" ? { kind: "folder" } : { kind: "unknown", typed };
    case "reset":
      return tail === "" ? { kind: "folder", change: { kind: "reset" } } : { kind: "unknown", typed };
    case "set":
      return tail === "" ? { kind: "unknown", typed } : { kind: "folder", change: { kind: "set", path: tail } };
    case "add": {
      const rw = tail === "--rw" || tail.endsWith(" --rw");
      const path = (rw ? tail.slice(0, -"--rw".length) : tail).trim();
      return path === "" ? { kind: "unknown", typed } : { kind: "folder", change: { kind: "add", path, rw } };
    }
    case "drop":
      return tail === "" ? { kind: "unknown", typed } : { kind: "folder", change: { kind: "drop", label: tail } };
    default:
      return { kind: "unknown", typed };
  }
}

/**
 * Whether `typed` may still become a command: what the prompt takes while a
 * run is going. A form's command may go on with its words, and so may a
 * plugin's (`plugins`, the names last listed).
 */
export function mayBecomeCommand(typed: string, plugins: readonly string[] = []): boolean {
  const candidate = typed.trimStart().toLowerCase();
  if (!candidate.startsWith("/")) return false;
  const named = plugins.map((name) => `/${name}`);
  return (
    [...COMMANDS, ...named].some((command) => command.startsWith(candidate)) ||
    [...WITH_WORDS, ...FORM_WORDS, ...named].some((command) => candidate.startsWith(`${command} `))
  );
}

/** Whether `line` is a command a chat runs, not one it refuses as unknown: one of its own, or a plugin's of `plugins`. */
export const runnable = (line: string, plugins: readonly string[] = []): boolean => {
  const typed = parsePluginCommandLine(line);
  if (typed !== undefined && plugins.includes(typed.name)) return true;
  const command = chatCommand(line);
  return command !== undefined && command.kind !== "unknown";
};

/** Where a `/help` description starts: a command too long for it gets its description after one space. */
const HELP_COLUMN = 16;

/**
 * One `/help` entry as rows of fewer than `columns` characters: `head` (the
 * command, indented two) and its `text` after it, wrapped at spaces, each next
 * row starting under the description's column; with no head, the text is a
 * note indented two.
 */
export function helpRows(head: string, text: string, columns: number): string[] {
  const lead = head === "" ? "  " : `  ${head}`.length < HELP_COLUMN ? `  ${head}`.padEnd(HELP_COLUMN) : `  ${head} `;
  const indent = " ".repeat(head === "" ? 2 : HELP_COLUMN);
  const rows: string[] = [];
  let row = lead;
  let filled = false;
  for (const word of text.split(" ")) {
    if (filled && row.length + 1 + word.length >= columns) {
      rows.push(row);
      row = indent + word;
    } else if (!filled && head !== "" && row.length + word.length >= columns) {
      // A command too wide to start its description on the same row has the row to itself.
      rows.push(row.trimEnd());
      row = indent + word;
    } else {
      row += filled ? ` ${word}` : word;
    }
    filled = true;
  }
  rows.push(row);
  return rows;
}

/**
 * The `/help` list, worded for whether Home is on: with it off a prompt
 * with no chat shown starts a new chat, `/home` is refused, and `/new` is a
 * command of its own rather than `/side`'s twin. Wrapped to `columns`.
 */
export const commandHelp = (homeOn: boolean, columns = 100): readonly string[] => [
  divider("commands"),
  ...(
    [
      ["/needs", "everything waiting on you: questions with their options, approvals, reviews"],
      ["/agents", "the workspace's agents, and the mailbox of the chat followed here"],
      ["/schedules", "the workspace's schedules: next and last fire"],
      ["/approvals", "the workspace's pending approval rounds, and where to decide each"],
      ["/credentials", "the credential references the owner stores"],
      ["/models", "model connections, the default and role bindings"],
      ["/plugins", "built-in and installed plugins, their state and what awaits review"],
      ["/credentials set [reference]", "store a credential; its value is typed hidden"],
      ["/models add [id] [base-url] [credential] [model]", "add a connection"],
      ["/models set-default [connection] [model]", "the workspace's default model"],
      ["/models set-role [role] [connection] [model]", "bind a role"],
      ["/models test [connection] [model]", "test a connection"],
      ...(homeOn
        ? [
            [
              "/side [topic]",
              "the next prompt (or the topic) starts a side chat of the chat shown, which begins from it and reads its notes; otherwise a prompt continues the chat shown, or goes to Home",
            ],
            ["/home", "back to your Home: its newest turns, then type to continue it"],
            ["/chats", "the workspace's recent chats, your Home first; /open <task-id> continues one"],
          ]
        : [
            [
              "/side [topic]",
              "the next prompt (or the topic) starts a side chat of the chat shown, which begins from it and reads its notes; otherwise a prompt continues the chat shown, or starts one",
            ],
            ["/chats", "the workspace's recent chats; /open <task-id> continues one"],
          ]),
      ["/open <task-id>", "follow a chat from its beginning and continue it"],
      [
        "/compact",
        "fresh context: the chat's next message starts a new epoch, its earlier turns summarized and archived (a long chat also does this by itself); it does not clear taint",
      ],
      [
        "/taint",
        "what the chat shown read that Tavi does not trust (the status line's ⚠ chip), what that changes, and the remedy: start a fresh chat",
      ],
      [
        "/answer [<n> <text>]",
        "the questions open in this chat, its workers' too, numbered; with a number, answers that one (a typed line answers a question only when exactly one is open)",
      ],
      [
        "/model [<connection> <model>]",
        "the chat shown's model; with one named, the chat runs it from its next turn, and it becomes the default for new chats",
      ],
      [
        "/folder",
        "the chat shown's working folder and attached folders; from its next message: /folder set <path> works in a folder under an --fs-root, /folder add <path> [--rw] attaches one (read-only unless --rw), /folder drop <label> detaches one, and /folder reset goes back to the chat's own folder (also when its folder is gone)",
      ],
      [
        "/steer <text>",
        "send this into the turn that runs now: the model reads it before its next step (a line typed while a turn runs is queued for after it; with none running, a message)",
      ],
      homeOn ? ["/new", "the same as /side"] : ["/new", "the next prompt starts a new chat"],
      ["/help, /?", "this list"],
      [
        "",
        "Typed at the prompt, even while a run is going. A pane is a snapshot; a form asks what its words leave out, a field at a time. Esc drops a command half typed, or cancels a form.",
      ],
    ] as const
  ).flatMap(([head, text]) => helpRows(head, text, columns)),
];
