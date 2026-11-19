import { useState } from "react";

import type { SearchProviderConfig } from "@tavi/contracts";

import { SEARCH_KIND_LABELS, saveWebSearchProvider, searchActions } from "./search-api.js";
import { Confirm } from "../../ui/Confirm.js";
import { Command } from "../../ui/Command.js";
import { Failure, LoadState, Notice, PageHead, PageNote, StatusBadge } from "../../ui/Parts.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { WebSearchFormModal } from "./WebSearchFormModal.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/** The owner's web search providers. One is used automatically; several need a selection or fallback chain in web-providers.json. */
export function WebSearchSettings() {
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => searchActions.list(client));
  const { busy, note, tone, run, say } = useAction(reload);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SearchProviderConfig | undefined>();
  const providers = data?.providers ?? [];
  const unreadable = data?.unreadable ?? [];
  return (
    <section className="settings">
      <PageHead className="settings-head" title="Web search">
        <Button variant="primary" disabled={busy !== undefined} onClick={() => setAdding(true)}>
          Add provider
        </Button>
      </PageHead>
      <Notice>
        An enabled provider answers the agent&rsquo;s web searches. Adding or enabling one applies from the next message, with no restart;
        disabling one stops new searches at once. With several, their order is set in <code className="file-name">web-providers.json</code> in the data directory,
        read when <Command>tavi serve</Command> starts.
      </Notice>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <PageNote tone={tone} note={note} />
      </LoadState>
      {data !== undefined && providers.length === 0 ? <Empty>No provider is configured.</Empty> : null}
      <ul className="rows">
        {providers.map((provider) => (
          <li key={provider.providerId} className="row">
            <span>
              {/* Named once: its kind's name, and its own id only when that says something more ("tavily" under Tavily does not). */}
              <strong>{SEARCH_KIND_LABELS[provider.kind]}</strong>{" "}
              {provider.providerId.toLowerCase() === SEARCH_KIND_LABELS[provider.kind].toLowerCase() ? null : (
                <span className="muted">{provider.providerId} </span>
              )}
              <span className="muted">
                {provider.baseUrl === undefined
                  ? provider.credentialRef === undefined
                    ? "· no key needed"
                    : `· key ${provider.credentialRef}`
                  : `· ${provider.baseUrl}`}
              </span>
              {provider.enabled ? null : (
                <>
                  {" "}
                  <StatusBadge status="disabled" />
                </>
              )}
            </span>
            {/* Text buttons, as a channel's row has them: Remove alone keeps its danger outline. */}
            <span className="actions row-text-actions">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Test ${provider.providerId}`}
                disabled={busy !== undefined}
                onClick={() => void run(`test:${provider.providerId}`, () => searchActions.test(client, provider.providerId))}
              >
                {busy === `test:${provider.providerId}` ? "Testing…" : "Test"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.providerId}`}
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`enable:${provider.providerId}`, () => searchActions.setEnabled(client, provider.providerId, !provider.enabled))
                }
              >
                {provider.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                aria-label={`Remove ${provider.providerId}`}
                disabled={busy !== undefined}
                onClick={() => setRemoving(provider)}
              >
                Remove
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {data?.truncated === true ? (
        <Notice>
          More providers exist than are listed here: <Command>tavi search list</Command> shows them all.
        </Notice>
      ) : null}
      {unreadable.length > 0 ? (
        <Failure alert={false}>
          Unreadable providers, left out: {unreadable.join(", ")}. Remove them with <Command>tavi search remove</Command>.
        </Failure>
      ) : null}
      {removing !== undefined ? (
        <Confirm
          title={`Remove ${removing.providerId}?`}
          message={`The agent's web searches stop going to ${removing.providerId}.${removing.credentialRef === undefined ? "" : ` Its key ${removing.credentialRef} stays stored.`}`}
          action="Remove"
          onClose={() => setRemoving(undefined)}
          onConfirm={() => run(`remove:${removing.providerId}`, () => searchActions.remove(client, removing))}
        />
      ) : null}
      {adding ? (
        <WebSearchFormModal
          taken={[...providers.map((provider) => provider.providerId), ...unreadable]}
          onClose={() => setAdding(false)}
          onSave={async (values) => {
            const outcome = await saveWebSearchProvider(client, values);
            if (!outcome.ok) return outcome.message;
            say(outcome.value);
            reload();
            return undefined;
          }}
        />
      ) : null}
    </section>
  );
}
