import { useCallback, useState } from "react";

import { signsIn, type AppToolView, type ConnectableApp } from "@tavi/contracts";

import { AppLink } from "../shell/AppLink.js";
import { LoadState, Notice, Section, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { settingsPath } from "../shell/route.js";
import { mcpActions, pluginActions } from "../settings/plugins-api.js";
import { appActions } from "./apps-api.js";
import { mapOutcome } from "../../lib/ipc.js";
import { ChannelAppConnections } from "../settings/ChannelsSettings.js";
import { Confirm } from "../../ui/Confirm.js";
import { McpLogsModal, McpReviewModal } from "../settings/McpServers.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { AccountRow } from "./AccountRow.js";
import { ConnectSheet } from "./ConnectSheet.js";
import { RecentActivity } from "./RecentActivity.js";
import { AppIcon } from "./AppIcon.js";
import { authorsWords, HEALTH_BADGE, isolationWords, keptByWords, lendingWords, pageFix, primaryRepair, testedWords } from "./model.js";
import { SettingsForm } from "./SettingsForm.js";
import { ToolDecisions } from "./ToolDecisions.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * One app's page: its accounts,
 * what it can do with Allow / Ask / Block, its data and privacy, its settings,
 * the source behind it, and removing it. Drawn from the owner's read model
 * alone, so any app shows here the same way.
 */

/** What a site profile lets the agent do there, in a few words. */
const SITE_MODE_WORDS: Readonly<Record<"read" | "assist-only" | "stage" | "none" | "person-opens", string>> = {
  read: "Reads",
  "assist-only": "Reads for the chat only",
  stage: "Fills forms up to the last step",
  none: "Link only",
  "person-opens": "Reads only pages you open",
};
export function AppDetail({
  appId,
  connecting,
  review,
  onConnect,
  onBack,
  onOpenTask,
}: {
  readonly appId: string;
  /** The connect sheet is open (`/connect`), for this account or a new one. */
  readonly connecting: { readonly accountId?: string | undefined; readonly addAccount?: boolean } | undefined;
  /** A plugin whose review opens on arrival (an old Center link's `?review=`). */
  readonly review?: string | undefined;
  readonly onConnect: (connect: { readonly accountId?: string; readonly addAccount?: boolean } | undefined) => void;
  readonly onBack: () => void;
  /** Opens a chat in place; absent, its link loads the page. */
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const loaded = useLoaded(() => appActions.show(client, appId, workspaceId));
  const { data, error, loading } = loaded;
  // A channel's connections are read apart from the app: each reload after the connect sheet reads them again too.
  const [appRevision, setAppRevision] = useState(0);
  const reload = useCallback(() => {
    loaded.reload();
    setAppRevision((revision) => revision + 1);
  }, [loaded.reload]);
  const { busy, note, run } = useAction(reload);
  const [reviewing, setReviewing] = useState<string | undefined>(review);
  const [logs, setLogs] = useState<string | undefined>();
  const [disconnecting, setDisconnecting] = useState<string | undefined>();
  const [removeToo, setRemoveToo] = useState(false);
  const [lending, setLending] = useState<string | undefined>();
  const [settingsAccount, setSettingsAccount] = useState<string | undefined>();
  const [removing, setRemoving] = useState(false);
  const app = data?.app;
  const settingsAccountId =
    app?.accounts.find((account) => account.accountId === settingsAccount)?.accountId ?? app?.accounts[0]?.accountId;
  // An app's first account is never removed by a disconnect: only another of its accounts may go with its sign-in.
  const lent = app?.accounts.find((account) => account.accountId === lending);
  const secondary =
    app !== undefined && disconnecting !== undefined && app.accounts.length > 1 && app.accounts[0]?.accountId !== disconnecting;
  const busyNow = busy !== undefined;
  return (
    <section className="settings apps-detail">
      <Button variant="ghost" onClick={onBack}>
        ← Connected apps
      </Button>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <StatusNote note={note} />
      </LoadState>
      {app === undefined ? null : (
        <>
          <AppHead
            app={app}
            busy={busyNow}
            onRepair={() => {
              const repair = primaryRepair(app);
              const fix = pageFix(app, repair);
              if (repair === undefined || fix === undefined) return;
              const target = repair.accountId ?? app.source.pluginIds[0];
              if (fix === "connect") onConnect(repair.accountId === undefined ? {} : { accountId: repair.accountId });
              else if (fix === "review") setReviewing(target);
              else if (fix === "settings") {
                // The account whose setup is unfinished, not the first one.
                if (repair.accountId !== undefined) setSettingsAccount(repair.accountId);
                document.getElementById("section-settings")?.scrollIntoView({ block: "start" });
              } else if (fix === "enable" && target !== undefined)
                void run(`enable:${target}`, () =>
                  app.source.kind === "mcp"
                    ? mcpActions.setEnabled(client, target, true, workspaceId)
                    : pluginActions.setEnabled(client, target, true),
                );
              else if (fix === "test" && repair.accountId !== undefined) {
                const accountId = repair.accountId;
                void run(`test:${accountId}`, async () => {
                  const tested = await appActions.test(client, workspaceId, app.appId, accountId);
                  return mapOutcome(tested, (value) => testedWords(app.name, value));
                });
              } else if (fix === "sharing" && repair.accountId !== undefined) {
                const accountId = repair.accountId;
                void run(`sharing:${accountId}`, async () => {
                  const shared = await appActions.sharing(client, workspaceId, app.appId, accountId, "shared");
                  return mapOutcome(shared, () => `${app.name} is shared again.`);
                });
              }
            }}
          />
          {app.warnings.map((warning) => (
            <Notice key={warning}>{warning}</Notice>
          ))}
          <Section title="Accounts">
            {app.accounts.length === 0 ? <Empty>Not connected.</Empty> : null}
            <ul className="rows">
              {app.accounts.map((account) => (
                <AccountRow
                  key={account.accountId}
                  account={account}
                  appName={app.name}
                  signsIn={signsIn(app.auth)}
                  busy={busyNow}
                  canDisconnect={
                    app.source.kind === "channel"
                      ? signsIn(app.auth) && account.health !== "not-set-up"
                      : app.source.kind === "mcp" &&
                        (app.auth.kind === "oauth" ? account.signedInAt !== undefined : app.accounts.length > 1)
                  }
                  // A server that signs in to nothing and asks for no keys has nothing to reconnect.
                  onReconnect={app.auth.kind === "none" ? undefined : () => onConnect({ accountId: account.accountId })}
                  // A key not given yet, or refused, has nothing to test until it is given again.
                  onTest={
                    app.source.kind === "mcp" &&
                    !app.repairs.some((repair) => repair.kind === "finish-setup" && repair.accountId === account.accountId)
                      ? () =>
                          void run(`test:${account.accountId}`, async () => {
                            const tested = await appActions.test(client, workspaceId, app.appId, account.accountId);
                            return mapOutcome(tested, (value) => testedWords(account.identity ?? account.label, value));
                          })
                      : undefined
                  }
                  onDisconnect={() => setDisconnecting(account.accountId)}
                  onMailbox={
                    account.mailbox === undefined
                      ? undefined
                      : (mailbox) =>
                          void run(`mailbox:${account.accountId}`, async () => {
                            const set = await appActions.mailbox(client, workspaceId, app.appId, account.accountId, mailbox);
                            return mapOutcome(set, () =>
                              mailbox === "off"
                                ? "The agent no longer reads this mailbox."
                                : mailbox === "read"
                                  ? "The agent may read and draft in this mailbox; it never sends."
                                  : "The agent may also send drafts you approve, each one shown before it goes.",
                            );
                          })
                  }
                  onReceive={
                    account.receives === undefined
                      ? undefined
                      : (on) =>
                          void run(`receive:${account.accountId}`, async () => {
                            const set = await appActions.receive(client, workspaceId, app.appId, account.accountId, on);
                            return mapOutcome(set, () =>
                              on
                                ? "Tavi is reached through this account again. If the provider has not allowed it yet, sign in again."
                                : "This account takes nothing in: it only carries what you turned on.",
                            );
                          })
                  }
                  onCalendar={
                    account.calendar === undefined
                      ? undefined
                      : (on) =>
                          void run(`calendar:${account.accountId}`, async () => {
                            const set = await appActions.calendar(client, workspaceId, app.appId, account.accountId, on);
                            return mapOutcome(set, () =>
                              on
                                ? "The agent may use this calendar. If Google has not allowed it yet, sign in again."
                                : "The agent no longer uses this calendar.",
                            );
                          })
                  }
                  onPeople={
                    app.source.kind === "mcp" && account.sharing === "shared"
                      ? (on) => {
                          // Lending an account is asked first, saying whose it is; taking it back is not.
                          if (on) setLending(account.accountId);
                          else
                            void run(`people:${account.accountId}`, () => mcpActions.people(client, account.accountId, false, workspaceId));
                        }
                      : undefined
                  }
                  onSharing={(sharing) =>
                    void run(`sharing:${account.accountId}`, async () => {
                      const set = await appActions.sharing(client, workspaceId, app.appId, account.accountId, sharing);
                      return mapOutcome(set, () =>
                        sharing === "personal"
                          ? `${account.identity ?? account.label} is Personal: only your own chats use it.`
                          : `${account.identity ?? account.label} is Shared: people you allowed may use it.`,
                      );
                    })
                  }
                />
              ))}
            </ul>
            {(app.auth.kind === "oauth" && app.source.preset !== undefined) || (signsIn(app.auth) && app.source.kind === "channel") ? (
              <Button size="sm" disabled={busyNow} onClick={() => onConnect({ addAccount: true })}>
                Add another account
              </Button>
            ) : null}
          </Section>
          {/* A channel's connections: their settings and who may reach the agent through each. */}
          {app.source.kind !== "channel" ? null : (
            <Section title="Connections and people">
              {/* Read again whenever the app is, so a choice the connect sheet saved shows at once. */}
              <ChannelAppConnections key={appRevision} providerId={app.appId} />
            </Section>
          )}
          {app.sites === undefined || app.sites.length === 0 ? null : (
            <Section title="Sites this app may browse">
              <p className="muted">
                Each is off until you turn it on. On, the agent browses it in your browser within the rules shown, with your session and its
                page limits.
              </p>
              <ul className="rows">
                {app.sites.map((site) => (
                  <li key={site.siteId} className="row apps-account">
                    <span className="apps-account-info">
                      <strong>{site.name}</strong>{" "}
                      <span className="badge">{SITE_MODE_WORDS[site.navigate ? site.mode : "person-opens"]}</span>
                      <span className="meta-sm">{site.hosts.join(", ")}</span>
                      <span className="meta-sm">
                        {site.reason}
                        {site.watchable ? " Read on a schedule too, where its robots.txt allows." : ""}
                      </span>
                    </span>
                    <span className="actions">
                      <label className="apps-check">
                        <input
                          type="checkbox"
                          checked={site.on}
                          disabled={busyNow}
                          onChange={(event) =>
                            void run(`sites:${site.siteId}`, async () => {
                              const set = await appActions.sites(client, workspaceId, app.appId, site.siteId, event.target.checked);
                              return mapOutcome(set, () => (event.target.checked ? `${site.name} is on.` : `${site.name} is off.`));
                            })
                          }
                        />{" "}
                        On
                      </label>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="What it can do">
            <ToolDecisions
              tools={app.tools}
              busy={busyNow}
              {...(app.source.kind === "mcp"
                ? {
                    onReview: (tool: AppToolView) =>
                      setReviewing(app.source.pluginIds.find((pluginId) => tool.toolId.startsWith(`${pluginId}.`))),
                  }
                : {})}
              onPick={(tool, target) =>
                void run(`permission:${tool.toolId}`, async () => {
                  const set = await appActions.permission(client, workspaceId, app.appId, tool.toolId, target);
                  return mapOutcome(
                    set,
                    () => `${tool.title}: ${target === "allow" ? "allowed" : target === "ask" ? "asks first" : "blocked"}.`,
                  );
                })
              }
            />
            {/* Only while an account takes messages in: one that only carries its mailbox or calendar is no way to reach Tavi. */}
            {app.channel === undefined || !app.accounts.some((account) => account.receives !== false) ? null : (
              <p className="muted">Also a channel: people can reach Tavi through it.</p>
            )}
          </Section>
          <Section title="Recent activity">
            <RecentActivity appId={app.appId} onOpenTask={onOpenTask} />
          </Section>
          <Section title="Data and privacy">
            <DataAndPrivacy app={app} />
          </Section>
          {/* A channel's settings stay in Settings → Channels. */}
          {app.settings.length > 0 && app.source.kind !== "channel" && app.accounts[0] !== undefined && !app.accounts[0].readOnly ? (
            <Section title="Settings">
              {/* Each account has its own settings: the one chosen is the one saved. */}
              {app.accounts.length > 1 ? (
                <label className="apps-field">
                  Account{" "}
                  <Select
                    aria-label="Account to set up"
                    value={settingsAccountId ?? ""}
                    onChange={(event) => setSettingsAccount(event.target.value)}
                  >
                    {app.accounts.map((account) => (
                      <option key={account.accountId} value={account.accountId}>
                        {account.label}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <SettingsForm
                key={settingsAccountId}
                fields={app.settings}
                busy={busyNow}
                onSave={(values) =>
                  void run("configure", async () => {
                    const saved = await appActions.configure(client, workspaceId, app.appId, {
                      values,
                      ...(settingsAccountId === undefined ? {} : { accountId: settingsAccountId }),
                    });
                    return mapOutcome(saved, () => "Saved.");
                  })
                }
              />
            </Section>
          ) : null}
          <Section title="Advanced">
            <p className="muted">
              Source: {app.source.kind === "mcp" ? "an MCP server" : app.source.kind === "channel" ? "a channel" : "a plugin"}
              {app.source.pluginIds.length === 0 ? "" : ` (${app.source.pluginIds.join(", ")})`}
              {app.source.verified === "tavi-preset" ? ", a Tavi preset" : app.source.verified === "unreviewed" ? ", not reviewed yet" : ""}
              .
            </p>
            {app.source.kind === "mcp" ? (
              <div className="actions">
                {app.source.pluginIds.map((pluginId) => (
                  <span key={pluginId}>
                    <Button size="sm" onClick={() => setReviewing(pluginId)}>
                      Review {app.source.pluginIds.length > 1 ? pluginId : "tools"}
                    </Button>{" "}
                    <Button size="sm" onClick={() => setLogs(pluginId)}>
                      View log{app.source.pluginIds.length > 1 ? ` (${pluginId})` : ""}
                    </Button>
                  </span>
                ))}
              </div>
            ) : null}
            {/* Turned off, its tools are not offered and it keeps everything: Turn it on again from the fix above. */}
            {app.accounts.some((account) => account.on === true) || app.source.kind !== "channel" ? (
              <div className="actions">
                {app.accounts
                  .filter((account) => account.on === true)
                  .map((account) => (
                    <Button
                      size="sm"
                      key={account.accountId}
                      disabled={busyNow}
                      onClick={() =>
                        void run(`disable:${account.accountId}`, () =>
                          app.source.kind === "mcp"
                            ? mcpActions.setEnabled(client, account.accountId, false, workspaceId)
                            : pluginActions.setEnabled(client, account.accountId, false),
                        )
                      }
                    >
                      Turn {app.accounts.length > 1 ? account.label : app.name} off
                    </Button>
                  ))}
                {/* A channel is removed from Settings → Channels. */}
                {app.source.kind === "channel" ? null : (
                  <Button size="sm" variant="danger" disabled={busyNow} onClick={() => setRemoving(true)}>
                    Remove {app.name}
                  </Button>
                )}
              </div>
            ) : null}
            {app.repairs.length === 0 ? null : (
              <p className="meta-sm">
                The same fix from a terminal: <code>{app.repairs[0]?.cli}</code>
              </p>
            )}
          </Section>
          {connecting === undefined ? null : (
            <ConnectSheet
              client={client}
              workspaceId={workspaceId}
              app={app}
              accountId={connecting.accountId}
              addAccount={connecting.addAccount === true}
              onClose={() => {
                onConnect(undefined);
                reload();
              }}
              onConnected={() => {
                onConnect(undefined);
                reload();
              }}
              {...(app.source.kind === "mcp"
                ? {
                    onReview: (accountId: string) => {
                      onConnect(undefined);
                      reload();
                      setReviewing(accountId);
                    },
                  }
                : {})}
            />
          )}
          {reviewing === undefined ? null : (
            <McpReviewModal
              pluginId={reviewing}
              onClose={() => setReviewing(undefined)}
              onDone={() => {
                setReviewing(undefined);
                reload();
              }}
            />
          )}
          {logs === undefined ? null : <McpLogsModal pluginId={logs} onClose={() => setLogs(undefined)} />}
          {disconnecting === undefined ? null : (
            <Confirm
              title={`Disconnect ${app.accounts.find((account) => account.accountId === disconnecting)?.identity ?? disconnecting}?`}
              message={disconnectWords(
                app,
                app.accounts.find((account) => account.accountId === disconnecting),
              )}
              action="Disconnect"
              onClose={() => {
                setDisconnecting(undefined);
                setRemoveToo(false);
              }}
              onConfirm={() =>
                run(`disconnect:${disconnecting}`, async () => {
                  const out = await appActions.disconnect(client, workspaceId, app.appId, disconnecting, secondary && removeToo);
                  return mapOutcome(out, () => (secondary && removeToo ? "Disconnected and removed." : "Disconnected."));
                })
              }
            >
              {/* The first account only signs out; another may go with it, if the person says so. */}
              {secondary ? (
                <label className="apps-remove-too">
                  <input type="checkbox" checked={removeToo} onChange={(event) => setRemoveToo(event.target.checked)} /> Also remove this
                  account and its tools
                </label>
              ) : null}
            </Confirm>
          )}
          {lending === undefined ? null : (
            <Confirm
              title={`Let people use ${lent?.identity ?? app.name}?`}
              message={`The people you allowed in this workspace will be able to ask Tavi to ${lendingWords(app)} your ${app.name}${lent?.identity === undefined ? "" : ` (${lent.identity})`}${app.auth.kind === "api-key" ? ", with your key" : signsIn(app.auth) ? ", with your sign-in" : ""}.`}
              action="Let them use it"
              onClose={() => setLending(undefined)}
              onConfirm={() => run(`people:${lending}`, () => mcpActions.people(client, lending, true, workspaceId))}
            />
          )}
          {removing ? (
            <Confirm
              title={`Remove ${app.name}?`}
              message={`Every account of ${app.name} is removed with it, and its tools stop. What Tavi already remembered stays.`}
              action="Remove"
              onClose={() => setRemoving(false)}
              onConfirm={() =>
                run("remove", async () => {
                  const out = await appActions.remove(client, workspaceId, app.appId);
                  if (out.ok) onBack();
                  return mapOutcome(out, () => `${app.name} removed.`);
                })
              }
            />
          ) : null}
        </>
      )}
    </section>
  );
}

/** What a disconnect does, said before it is done: one revoke can end other apps' sign-ins, so it waits for the last. */
function disconnectWords(app: ConnectableApp, account: ConnectableApp["accounts"][number] | undefined): string {
  const kept = account?.keptBy ?? [];
  const provider = app.publisher ?? "The provider";
  const revoke = kept.length === 0 ? "Its sign-in is revoked where the provider allows it" : keptByWords(kept, provider);
  return `The agent can no longer use this ${app.name} account. ${revoke}${app.accounts.length > 1 ? ", and this account is removed" : ""}. What Tavi already remembered stays; delete it in Soul & memory.`;
}

function AppHead({ app, busy, onRepair }: { readonly app: ConnectableApp; readonly busy: boolean; readonly onRepair: () => void }) {
  const badge = HEALTH_BADGE[app.health];
  const repair = primaryRepair(app);
  const fix = pageFix(app, repair);
  return (
    <header className="settings-head apps-head">
      <div>
        <h1>
          <AppIcon name={app.name} icon={app.icon} /> {app.name} <span className={`badge badge-${badge.tone}`}>{badge.text}</span>
        </h1>
        <p className="settings-description">
          {authorsWords(app) && app.summaryByTavi !== true ? (
            <span data-source="author">{`Its author says: “${app.summary}”`}</span>
          ) : (
            app.summary
          )}
          {app.publisher === undefined ? "" : ` · ${app.publisher}`}
          {app.source.verified === "tavi-preset" ? " · Tavi preset" : ""}
        </p>
        {repair === undefined ? null : <p className="muted">{repair.detail}</p>}
      </div>
      {fix === undefined ? (
        repair === undefined ? null : (
          <p className="meta-sm">
            Fix it from a terminal: <code>{repair.cli}</code>
          </p>
        )
      ) : fix === "channels" ? (
        <AppLink href={settingsPath("messaging")} className="button-primary" onFollow={undefined}>
          {`${repair?.title ?? app.name} in Channels`}
        </AppLink>
      ) : (
        <Button variant="primary" disabled={busy} onClick={onRepair}>
          {repair?.title}
        </Button>
      )}
    </header>
  );
}

function DataAndPrivacy({ app }: { readonly app: ConnectableApp }) {
  const scopes = app.auth.kind === "oauth" || app.auth.kind === "device" ? app.auth.scopes : [];
  const missing = new Set(app.accounts.flatMap((account) => account.missingScopes));
  return (
    <dl className="summary-grid">
      <div>
        <dt>Access it asks for{authorsWords(app) ? ", in its author's words" : ""}</dt>
        <dd>
          {scopes.length === 0
            ? "No sign-in access."
            : scopes.map((scope) => `${scope.says}${missing.has(scope.scope) ? " (not allowed)" : ""}`).join(" · ")}
        </dd>
      </div>
      <div>
        <dt>Where calls go</dt>
        <dd>
          {app.egress.anyNetwork
            ? "Any network"
            : app.egress.hosts.length === 0
              ? "Nowhere off this computer"
              : app.egress.hosts.join(", ")}
          {app.egress.lan ? ", and your local network" : ""}
        </dd>
      </div>
      <div>
        <dt>What runs</dt>
        <dd>{isolationWords(app)}</dd>
      </div>
      <div>
        <dt>Credentials it receives</dt>
        <dd>
          {app.credentials.length === 0
            ? "None"
            : app.credentials.map((credential) => `${credential.name}${credential.raw ? " (handed over as itself)" : ""}`).join(", ")}
        </dd>
      </div>
      <div>
        <dt>What it returns</dt>
        <dd>
          Treated as {app.trust.output === "untrusted" ? "untrusted content" : "trusted"}
          {app.trust.confidentiality === "personal" ? ", and as personal data" : ""}. Disconnecting does not delete what Tavi already
          remembered, or what the provider holds.
        </dd>
      </div>
    </dl>
  );
}
