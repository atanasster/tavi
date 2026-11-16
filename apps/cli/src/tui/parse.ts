import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../cli/argv.js";
import type { ParsedCommand } from "../cli/parse.js";

export interface ChatCommandOptions {
  /** Follow this chat from its beginning, and continue it, instead of opening on Home or starting one. */
  readonly attach?: string;
  /** Render a recorded `tavi run --format json` stream instead of connecting. */
  readonly replay?: string;
  /** Where to write render statistics when the TUI exits (a diagnostic). */
  readonly stats?: string;
  /** `--no-memory` / `--private`: the first chat started is made with memory off, or private. */
  readonly memory?: "off" | "private";
  /** `--draft <text>`: a new chat with this in the composer, unsent. */
  readonly draft?: string;
  readonly workspaceId: string;
  readonly principalId: string;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const CHAT_USAGE = `tavi chat [options]
       tavi chat --attach <task-id> [options]
       tavi chat --replay <ndjson-file> [options]

Converse with a live \`tavi serve\` in the terminal: your first prompt is
dispatched to the owner as a run, and its stream is rendered as it arrives.
Once that chat's turn has ended, the next prompt continues it — a new turn of
the same chat, whose model sees the earlier turns; a failed turn is continued
the same way. A prompt typed while a turn runs is queued and sent when it
ends; /steer <text> instead sends it into the running turn, which the model
reads before its next step (with no turn running, an ordinary message). With
Home off, /new makes the next prompt start a chat of its own.

With Home on (\`tavi config set chat.home on\`), \`tavi chat\` opens on your
Home: its newest saved turns are printed and the next prompt continues it; with
no Home yet, your first message begins it. A prompt with nothing else to
continue goes to Home. /side [topic] starts a side chat of the chat shown
(the topic, when given, is its first prompt): it begins with background from
that chat and reads its chat notes. /home goes back to Home, /chats lists the
workspace's recent chats (your Home first) and /open <task-id> continues one;
With Home on, /new does what /side does. A long chat compacts by itself; /compact asks for fresh context
now: the chat's next message starts a new epoch, its earlier turns summarized
and archived.
Finished text and tool results scroll into the terminal's history; only the
line being written, the status and the prompt stay live. Needs a terminal (use
\`tavi run\` in scripts) and a running owner (exit 4 otherwise). Ctrl-C quits:
exit 0, or 130 when a run is still going, which the owner continues —
\`tavi chat --attach <task-id>\` follows it again.

Tool calls are drawn as cards. An approval round is one card, listing every
gated call: y approves the whole round once, s for the rest of the chat (in
Home: until tomorrow), a always (a workspace rule), n rejects it and N rejects
it with a reason the model reads; s and a only where every call offers them
(or decide it in another terminal with \`tavi approvals\`); a review of archived output is one card
too, y releasing all of it and n rejecting it. A round a schedule's fire
answers is shown read-only until the fire ends. A question a run started
here (or over IPC) asks is answered by typing: what you type next is the
reply. A question a worker of the chat shown asks is printed there with the
worker's name: a typed line answers it only when exactly one question is
open in the chat; with more, /answer lists them and /answer <n> <text>
answers one. Esc aborts the running turn.

Background work posts a notice, one line each (◆ title — status — summary
(task id)), into Home or a side chat's parent: a schedule or reminder
delivered to Home, a standalone \`tavi run\` that settled (Home on), a side
chat that finished (into its parent). \`tavi chat\` prints those of the chat
shown. A notice is never a message to answer and never starts a turn; the
model reads those posted since your last message, as untrusted data, when you
next write.

Status panes, typed at the prompt at any time: /agents (the workspace's agents
and the followed task's mailbox), /schedules (next and last fires) and
/approvals (the workspace's pending rounds, and where to decide each),
/credentials and /models. Each prints a snapshot into the transcript. Forms
write configuration a field at a time: /credentials set (the value typed
hidden), /models add, /models set-default, /models set-role and /models test.
/folder shows the chat shown's working folder; /folder set <path>, /folder add
<path> [--rw], /folder drop <label> and /folder reset change it from its next
message. A chat a prompt starts here (a side chat, or a new chat with Home
off) works in this directory when it lies under one of the owner's --fs-root
folders; Home never moves to it.
/help (or /?) lists them all. Esc
drops a command half typed, or cancels a form. A credential typed as a prompt
is masked and refused on Enter: never sent, and never in the transcript.

Options:
  --draft <text>         Open a new chat with <text> in the prompt, unsent:
                         edit it, then Enter sends it (a first idea from tavi
                         onboard)
  --attach <task-id>     Follow a chat the owner is running (or has run), from
                         its beginning, in place of Home; a start the owner no
                         longer holds is announced, and a chat whose stream it
                         no longer holds is printed from its saved turns and
                         record. Its rounds are decided here and its question
                         answered by typing (when an IPC run started it); once
                         it ends, the next prompt continues it
  --replay <file>        Render a recorded stream (\`tavi run --format json\`,
                         one task's) at 250 events a frame instead of
                         connecting, then exit
  --stats <file>         On exit, write render statistics as JSON (events,
                         tree updates, frames drawn, peak memory) — a diagnostic
  --no-memory            The first prompt starts a new chat (never Home) with
                         memory off: nothing recalled, nothing remembered from
                         it; /memory on turns it back on
  --private              The first prompt starts a private chat: memory off for
                         good, left out of past-chat search and Earlier chats,
                         and its saved turns forgotten 24 h after its last
  --workspace <id>       Workspace to act in (default: default)
  --principal <id>       Personal principal (default: operator)
  --data-dir <path>      Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help             Show this help
`;

/** Parse `tavi chat`, the terminal UI over a live owner. */
export function parseChat(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: CHAT_USAGE,
    valued: ["--attach", "--replay", "--stats", "--workspace", "--principal", "--data-dir", "--draft"],
    switches: ["--no-memory", "--private"],
    unknown: (name) => `chat does not accept ${name}`,
    positional: (token) => `chat takes no arguments; got ${token}`,
  });
  if (args === "help") return { command: "help", usage: CHAT_USAGE };
  const { flags } = args;
  // A new chat's memory: off, or private, which is set when the chat is created or never.
  if (args.switches.has("--no-memory") && args.switches.has("--private"))
    throw new UsageError("--no-memory and --private cannot be combined: a private chat's memory is off already", CHAT_USAGE);
  const memory: "off" | "private" | undefined = args.switches.has("--private")
    ? "private"
    : args.switches.has("--no-memory")
      ? "off"
      : undefined;
  const attach = flags.get("--attach");
  const replay = flags.get("--replay");
  if (attach !== undefined && replay !== undefined) throw new UsageError("--attach and --replay cannot be combined", CHAT_USAGE);
  if (memory !== undefined && (attach !== undefined || replay !== undefined))
    throw new UsageError(
      `${memory === "private" ? "--private" : "--no-memory"} starts a new chat; --attach and --replay start none (use /memory off in a chat)`,
      CHAT_USAGE,
    );
  const stats = flags.get("--stats");
  const draft = flags.get("--draft");
  if (draft !== undefined && (attach !== undefined || replay !== undefined))
    throw new UsageError("--draft starts a new chat; --attach and --replay start none", CHAT_USAGE);
  if (draft !== undefined && draft.length > 4000) throw new UsageError("--draft is at most 4000 characters", CHAT_USAGE);
  return {
    command: "chat",
    chat: {
      ...definedOnly({
        attach,
        draft,
        replay,
        stats,
        memory,
      }),
      workspaceId: flags.get("--workspace") ?? "default",
      principalId: flags.get("--principal") ?? "operator",
      ...dataDirectoryFlag(flags),
    },
  };
}
