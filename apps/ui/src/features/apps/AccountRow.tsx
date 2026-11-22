import type { AppAccountView, AppMailboxAccess, AppSharing } from "@tavi/contracts";

import { AppLink } from "../shell/AppLink.js";
import { translateNow, useT } from "../../lib/i18n.js";
import { localDayWithYear } from "../../lib/time.js";
import { settingsPath } from "../shell/route.js";
import { useTimeZone } from "../shell/Workspace.js";
import { andList, HEALTH_BADGE, signInByWords } from "./model.js";
import { RowAction, ROW_LINK_CLASS } from "../../ui/RowAction.js";

/**
 * One account of an app: who it
 * is, how it is, where it is used, whether it is Personal or Shared, and what
 * can be done with it. A channel that connects with keys rather than a
 * sign-in is set up in Settings → Channels, so it is shown, not changed, here.
 */
export function AccountRow({
  account,
  appName,
  busy,
  canDisconnect,
  onReconnect,
  onTest,
  onDisconnect,
  onSharing,
  onPeople,
  onMailbox,
  onCalendar,
  onReceive,
  signsIn = true,
}: {
  readonly account: AppAccountView;
  readonly appName: string;
  readonly busy: boolean;
  readonly canDisconnect: boolean;
  /** Sign in again, or enter its keys again; absent for an app with neither. */
  readonly onReconnect?: (() => void) | undefined;
  readonly onTest?: (() => void) | undefined;
  readonly onDisconnect: () => void;
  readonly onSharing: (sharing: AppSharing) => void;
  /** A Shared account may be lent to the people you allowed; absent, it cannot be. */
  readonly onPeople?: ((on: boolean) => void) | undefined;
  /** A mailbox's opt-in: what the agent may do in it. */
  readonly onMailbox?: ((mailbox: AppMailboxAccess) => void) | undefined;
  /** An account's calendar opt-in: whether the agent may use it. */
  readonly onCalendar?: ((on: boolean) => void) | undefined;
  /** Whether a channel account takes messages in. */
  readonly onReceive?: ((on: boolean) => void) | undefined;
  /** Whether the app connects by signing in; false for one set up with keys. */
  readonly signsIn?: boolean;
}) {
  const t = useT();
  const timeZone = useTimeZone();
  const badge = HEALTH_BADGE[account.health];
  const name = account.identity ?? account.label;
  const sharingName = `${account.accountId}-sharing`;
  return (
    <li className="row apps-account">
      <span className="apps-account-info">
        <span className="apps-title-line cluster">
          <strong>{name}</strong>
          <span className={`badge badge-${badge.tone}`}>{t(badge.textKey)}</span>
        </span>
        <span className="meta-sm">
          {/* An app set up with keys (a Telegram bot token) has no sign-in to report; one that keeps no sign-in time (a
              Google account) is signed in unless its health says it is not set up. */}
          {account.signedInAt !== undefined
            ? t("apps.account.signedIn", { day: localDayWithYear(account.signedInAt, timeZone) })
            : signsIn && account.health === "not-set-up"
              ? t("apps.account.notSignedIn")
              : ""}
          {account.nextSignInBy === undefined ? "" : ` ${signInByWords(account.nextSignInBy, timeZone)}.`}
          {account.missingScopes.length > 0 ? ` ${t("apps.account.missingScopes")}` : ""}
        </span>
        <span className="meta-sm">{usageLine(account)}</span>
        {account.keptBy === undefined || account.keptBy.length === 0 ? null : (
          <span className="meta-sm">{t("apps.account.keptBy", { apps: andList(account.keptBy) })}</span>
        )}
        {account.setup === undefined ? null : (
          <span className="meta-sm apps-account-setup">
            {account.setup.lines.map((line, index) => (
              <span key={index}>{line}</span>
            ))}
            {account.setup.link === undefined ? null : (
              <a href={account.setup.link.url} target="_blank" rel="noopener noreferrer">
                {account.setup.link.label}
              </a>
            )}
          </span>
        )}
      </span>
      {account.readOnly ? (
        <span className="actions">
          <AppLink href={settingsPath("messaging")} className={ROW_LINK_CLASS} onFollow={undefined}>
            {account.health === "ready" ? t("apps.account.openInChannels") : t("apps.account.reconnectInChannels", { app: appName })}
          </AppLink>
        </span>
      ) : (
        <span className="actions">
          <fieldset className="apps-sharing">
            <legend className="visually-hidden">{t("apps.account.whoMayUse", { account: name })}</legend>
            <label>
              <input
                type="radio"
                name={sharingName}
                checked={account.sharing === "personal"}
                disabled={busy}
                onChange={() => onSharing("personal")}
              />{" "}
              {t("apps.account.personal")}
            </label>
            <label>
              <input
                type="radio"
                name={sharingName}
                checked={account.sharing === "shared"}
                disabled={busy}
                onChange={() => onSharing("shared")}
              />{" "}
              {t("apps.account.shared")}
            </label>
          </fieldset>
          {account.mailbox === undefined || onMailbox === undefined ? null : (
            <>
              <label className="apps-check">
                <input
                  type="checkbox"
                  checked={account.mailbox !== "off"}
                  disabled={busy}
                  onChange={(event) => onMailbox(event.target.checked ? "read" : "off")}
                />{" "}
                {t("apps.account.mailboxRead")}
              </label>
              <label className="apps-check">
                <input
                  type="checkbox"
                  checked={account.mailbox === "send"}
                  disabled={busy || account.mailbox === "off"}
                  onChange={(event) => onMailbox(event.target.checked ? "send" : "read")}
                />{" "}
                {t("apps.account.mailboxSend")}
              </label>
            </>
          )}
          {account.receives === undefined || onReceive === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={account.receives} disabled={busy} onChange={(event) => onReceive(event.target.checked)} />{" "}
              {t("apps.account.receive")}
            </label>
          )}
          {account.calendar === undefined || onCalendar === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={account.calendar} disabled={busy} onChange={(event) => onCalendar(event.target.checked)} />{" "}
              {t("apps.account.calendar")}
            </label>
          )}
          {onPeople === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={account.people} disabled={busy} onChange={(event) => onPeople(event.target.checked)} />{" "}
              {t("apps.account.people")}
            </label>
          )}
          {onReconnect === undefined ? null : (
            <RowAction disabled={busy} onClick={onReconnect}>
              {t(
                account.health !== "not-set-up"
                  ? "apps.account.reconnect"
                  : !signsIn
                    ? "apps.account.finishSetup"
                    : account.signedInAt === undefined
                      ? "apps.account.signIn"
                      : "apps.account.reconnect",
              )}
            </RowAction>
          )}
          {onTest === undefined ? null : (
            <RowAction disabled={busy} onClick={onTest}>
              {t("apps.account.test")}
            </RowAction>
          )}
          {canDisconnect ? (
            <RowAction tone="danger" disabled={busy} onClick={onDisconnect}>
              {t("apps.disconnect.action")}
            </RowAction>
          ) : null}
        </span>
      )}
    </li>
  );
}

/** Where an account is used, as one sentence. */
function usageLine(account: AppAccountView): string {
  if (account.workspaces.length === 0) return translateNow(account.people ? "apps.account.usedByPeopleOnly" : "apps.account.notOffered");
  return translateNow(account.people ? "apps.account.usedInAndByPeople" : "apps.account.usedIn", {
    workspaces: account.workspaces.join(", "),
  });
}
