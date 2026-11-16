import { emit, emitJson } from "../../cli/output.js";
import { EXIT, configRefusalExit, refusalExit, reportCommandFailure } from "../../cli/exit.js";
import {
  BROWSER_IPC_LIST_MAX,
  BrowserClearProfileAnswerSchema,
  BrowserCloseAnswerSchema,
  BrowserRecipesAnswerSchema,
  BrowserListAnswerSchema,
  formatBrowserDuration,
  type BrowserListAnswer,
  type BrowserPayload,
  type BrowserSessionView,
  TaviError,
} from "@tavi/contracts";
import type {
  BrowserSiteNotesOptions,
  BrowserClearProfileOptions,
  BrowserCloseOptions,
  BrowserRecipesOptions,
  BrowserHistoryOptions,
  BrowserLiveOptions,
} from "./parse.js";
import { browserCommand as runBrowserAction } from "./owner.js";
import { browserProfileDirectory } from "./profile.js";
import { browserLiveCli } from "./live-client.js";
import { terminalText } from "../../shared/terminal-text.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { nowTimestamp } from "@tavi/contracts/util";
import { APPS_SITES_SETTING, parseSites } from "../apps/sharing.js";
import { OPERATOR_SITE_NOTES, SITE_NOTES_DIRECTORY, operatorNoteKey, proposeRecipeNote, readOperatorSiteNotes } from "./site-notes.js";
import { withStorePreservingOwnership } from "../../cli/store.js";
import { plural } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import type { CliIo } from "../../cli/io.js";
import { configOnOwner, refuseOfflineOnly, runFamily } from "../../cli/owner.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";

/**
 * `tavi browser history`: the `browser list`
 * command on a live owner, page after page up to `--limit`; with none, the
 * same read on the data directory.
 */
export async function browserCliCommand(options: ResolvedDataDirectory<BrowserHistoryOptions>, io: CliIo): Promise<number> {
  const print = (items: readonly BrowserSessionView[]): number => {
    emit(io, options.format, { sessions: items }, () => browserHistoryText(items, options.live));
    return EXIT.ok;
  };
  const pageSize = (held: number): number => Math.min(BROWSER_IPC_LIST_MAX, options.limit - held);
  const payload = (cursor: string | undefined, held: number): BrowserPayload => ({
    action: "list",
    workspaceId: options.workspaceId,
    ...(options.live ? { open: true } : {}),
    limit: pageSize(held),
    ...(cursor === undefined ? {} : { cursor }),
  });
  return runFamily(options.dataDirectory, "browser", io, {
    label: "tavi browser history",
    mutates: false,
    codes: { NOT_FOUND: EXIT.usage },
    build: () => payload(undefined, 0),
    render: async (result, client) => {
      let page = BrowserListAnswerSchema.parse(result);
      const items = [...page.items];
      while (page.nextCursor !== undefined && items.length < options.limit) {
        const next = await client.request("browser", payload(page.nextCursor, items.length), prefixedId("browser"));
        if (!next.ok) throw new TaviError("UNAVAILABLE", terminalText(next.error?.message ?? "The owner refused the next page"));
        page = BrowserListAnswerSchema.parse(next.result);
        items.push(...page.items);
      }
      return print(items);
    },
    offline: async (store) => {
      const deps = { repositories: store.asPort().repositories, principalOf: () => "operator", now: () => new Date() };
      const items: BrowserSessionView[] = [];
      let cursor: string | undefined;
      do {
        const answer = await runBrowserAction(deps, payload(cursor, items.length));
        if (!answer.ok) {
          io.stderr(`${terminalText(answer.error.message)}\n`);
          return answer.error.code === "NOT_FOUND" ? EXIT.usage : configRefusalExit(answer.error.code);
        }
        const page = answer.result as BrowserListAnswer;
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined && items.length < options.limit);
      return print(items);
    },
    failed: (error) => reportCommandFailure(error, io, "browser history failed"),
  });
}

/**
 * `tavi browser live`: only on a live
 * owner — the live view exists only there — until its frames are written,
 * its sessions end, or Ctrl-C.
 */
export async function browserLiveCommand(options: ResolvedDataDirectory<BrowserLiveOptions>, io: CliIo): Promise<number> {
  const client = await connectOwnerOrReport(options.dataDirectory, ["browser-live"], io, EXIT);
  if (typeof client === "number") return client;
  if (client === undefined) {
    io.stderr("tavi browser live needs a live `tavi serve`: the live view exists only there\n");
    return EXIT.unavailable;
  }
  let stopOnSignal: () => void = () => undefined;
  const stop = new Promise<void>((resolve) => (stopOnSignal = resolve));
  process.once("SIGINT", stopOnSignal);
  try {
    const { frames } = await browserLiveCli(options, { client, stdout: io.stdout, stop });
    io.stderr(`${plural(frames, "frame")} written to ${options.out}\n`);
    return EXIT.ok;
  } catch (error) {
    const failure = TaviError.from(error);
    if (failure.code === "NOT_FOUND" || failure.code === "INVALID_INPUT" || failure.code === "UNAVAILABLE") {
      io.stderr(`${terminalText(failure.message)}\n`);
      return failure.code === "UNAVAILABLE" ? EXIT.unavailable : EXIT.usage;
    }
    return reportCommandFailure(error, io, "browser live failed");
  } finally {
    process.off("SIGINT", stopOnSignal);
    client.close();
  }
}

/**
 * `tavi browser close <session-id> | --inactive`: on a live owner,
 * which closes the browser context it holds and records it; with none, only
 * the record (no session outlives its owner, so there is nothing else to free).
 */
export async function browserCloseCommand(options: ResolvedDataDirectory<BrowserCloseOptions>, io: CliIo): Promise<number> {
  const payload: BrowserPayload = {
    action: "close",
    workspaceId: options.workspaceId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.inactive ? { inactive: true } : {}),
  };
  const print = (result: unknown): number => {
    const closed = BrowserCloseAnswerSchema.parse(result).closed;
    io.stdout(
      closed.length === 0 ? "No browser session to close.\n" : `Closed ${plural(closed.length, "browser session")}: ${closed.join(", ")}\n`,
    );
    return EXIT.ok;
  };
  return runFamily(options.dataDirectory, "browser", io, {
    label: "tavi browser close",
    mutates: true,
    codes: { NOT_FOUND: EXIT.usage },
    build: () => payload,
    render: (result) => print(result),
    offline: async (store) => {
      const deps = { repositories: store.asPort().repositories, principalOf: () => "operator", now: () => new Date() };
      const answer = await runBrowserAction(deps, payload);
      if (!answer.ok) {
        io.stderr(`${terminalText(answer.error.message)}\n`);
        return answer.error.code === "NOT_FOUND" || answer.error.code === "INVALID_INPUT"
          ? EXIT.usage
          : configRefusalExit(answer.error.code);
      }
      return print(answer.result);
    },
    failed: (error) => reportCommandFailure(error, io, "browser close failed"),
  });
}

/**
 * `tavi browser clear-profile`: on a live
 * owner, which closes the workspace's open sessions and the profile it holds
 * before removing it; with none, nothing holds the profile, so its directory is
 * removed here.
 */
export async function browserClearProfileCommand(options: ResolvedDataDirectory<BrowserClearProfileOptions>, io: CliIo): Promise<number> {
  const payload: BrowserPayload = { action: "clear-profile", workspaceId: options.workspaceId };
  const print = (result: unknown): number => {
    const { closed } = BrowserClearProfileAnswerSchema.parse(result);
    io.stdout(
      `Cleared the browser profile of workspace ${options.workspaceId}${closed === 0 ? "" : `, closing ${plural(closed, "browser session")}`}.\n`,
    );
    return EXIT.ok;
  };
  const onOwner = await configOnOwner(options.dataDirectory, "browser", io, {
    label: "tavi browser clear-profile",
    mutates: true,
    build: () => payload,
    render: (result) => print(result),
  });
  if (onOwner !== undefined) return onOwner;
  try {
    await rm(browserProfileDirectory(options.dataDirectory, options.workspaceId), { recursive: true, force: true });
    return print({ closed: 0 });
  } catch (error) {
    return reportCommandFailure(error, io, "browser clear-profile failed");
  }
}

/**
 * `tavi browser recipes`: the steps that last
 * led to results on each site, read (and forgotten) on a live owner or from the
 * data directory.
 */
export async function browserRecipesCommand(options: ResolvedDataDirectory<BrowserRecipesOptions>, io: CliIo): Promise<number> {
  const payload: BrowserPayload = {
    action: "recipes",
    workspaceId: options.workspaceId,
    ...(options.forget === undefined ? {} : { forget: options.forget }),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
  };
  const print = (result: unknown): number => {
    const answer = BrowserRecipesAnswerSchema.parse(result);
    if (options.format === "json") {
      emitJson(io, answer);
      return EXIT.ok;
    }
    const lines = [
      ...(answer.forgotten === undefined ? [] : [`Forgot ${plural(answer.forgotten, "recipe")}.`]),
      ...(answer.replayChanged === undefined || options.replay === undefined
        ? []
        : [
            answer.replayChanged === 0
              ? `No recipe for ${options.replay.host}: nothing to ${options.replay.on ? "replay" : "stop"}.`
              : options.replay.on
                ? `${options.replay.host}'s recipe replays when a session next reaches it.`
                : `${options.replay.host}'s recipe no longer replays.`,
          ]),
      ...(answer.recipes.length === 0
        ? ["No site recipes."]
        : answer.recipes.flatMap((recipe) => [
            `${recipe.host} — ${plural(recipe.uses, "time")}, last ${recipe.updatedAt.slice(0, 10)}, ${recipe.results} results${recipe.replay === true ? ", replays" : ""}`,
            ...recipe.steps.map(
              (step) =>
                `  ${step.kind}${step.role === undefined && step.label === undefined ? " the page" : ` ${step.role ?? "element"} ${JSON.stringify(step.label ?? "")}`}${step.value === undefined ? "" : ` (${step.value})`}`,
            ),
          ])),
    ];
    io.stdout(`${terminalText(lines.join("\n"))}\n`);
    return EXIT.ok;
  };
  return runFamily(options.dataDirectory, "browser", io, {
    label: "tavi browser recipes",
    mutates: options.forget !== undefined || options.replay !== undefined,
    build: () => payload,
    render: (result) => print(result),
    offline: async (store) => {
      const answer = await runBrowserAction(
        { repositories: store.asPort().repositories, principalOf: () => "operator", now: () => new Date() },
        payload,
      );
      if (!answer.ok) {
        return refusalExit(io, answer.error);
      }
      return print(answer.result);
    },
    failed: (error) => reportCommandFailure(error, io, "browser recipes failed"),
  });
}

/**
 * `tavi browser site-notes`: the operator's
 * site notes and whether each is on. `--propose <host>` writes a site's recipe
 * (read on a live owner or from the data directory) as a new note, off, for the
 * operator to review; `--on` and `--off` change the site switch, on the data
 * directory only.
 */
export async function browserSiteNotesCommand(options: ResolvedDataDirectory<BrowserSiteNotesOptions>, io: CliIo): Promise<number> {
  const directory = join(options.dataDirectory, SITE_NOTES_DIRECTORY);
  const say = (text: string, json: unknown): number => {
    if (options.format === "json") emitJson(io, json);
    else io.stdout(`${terminalText(text)}\n`);
    return EXIT.ok;
  };
  // A refusal says why, with its exit code; anything else is a failure.
  const failed = (error: unknown): number => {
    if (!(error instanceof TaviError)) return reportCommandFailure(error, io, "browser site-notes failed");
    io.stderr(`browser site-notes: ${terminalText(error.message)}\n`);
    return configRefusalExit(error.code);
  };
  const proposeHost = options.propose;
  if (proposeHost !== undefined) {
    const propose = async (result: unknown): Promise<number> => {
      const { note, path } = await proposeRecipeNote(directory, BrowserRecipesAnswerSchema.parse(result).recipes, proposeHost);
      return say(
        `Proposed ${note.id} in ${path}, off. Review and edit it, then turn it on with \`tavi browser site-notes --on ${note.id}\`.`,
        { proposed: { id: note.id, file: path } },
      );
    };
    return runFamily(options.dataDirectory, "browser", io, {
      label: "tavi browser site-notes --propose",
      mutates: false,
      build: () => ({ action: "recipes", workspaceId: options.workspaceId }),
      render: async (result) => {
        try {
          return await propose(result);
        } catch (error) {
          return failed(error);
        }
      },
      offline: async (store) => {
        const answer = await runBrowserAction(
          { repositories: store.asPort().repositories, principalOf: () => "operator", now: () => new Date() },
          { action: "recipes", workspaceId: options.workspaceId },
        );
        if (!answer.ok) {
          return refusalExit(io, answer.error);
        }
        return propose(answer.result);
      },
      failed,
    });
  }
  const refused = await refuseOfflineOnly(
    options.dataDirectory,
    "tavi browser site-notes",
    "the site switch is read and changed on the data directory",
    io,
  );
  if (refused !== undefined) return refused;
  try {
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const notes = readOperatorSiteNotes(directory);
      const sites = { ...parseSites(await store.getMeta(APPS_SITES_SETTING)) };
      const operatorOn = sites[OPERATOR_SITE_NOTES] ?? [];
      const turn = options.turn;
      if (turn !== undefined) {
        const found = notes.find((entry) => entry.note?.id === turn.id);
        if (turn.on && found?.note === undefined)
          throw new TaviError("NOT_FOUND", `no site note ${turn.id} in ${directory} that reads as one`);
        const kept = operatorOn.filter((key) => !key.startsWith(`${turn.id}@`));
        const next = turn.on && found?.note !== undefined ? [...kept, operatorNoteKey(found.note, found.digest)].sort() : kept;
        if (next.length === 0) delete sites[OPERATOR_SITE_NOTES];
        else sites[OPERATOR_SITE_NOTES] = next;
        await store.setMeta(APPS_SITES_SETTING, JSON.stringify(sites), nowTimestamp());
        return say(turn.on ? `${turn.id} is on, as its file reads now.` : `${turn.id} is off.`, { id: turn.id, on: turn.on });
      }
      const listed = notes.map(({ file, digest, note, problem }) => {
        const state =
          note === undefined
            ? "unreadable"
            : operatorOn.includes(operatorNoteKey(note, digest))
              ? "on"
              : operatorOn.some((key) => key.startsWith(`${note.id}@`))
                ? "changed since turned on"
                : "off";
        return {
          file,
          ...(note === undefined ? {} : { id: note.id, name: note.name, hosts: note.hosts }),
          state,
          ...(problem === undefined ? {} : { problem }),
        };
      });
      return say(
        listed.length === 0
          ? `No site notes in ${directory}.`
          : listed
              .map((entry) =>
                entry.id === undefined
                  ? `${entry.file} — unreadable: ${entry.problem ?? ""}`
                  : `${entry.id} — ${entry.name} (${entry.hosts?.join(", ") ?? ""}), ${entry.state}`,
              )
              .join("\n"),
        { notes: listed },
      );
    });
  } catch (error) {
    return failed(error);
  }
}

/** `tavi browser history`'s text: one block per session, live ones marked; `open` when `--live` asked for open ones only. */
function browserHistoryText(items: readonly BrowserSessionView[], open: boolean): string {
  if (items.length === 0) return open ? "No browser session is open now." : "Nothing browsed in the last 30 days.";
  return items
    .map((item) => {
      // An inactive session is still open (closable with `tavi browser close`), its task over.
      const state = item.live ? "LIVE  " : item.inactive === true ? "ENDED " : "closed";
      const page = [item.host ?? item.lastUrl ?? "(no page yet)", item.lastTitle]
        .filter((part) => part !== null && part !== undefined)
        .join(" · ");
      const head = `${state} ${item.openedAt}  ${plural(item.pages, "page")} · ${formatBrowserDuration(item.durationMs)}  ${terminalText(page)}`;
      return `${head}${item.inactive === true ? `\n       session ${item.sessionId}: kept open for the chat's next turn` : ""}\n       task ${item.taskId}${item.taskTitle === undefined ? "" : ` — ${terminalText(item.taskTitle)}`}${item.lastUrl === null ? "" : `\n       ${terminalText(item.lastUrl)}`}`;
    })
    .join("\n");
}
