import { printable } from "@tavi/contracts";

import { emit } from "../../cli/output.js";
import { EXIT, reportCommandFailure, reportFailure } from "../../cli/exit.js";
import type { TaviRuntime } from "../../runtime/types.js";
import { INBOX_USAGE, type InboxCommandOptions } from "./parse.js";
import { resolveDataDirectory } from "../../shared/data-directory.js";
import type { CliIo } from "../../cli/io.js";
import { resolveModelTargetOrReport } from "../../cli/run-target.js";
import { runtimeOptionsForTarget } from "../../cli/runtime-options.js";
import { withStorePreservingOwnership } from "../../cli/store.js";

/** A text column of a listing: printable, and on its own line. */
const cell = (text: string): string => printable(text).replace(/\n/g, " ");

/**
 * `tavi inbox list`.
 *
 * Reads the rows the runtime recorded but never admitted — the ones an unbound
 * sender's message becomes, and stays. `resolvedPrincipalId` is computed at read
 * time, so the listing answers the operator's real question: which of these can
 * be replayed *now*?
 */
export async function inboxListCommand(options: InboxCommandOptions, io: CliIo): Promise<number> {
  try {
    return await withStorePreservingOwnership(resolveDataDirectory(options.dataDirectory), async (store) => {
      const { held, total } = await store.asPort().repositories.messagingInbox.listHeld({ limit: options.limit });
      emit(io, options.format, { held, total, truncated: total > held.length }, (value) =>
        value.held.length === 0
          ? "no held inbound messages\n"
          : value.held
              .map(
                // The event id and the sender are a channel's and a stranger's words: printed with no escape or control in them.
                (row) =>
                  `${row.receivedAt}\t${row.connectionId}\t${cell(row.providerEventId)}\t${row.resolvedPrincipalId ?? "- (unbound)"}\t${cell(row.externalSenderId)}\n`,
              )
              .join("") +
            // Said out loud, so a truncated listing is not read as the whole
            // queue (the same discipline as every other bounded listing here).
            (value.truncated ? `(${value.total - value.held.length} more held; raise --limit)\n` : ""),
      );
      return EXIT.ok;
    });
  } catch (error) {
    return reportCommandFailure(error, io, "inbox command failed");
  }
}

/**
 * `tavi inbox replay`.
 *
 * Composes a runtime rather than attaching, like `schedules run-now`: admitting a
 * message is a model call, so it needs a model target and the data directory to
 * itself (exit 5 while `serve` owns it). The replay itself is the service's own
 * two steps — resolve the sender against the current bindings, run the same
 * `admit` — so a replayed event behaves exactly as one that arrived after the
 * binding.
 */
export async function inboxReplayCommand(options: InboxCommandOptions, io: CliIo): Promise<number> {
  const providerEventId = options.providerEventId;
  const connectionId = options.connectionId;
  if (providerEventId === undefined || connectionId === undefined) {
    io.stderr("inbox replay needs a provider event id and --connection\n");
    return EXIT.usage;
  }
  // The event is looked up first: a wrong id or one already let in is said in a line, before any owner is composed.
  let found: { readonly state: "received" | "processed" } | undefined;
  try {
    found = await withStorePreservingOwnership(resolveDataDirectory(options.dataDirectory), (store) =>
      store.asPort().repositories.messagingInbox.get(connectionId, providerEventId),
    );
  } catch (error) {
    return reportCommandFailure(error, io, "inbox replay failed");
  }
  if (found === undefined || found.state === "processed") {
    const outcome = found === undefined ? ("not-found" as const) : ("already-processed" as const);
    emit(io, options.format, { outcome }, () => replayText(outcome, providerEventId, connectionId));
    return found === undefined ? EXIT.usage : EXIT.ok;
  }
  const target = await resolveModelTargetOrReport(
    {
      prompt: "",
      format: options.format,
      workspaceId: options.workspaceId ?? "default",
      principalId: options.principalId ?? "operator",
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.apiKeyFile === undefined ? {} : { apiKeyFile: options.apiKeyFile }),
      // `dataDirectory` is resolved by the runtime options; the resolver only
      // needs the raw value, so an absent one is simply absent.
      ...(options.dataDirectory === undefined ? {} : { dataDirectory: options.dataDirectory }),
      approval: "approve",
      quiet: false,
      inMemory: false,
    },
    io,
    { usage: INBOX_USAGE },
  );
  if (typeof target === "number") return target;

  // The owner's logs are kept off the terminal unless the replay fails: its answer is the one line it prints.
  const logs: string[] = [];
  const failed = (error: unknown, what: string): number => {
    for (const line of logs) io.stderr(`${line}\n`);
    return reportFailure(error, io, what);
  };
  let runtime: TaviRuntime;
  try {
    // Loaded here, not at the top: every other command this module serves stays off the owner runtime.
    const { composeTaviRuntime } = await import("../../runtime/composition.js");
    runtime = await composeTaviRuntime(
      // Neither sweep belongs to a one-shot replay: this process is not a daemon.
      {
        ...runtimeOptionsForTarget(target),
        logger: { level: "info", sink: (line) => logs.push(line) },
        scheduleSweepEnabled: false,
        retentionSweepEnabled: false,
      },
      { requireModelTransport: true },
    );
  } catch (error) {
    return failed(error, "runtime composition failed");
  }
  try {
    const result = await runtime.messaging.replay({ connectionId, providerEventId });
    emit(io, options.format, result, (value) => {
      switch (value.outcome) {
        case "admitted":
          return `admitted ${providerEventId} as ${value.principalId}`;
        case "unbound":
          return `${providerEventId} is still unbound (sender ${value.externalSenderId}); bind it with \`tavi bindings bind\` first`;
        case "unverified":
          return `${providerEventId} could not be verified as coming from ${value.externalSenderId}; to admit their unverified mail, \`tavi bindings bind ... --trust-unverified yes\``;
        case "admission-closed":
          return "runtime admission is closed: the workflow service is unavailable";
        case "in-flight":
          return `${providerEventId} is already being replayed (or a replay crashed within the last ten minutes); try again shortly`;
        default:
          return replayText(value.outcome, providerEventId, connectionId);
      }
    });
    switch (result.outcome) {
      case "admitted":
      case "already-processed":
        return EXIT.ok;
      case "not-found":
        return EXIT.usage;
      default:
        return EXIT.unavailable;
    }
  } catch (error) {
    return failed(error, "inbox replay failed");
  } finally {
    await runtime.close();
  }
}

/** The replay outcomes said before any owner is composed. */
function replayText(outcome: "not-found" | "already-processed", providerEventId: string, connectionId: string): string {
  return outcome === "already-processed"
    ? `${providerEventId} was already processed; nothing to do`
    : `no held message ${providerEventId} on connection ${connectionId}`;
}
