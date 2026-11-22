import { useState } from "react";

import type { SearchProviderConfig } from "@tavi/contracts";

import { SEARCH_KIND_LABELS, saveWebSearchProvider, searchActions } from "./search-api.js";
import { useT } from "../../lib/i18n.js";
import { Confirm } from "../../ui/Confirm.js";
import { Command } from "../../ui/Command.js";
import { Failure, LoadState, Notice, PageHead, PageNote, StatusBadge } from "../../ui/Parts.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { WebSearchFormModal } from "./WebSearchFormModal.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { useWorkspace } from "../shell/Workspace.js";
import { withParts } from "../../ui/with-parts.js";

/** The owner's web search providers. One is used automatically; several need a selection or fallback chain in web-providers.json. */
export function WebSearchSettings() {
  const t = useT();
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => searchActions.list(client));
  const { busy, note, tone, run, say } = useAction(reload);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SearchProviderConfig | undefined>();
  const providers = data?.providers ?? [];
  const unreadable = data?.unreadable ?? [];
  return (
    <section className="settings">
      <PageHead className="settings-head" title={t("settings.search.title")}>
        <Button variant="primary" disabled={busy !== undefined} onClick={() => setAdding(true)}>
          {t("settings.search.add")}
        </Button>
      </PageHead>
      <Notice>
        {withParts(t("settings.search.intro"), {
          file: <code className="file-name">web-providers.json</code>,
          command: <Command>tavi serve</Command>,
        })}
      </Notice>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <PageNote tone={tone} note={note} />
      </LoadState>
      {data !== undefined && providers.length === 0 ? <Empty>{t("settings.search.empty")}</Empty> : null}
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
                    ? t("settings.search.noKey")
                    : t("settings.search.key", { reference: provider.credentialRef })
                  : `· ${provider.baseUrl}`}
              </span>
              {provider.enabled ? null : (
                <>
                  {" "}
                  <StatusBadge status="disabled" />
                </>
              )}
            </span>
            <span className="actions">
              <RowAction
                aria-label={t("settings.search.testLabel", { id: provider.providerId })}
                disabled={busy !== undefined}
                onClick={() => void run(`test:${provider.providerId}`, () => searchActions.test(client, provider.providerId))}
              >
                {busy === `test:${provider.providerId}` ? t("settings.action.testing") : t("settings.action.test")}
              </RowAction>
              <RowAction
                aria-label={t(provider.enabled ? "settings.search.disableLabel" : "settings.search.enableLabel", {
                  id: provider.providerId,
                })}
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`enable:${provider.providerId}`, () => searchActions.setEnabled(client, provider.providerId, !provider.enabled))
                }
              >
                {provider.enabled ? t("settings.action.disable") : t("settings.action.enable")}
              </RowAction>
              <RowAction
                tone="danger"
                aria-label={t("settings.search.removeLabel", { id: provider.providerId })}
                disabled={busy !== undefined}
                onClick={() => setRemoving(provider)}
              >
                {t("settings.action.remove")}
              </RowAction>
            </span>
          </li>
        ))}
      </ul>
      {data?.truncated === true ? (
        <Notice>{withParts(t("settings.search.truncated"), { command: <Command>tavi search list</Command> })}</Notice>
      ) : null}
      {unreadable.length > 0 ? (
        <Failure alert={false}>
          {withParts(t("settings.search.unreadable", { ids: unreadable.join(", ") }), { command: <Command>tavi search remove</Command> })}
        </Failure>
      ) : null}
      {removing !== undefined ? (
        <Confirm
          title={t("settings.search.removeTitle", { id: removing.providerId })}
          message={
            removing.credentialRef === undefined
              ? t("settings.search.removeMessage", { id: removing.providerId })
              : t("settings.search.removeMessageKey", { id: removing.providerId, reference: removing.credentialRef })
          }
          action={t("settings.action.remove")}
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
