import { emitError, jsonText } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import { terminalText } from "../../shared/terminal-text.js";
import { TaviError, type SearchProviderConfig, type SearchWriteResult, type WebSearchResult, type WebSearchKind } from "@tavi/contracts";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import { createLocalCredentialStore } from "../credentials/store.js";
import { createWebSearchAdapter, searchKeyProblem } from "./web-search.js";
import type { SearchCommandOptions } from "./parse.js";
import { type CliIo, printUnreadableWarning } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";

/**
 * `tavi search`: the web search providers — on a live owner over
 * IPC, otherwise directly — tested through the same adapter `web_search` uses:
 * on an owner with its credential chain, offline with the credentials
 * directory's keys.
 */
export async function searchCommand(options: ResolvedDataDirectory<SearchCommandOptions>, io: CliIo): Promise<number> {
  const print = (value: unknown, text: string): void => io.stdout(options.format === "json" ? jsonText(value) : text);
  const describe = (provider: SearchProviderConfig): string =>
    `${provider.providerId}\t${provider.kind}\t${provider.baseUrl ?? (provider.credentialRef === undefined ? "(keyless)" : `credential ${provider.credentialRef}`)}\t${provider.enabled ? "enabled" : "disabled"}\n`;
  const printAnswer = (answer: WebSearchResult): void =>
    print(
      answer,
      terminalText(
        `${options.providerId} answered ${answer.sources.length} result(s)${answer.content === undefined ? "" : `, and: ${answer.content.slice(0, 200)}`}\n` +
          answer.sources.map((entry) => `  ${entry.title ?? new URL(entry.url).hostname}\n    ${entry.url}\n`).join(""),
      ),
    );
  const printList = (listed: { readonly providers: readonly SearchProviderConfig[]; readonly unreadable?: readonly string[] }): void => {
    const unreadable = listed.unreadable ?? [];
    print(
      listed,
      listed.providers.length === 0
        ? "no search provider is configured; add one with `tavi search add`\n"
        : listed.providers.map(describe).join(""),
    );
    printUnreadableWarning(io, "search provider(s)", unreadable, "Remove them with `tavi search remove <id>`, or restore a backup.");
  };
  const onOwner = await configOnOwner(options.dataDirectory, "search", io, {
    label: `tavi search ${options.action}`,
    mutates: options.action !== "list" && options.action !== "test",
    build: () => ({
      action: options.action,
      ...definedOnly({
        providerId: options.providerId,
        // An unknown kind is the owner's to refuse, as the offline command does.
        kind: options.kind as WebSearchKind | undefined,
        credentialRef: options.credentialRef,
        baseUrl: options.baseUrl,
        query: options.query,
      }),
    }),
    render: (result) => {
      if (options.action === "list") {
        const listed = result as { providers: readonly SearchProviderConfig[]; unreadable?: readonly string[]; truncated?: boolean };
        printList(listed);
        if (listed.truncated === true) io.stderr("note: the owner listed only the first providers\n");
        return EXIT.ok;
      }
      if (options.action === "test") {
        printAnswer(result as WebSearchResult);
        return EXIT.ok;
      }
      // As offline: the provider (or what was removed), not the owner's envelope.
      const { result: written, restartRequired } = result as SearchWriteResult;
      if (options.action === "remove") print(written, `removed ${options.providerId}\n`);
      else print(written, describe(written as SearchProviderConfig));
      if (restartRequired) {
        io.stderr("note: provider instances activate at startup; restart `tavi serve` to use this configuration\n");
      }
      return EXIT.ok;
    },
    // A failed test search is reported as offline — its code, then its words —
    // and is exit 1 whatever the provider did; a provider that does not exist
    // is exit 4, and a malformed request exit 2.
    ...(options.action === "test"
      ? {
          refusal: (code: string | undefined, message: string) =>
            code === "NOT_FOUND"
              ? { line: message, exit: EXIT.unavailable }
              : code === "INVALID_INPUT"
                ? { line: message, exit: EXIT.usage }
                : { line: `${code ?? "UNAVAILABLE"}: ${message}`, exit: EXIT.taskFailed },
        }
      : {}),
  });
  if (onOwner !== undefined) return onOwner;
  const notFound = (providerId: string): number => {
    io.stderr(`no search provider ${JSON.stringify(providerId)} is configured (\`tavi search list\`)\n`);
    return EXIT.unavailable;
  };
  let tested: SearchProviderConfig | undefined;
  try {
    const code = await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const providers = store.asPort().repositories.searchProviders;
      const now = nowTimestamp();
      if (options.action === "list") {
        const { providers: all, unreadable } = await providers.list();
        printList({ providers: all, ...(unreadable.length === 0 ? {} : { unreadable }) });
        return EXIT.ok;
      }
      const providerId = options.providerId;
      // Every action but list names one: the parser asks for it.
      if (providerId === undefined) throw new TaviError("INVALID_INPUT", `tavi search ${options.action} needs a provider id`);
      switch (options.action) {
        case "add": {
          // The owner's rule, offline too: a search key under a search reference that no model connection holds.
          if (options.credentialRef !== undefined) {
            // No launcher runs offline: the stored connections and providers are what can hold a key.
            const problem = searchKeyProblem(
              {
                connections: await store.asPort().repositories.modelConfig.listConnections(),
                launcherBindings: [],
                providers: (await providers.list()).providers,
              },
              options.kind as WebSearchKind,
              options.credentialRef,
            );
            if (problem !== undefined) {
              emitError(io, problem);
              return EXIT.usage;
            }
          }
          const added = await providers.add({
            providerId,
            kind: options.kind as WebSearchKind,
            ...(options.credentialRef === undefined ? {} : { credentialRef: options.credentialRef }),
            ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
            enabled: true,
            now,
          });
          print(added, describe(added));
          return EXIT.ok;
        }
        case "remove":
          if (!(await providers.remove(providerId))) return notFound(providerId);
          print({ removed: providerId }, `removed ${providerId}\n`);
          return EXIT.ok;
        case "enable":
        case "disable": {
          if (!(await providers.setEnabled(providerId, options.action === "enable", now))) return notFound(providerId);
          const updated = await providers.get(providerId);
          if (updated === undefined) return notFound(providerId);
          print(updated, describe(updated));
          return EXIT.ok;
        }
        case "test": {
          // Read here; searched below, once the data directory is let go — a
          // provider can take its whole deadline, and nothing else should wait on it.
          tested = await providers.get(providerId);
          if (tested === undefined) return notFound(providerId);
          // The owner's test-time rule, offline too: a provider stored
          // before it, or whose key a model connection took since, does not send that key.
          if (tested.credentialRef !== undefined) {
            const problem = searchKeyProblem(
              {
                connections: await store.asPort().repositories.modelConfig.listConnections(),
                launcherBindings: [],
                providers: (await providers.list()).providers,
              },
              tested.kind,
              tested.credentialRef,
            );
            if (problem !== undefined) {
              emitError(io, problem);
              return EXIT.usage;
            }
          }
          return undefined;
        }
      }
    });
    if (code !== undefined) return code;
  } catch (error) {
    return reportCommandFailure(error, io, `tavi search ${options.action}`);
  }
  // test: one search, through the adapter web_search uses (bounded by its own deadline), with the credentials directory's keys.
  const credentials = createLocalCredentialStore(options.dataDirectory);
  // Read above for a test, the only action that reaches here.
  if (tested === undefined)
    return reportCommandFailure(new TaviError("INTERNAL", "no search provider was read to test"), io, `tavi search ${options.action}`);
  const adapter = createWebSearchAdapter(tested, { readSecret: (reference) => credentials.getSecret(reference) });
  try {
    printAnswer(await adapter.search({ query: options.query ?? "tavi", maxResults: 5 }, new AbortController().signal));
    return EXIT.ok;
  } catch (error) {
    const failure = TaviError.from(error);
    io.stderr(`${failure.code}: ${terminalText(failure.message)}\n`);
    return EXIT.taskFailed;
  }
}
