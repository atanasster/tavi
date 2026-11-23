import { useCallback, useState } from "react";

import { signsIn, type AppToolView, type ConnectableApp } from "@tavi/contracts";

import { AppLink } from "../shell/AppLink.js";
import { BackLink, LoadState, Notice, PageNote, Section } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import { settingsPath } from "../shell/route.js";
import { mcpActions, pluginActions } from "../settings/plugins-api.js";
import { appActions } from "./apps-api.js";
import { translateNow, useT } from "../../lib/i18n.js";
import { mapOutcome } from "../../lib/ipc.js";
import type { UiKey } from "../../locales/en.js";
import { ChannelAppConnections } from "../settings/ChannelsSettings.js";
import { Confirm } from "../../ui/Confirm.js";
import { McpLogsModal, McpReviewModal } from "../settings/McpServers.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { AccountRow } from "./AccountRow.js";
import { ConnectSheet } from "./ConnectSheet.js";
import { RecentActivity } from "./RecentActivity.js";
import { AppIcon } from "./AppIcon.js";
import {
  authorsWords,
  HEALTH_BADGE,
  isolationWords,
  keptByWords,
  lendingAccess,
  pageFix,
  primaryRepair,
  repairDetail,
  repairTitle,
  testedWords,
} from "./model.js";
import { SettingsForm } from "./SettingsForm.js";
import { ToolDecisions } from "./ToolDecisions.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { withParts } from "../../ui/with-parts.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * One app's page: its accounts,
 * what it can do with Allow / Ask / Block, its data and privacy, its settings,
 * the source behind it, and removing it. Drawn from the owner's read model
 * alone, so any app shows here the same way.
 */

/** What a site profile lets the agent do there, in a few words. */
const SITE_MODE_WORDS: Readonly<Record<"read" | "assist-only" | "stage" | "none" | "person-opens", UiKey>> = {
  read: "apps.site.read",
  "assist-only": "apps.site.assistOnly",
  stage: "apps.site.stage",
  none: "apps.site.none",
  "person-opens": "apps.site.personOpens",
};

/** The lending question, by what the account's tools do. */
const LEND_MESSAGE = { read: "apps.lend.messageRead", change: "apps.lend.messageChange", send: "apps.lend.messageSend" } as const;
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
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const loaded = useLoaded(() => appActions.show(client, appId, workspaceId));
  const { data, error, loading } = loaded;
  // A channel's connections are read apart from the app: each reload after the connect sheet reads them again too.
  const [appRevision, setAppRevision] = useState(0);
  const reload = useCallback(() => {
    loaded.reload();
    setAppRevision((revision) => revision + 1);
  }, [loaded.reload]);
  const { busy, note, tone, run } = useAction(reload);
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
      <BackLink label={t("apps.page.title")} onBack={onBack} />
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <PageNote tone={tone} note={note} />
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
                  return mapOutcome(shared, () => t("apps.detail.sharedAgain", { app: app.name }));
                });
              }
            }}
          />
          {app.warnings.map((warning) => (
            <Notice key={warning}>{warning}</Notice>
          ))}
          <Section title={t("apps.detail.accounts")}>
            {app.accounts.length === 0 ? <Empty>{t("apps.detail.notConnected")}</Empty> : null}
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
                              t(
                                mailbox === "off"
                                  ? "apps.detail.mailboxOff"
                                  : mailbox === "read"
                                    ? "apps.detail.mailboxRead"
                                    : "apps.detail.mailboxSend",
                              ),
                            );
                          })
                  }
                  onReceive={
                    account.receives === undefined
                      ? undefined
                      : (on) =>
                          void run(`receive:${account.accountId}`, async () => {
                            const set = await appActions.receive(client, workspaceId, app.appId, account.accountId, on);
                            return mapOutcome(set, () => t(on ? "apps.detail.receiveOn" : "apps.detail.receiveOff"));
                          })
                  }
                  onCalendar={
                    account.calendar === undefined
                      ? undefined
                      : (on) =>
                          void run(`calendar:${account.accountId}`, async () => {
                            const set = await appActions.calendar(client, workspaceId, app.appId, account.accountId, on);
                            return mapOutcome(set, () => t(on ? "apps.detail.calendarOn" : "apps.detail.calendarOff"));
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
                        t(sharing === "personal" ? "apps.detail.sharingPersonal" : "apps.detail.sharingShared", {
                          account: account.identity ?? account.label,
                        }),
                      );
                    })
                  }
                />
              ))}
            </ul>
            {(app.auth.kind === "oauth" && app.source.preset !== undefined) || (signsIn(app.auth) && app.source.kind === "channel") ? (
              <Button size="sm" disabled={busyNow} onClick={() => onConnect({ addAccount: true })}>
                {t("apps.detail.addAccount")}
              </Button>
            ) : null}
          </Section>
          {/* A channel's connections: their settings and who may reach the agent through each. */}
          {app.source.kind !== "channel" ? null : (
            <Section title={t("apps.detail.connections")}>
              {/* Read again whenever the app is, so a choice the connect sheet saved shows at once. */}
              <ChannelAppConnections key={appRevision} providerId={app.appId} />
            </Section>
          )}
          {app.sites === undefined || app.sites.length === 0 ? null : (
            <Section title={t("apps.detail.sites")}>
              <p className="muted">{t("apps.detail.sitesNote")}</p>
              <ul className="rows">
                {app.sites.map((site) => (
                  <li key={site.siteId} className="row apps-account">
                    <span className="apps-account-info">
                      <strong>{site.name}</strong>{" "}
                      <span className="badge">{t(SITE_MODE_WORDS[site.navigate ? site.mode : "person-opens"])}</span>
                      <span className="meta-sm">{site.hosts.join(", ")}</span>
                      <span className="meta-sm">
                        {site.reason}
                        {/* Its own sentence after the site's reason. */}
                        {site.watchable ? ` ${t("apps.detail.siteWatchable")}` : ""}
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
                              return mapOutcome(set, () =>
                                t(event.target.checked ? "apps.detail.siteOn" : "apps.detail.siteOff", { site: site.name }),
                              );
                            })
                          }
                        />{" "}
                        {t("apps.detail.on")}
                      </label>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title={t("apps.detail.tools")}>
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
                  return mapOutcome(set, () =>
                    t(
                      target === "allow"
                        ? "apps.detail.toolAllowed"
                        : target === "ask"
                          ? "apps.detail.toolAsks"
                          : "apps.detail.toolBlocked",
                      { tool: tool.title },
                    ),
                  );
                })
              }
            />
            {/* Only while an account takes messages in: one that only carries its mailbox or calendar is no way to reach Tavi. */}
            {app.channel === undefined || !app.accounts.some((account) => account.receives !== false) ? null : (
              <p className="muted">{t("apps.detail.alsoChannel")}</p>
            )}
          </Section>
          <Section title={t("apps.detail.activity")}>
            <RecentActivity appId={app.appId} onOpenTask={onOpenTask} />
          </Section>
          <Section title={t("apps.detail.privacy")}>
            <DataAndPrivacy app={app} />
          </Section>
          {/* A channel's settings stay in Settings → Channels. */}
          {app.settings.length > 0 && app.source.kind !== "channel" && app.accounts[0] !== undefined && !app.accounts[0].readOnly ? (
            <Section title={t("apps.detail.settings")} anchor="settings">
              {/* Each account has its own settings: the one chosen is the one saved. */}
              {app.accounts.length > 1 ? (
                <label className="apps-field">
                  {t("apps.detail.account")}{" "}
                  <Select
                    aria-label={t("apps.detail.accountToSetUp")}
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
                    return mapOutcome(saved, () => t("apps.detail.saved"));
                  })
                }
              />
            </Section>
          ) : null}
          <Section title={t("apps.detail.advanced")}>
            <p className="muted">
              {t(
                app.source.kind === "mcp"
                  ? "apps.detail.sourceMcp"
                  : app.source.kind === "channel"
                    ? "apps.detail.sourceChannel"
                    : "apps.detail.sourcePlugin",
                {
                  plugins: app.source.pluginIds.length === 0 ? "" : ` (${app.source.pluginIds.join(", ")})`,
                  verified:
                    app.source.verified === "tavi-preset"
                      ? t("apps.detail.sourcePreset")
                      : app.source.verified === "unreviewed"
                        ? t("apps.detail.sourceUnreviewed")
                        : "",
                },
              )}
            </p>
            {app.source.kind === "mcp" ? (
              <div className="actions">
                {app.source.pluginIds.map((pluginId) => (
                  <span key={pluginId}>
                    <Button size="sm" onClick={() => setReviewing(pluginId)}>
                      {app.source.pluginIds.length > 1 ? t("apps.detail.reviewPlugin", { plugin: pluginId }) : t("apps.detail.reviewTools")}
                    </Button>{" "}
                    <Button size="sm" onClick={() => setLogs(pluginId)}>
                      {app.source.pluginIds.length > 1 ? t("apps.detail.viewLogOf", { plugin: pluginId }) : t("apps.detail.viewLog")}
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
                      {t("apps.detail.turnOff", { name: app.accounts.length > 1 ? account.label : app.name })}
                    </Button>
                  ))}
                {/* A channel is removed from Settings → Channels. */}
                {app.source.kind === "channel" ? null : (
                  <Button size="sm" variant="danger" disabled={busyNow} onClick={() => setRemoving(true)}>
                    {t("apps.detail.remove", { app: app.name })}
                  </Button>
                )}
              </div>
            ) : null}
            {app.repairs.length === 0 ? null : (
              <p className="meta-sm">{withParts(t("apps.detail.sameFix"), { command: <code>{app.repairs[0]?.cli}</code> })}</p>
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
              title={t("apps.disconnect.title", {
                account: app.accounts.find((account) => account.accountId === disconnecting)?.identity ?? disconnecting,
              })}
              message={disconnectWords(
                app,
                app.accounts.find((account) => account.accountId === disconnecting),
              )}
              action={t("apps.disconnect.action")}
              onClose={() => {
                setDisconnecting(undefined);
                setRemoveToo(false);
              }}
              onConfirm={() =>
                run(`disconnect:${disconnecting}`, async () => {
                  const out = await appActions.disconnect(client, workspaceId, app.appId, disconnecting, secondary && removeToo);
                  return mapOutcome(out, () => t(secondary && removeToo ? "apps.disconnect.doneRemoved" : "apps.disconnect.done"));
                })
              }
            >
              {/* The first account only signs out; another may go with it, if the person says so. */}
              {secondary ? (
                <label className="apps-remove-too">
                  <input type="checkbox" checked={removeToo} onChange={(event) => setRemoveToo(event.target.checked)} />{" "}
                  {t("apps.disconnect.removeToo")}
                </label>
              ) : null}
            </Confirm>
          )}
          {lending === undefined ? null : (
            <Confirm
              title={t("apps.lend.title", { account: lent?.identity ?? app.name })}
              message={t(LEND_MESSAGE[lendingAccess(app)], {
                app: app.name,
                identity: lent?.identity === undefined ? "" : ` (${lent.identity})`,
                with: app.auth.kind === "api-key" ? t("apps.lend.withKey") : signsIn(app.auth) ? t("apps.lend.withSignIn") : "",
              })}
              action={t("apps.lend.action")}
              onClose={() => setLending(undefined)}
              onConfirm={() => run(`people:${lending}`, () => mcpActions.people(client, lending, true, workspaceId))}
            />
          )}
          {removing ? (
            <Confirm
              title={t("apps.removeApp.title", { app: app.name })}
              message={t("apps.removeApp.message", { app: app.name })}
              action={t("apps.removeApp.action")}
              onClose={() => setRemoving(false)}
              onConfirm={() =>
                run("remove", async () => {
                  const out = await appActions.remove(client, workspaceId, app.appId);
                  if (out.ok) onBack();
                  return mapOutcome(out, () => t("apps.removeApp.done", { app: app.name }));
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
  const revoke = kept.length === 0 ? translateNow("apps.disconnect.revoked") : keptByWords(kept, app.publisher);
  return translateNow(app.accounts.length > 1 ? "apps.disconnect.messageRemoved" : "apps.disconnect.message", { app: app.name, revoke });
}

function AppHead({ app, busy, onRepair }: { readonly app: ConnectableApp; readonly busy: boolean; readonly onRepair: () => void }) {
  const t = useT();
  const badge = HEALTH_BADGE[app.health];
  const repair = primaryRepair(app);
  const fix = pageFix(app, repair);
  return (
    <header className="settings-head apps-head">
      <div>
        <h1>
          <AppIcon name={app.name} icon={app.icon} /> {app.name} <span className={`badge badge-${badge.tone}`}>{t(badge.textKey)}</span>
        </h1>
        <p className="settings-description">
          {authorsWords(app) && app.summaryByTavi !== true ? (
            <span data-source="author">{t("apps.detail.authorSays", { summary: app.summary })}</span>
          ) : (
            app.summary
          )}
          {app.publisher === undefined ? "" : ` · ${app.publisher}`}
          {app.source.verified === "tavi-preset" ? ` · ${t("apps.badge.taviPreset")}` : ""}
        </p>
        {repair === undefined ? null : <p className="muted">{repairDetail(repair)}</p>}
      </div>
      {fix === undefined ? (
        repair === undefined ? null : (
          <p className="meta-sm">{withParts(t("apps.detail.fixFromTerminal"), { command: <code>{repair.cli}</code> })}</p>
        )
      ) : fix === "channels" ? (
        <AppLink href={settingsPath("messaging")} className="button-primary" onFollow={undefined}>
          {t("apps.detail.inChannels", { action: repair === undefined ? app.name : repairTitle(repair) })}
        </AppLink>
      ) : (
        <Button variant="primary" disabled={busy} onClick={onRepair}>
          {repair === undefined ? undefined : repairTitle(repair)}
        </Button>
      )}
    </header>
  );
}

function DataAndPrivacy({ app }: { readonly app: ConnectableApp }) {
  const t = useT();
  const scopes = app.auth.kind === "oauth" || app.auth.kind === "device" ? app.auth.scopes : [];
  const missing = new Set(app.accounts.flatMap((account) => account.missingScopes));
  return (
    <dl className="summary-grid">
      <div>
        <dt>{t(authorsWords(app) ? "apps.privacy.accessAuthor" : "apps.privacy.access")}</dt>
        <dd>
          {scopes.length === 0
            ? t("apps.privacy.noAccess")
            : scopes
                .map((scope) => (missing.has(scope.scope) ? t("apps.privacy.notAllowed", { scope: scope.says }) : scope.says))
                .join(" · ")}
        </dd>
      </div>
      <div>
        <dt>{t("apps.privacy.where")}</dt>
        <dd>
          {(() => {
            const where = app.egress.anyNetwork
              ? t("apps.privacy.anyNetwork")
              : app.egress.hosts.length === 0
                ? t("apps.privacy.nowhere")
                : app.egress.hosts.join(", ");
            return app.egress.lan ? t("apps.privacy.andLan", { where }) : where;
          })()}
        </dd>
      </div>
      <div>
        <dt>{t("apps.privacy.runs")}</dt>
        <dd>{isolationWords(app)}</dd>
      </div>
      <div>
        <dt>{t("apps.privacy.credentials")}</dt>
        <dd>
          {app.credentials.length === 0
            ? t("apps.privacy.none")
            : app.credentials
                .map((credential) => (credential.raw ? t("apps.privacy.raw", { credential: credential.name }) : credential.name))
                .join(", ")}
        </dd>
      </div>
      <div>
        <dt>{t("apps.privacy.returns")}</dt>
        <dd>
          {t(
            app.trust.output === "untrusted"
              ? app.trust.confidentiality === "personal"
                ? "apps.privacy.untrustedPersonal"
                : "apps.privacy.untrusted"
              : app.trust.confidentiality === "personal"
                ? "apps.privacy.trustedPersonal"
                : "apps.privacy.trusted",
          )}
        </dd>
      </div>
    </dl>
  );
}
