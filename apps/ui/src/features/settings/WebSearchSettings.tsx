import { useState } from "react";

import type { SearchProviderConfig } from "@tavi/contracts";

import { SEARCH_KIND_LABELS, saveWebSearchProvider, searchActions } from "./search-api.js";
import { Confirm } from "../../ui/Confirm.js";
import { Failure, LoadState, Notice, PageHead, StatusNote } from "../../ui/Parts.js";
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
  const { busy, note, run, say } = useAction(reload);
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
        One enabled provider is used automatically; with several, choose one or a fallback order in the data directory&rsquo;s
        web-providers.json, which is read when tavi serve starts. Adding or enabling a provider applies from the next turn, with no restart;
        disabling one stops new calls at once.
      </Notice>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <StatusNote note={note} />
      </LoadState>
      {data !== undefined && providers.length === 0 ? <Empty>No provider is configured.</Empty> : null}
      <ul className="rows">
        {providers.map((provider) => (
          <li key={provider.providerId} className="row">
            <span>
              <strong>{provider.providerId}</strong> {SEARCH_KIND_LABELS[provider.kind]}{" "}
              <span className="muted">
                {provider.baseUrl ?? (provider.credentialRef === undefined ? "keyless" : `key ${provider.credentialRef}`)}
              </span>
              {provider.enabled ? null : (
                <>
                  {" "}
                  <span className="badge">disabled</span>
                </>
              )}
            </span>
            <span className="actions">
              <Button
                aria-label={`Test ${provider.providerId}`}
                disabled={busy !== undefined}
                onClick={() => void run(`test:${provider.providerId}`, () => searchActions.test(client, provider.providerId))}
              >
                {busy === `test:${provider.providerId}` ? "Testing…" : "Test"}
              </Button>
              <Button
                aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.providerId}`}
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`enable:${provider.providerId}`, () => searchActions.setEnabled(client, provider.providerId, !provider.enabled))
                }
              >
                {provider.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
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
      {data?.truncated === true ? <Notice>More providers exist than are listed here: `tavi search list` shows them all.</Notice> : null}
      {unreadable.length > 0 ? (
        <Failure alert={false}>Unreadable providers, left out: {unreadable.join(", ")}. Remove them with `tavi search remove`.</Failure>
      ) : null}
      {removing !== undefined ? (
        <Confirm
          title={`Remove ${removing.providerId}?`}
          message={`web_search stops asking ${removing.providerId}.${removing.credentialRef === undefined ? "" : ` Its key ${removing.credentialRef} stays stored.`}`}
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
