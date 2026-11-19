import type { AppAccountView, AppMailboxAccess, AppSharing } from "@tavi/contracts";

import { AppLink } from "../shell/AppLink.js";
import { localDayWithYear } from "../../lib/time.js";
import { settingsPath } from "../shell/route.js";
import { useTimeZone } from "../shell/Workspace.js";
import { HEALTH_BADGE, signInByWords } from "./model.js";
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
  const timeZone = useTimeZone();
  const badge = HEALTH_BADGE[account.health];
  const name = account.identity ?? account.label;
  const sharingName = `${account.accountId}-sharing`;
  return (
    <li className="row apps-account">
      <span className="apps-account-info">
        <span className="apps-title-line cluster">
          <strong>{name}</strong>
          <span className={`badge badge-${badge.tone}`}>{badge.text}</span>
        </span>
        <span className="meta-sm">
          {/* An app set up with keys (a Telegram bot token) has no sign-in to report; one that keeps no sign-in time (a
              Google account) is signed in unless its health says it is not set up. */}
          {account.signedInAt !== undefined
            ? `Signed in ${localDayWithYear(account.signedInAt, timeZone)}.`
            : signsIn && account.health === "not-set-up"
              ? "Not signed in yet."
              : ""}
          {account.nextSignInBy === undefined ? "" : ` ${signInByWords(account.nextSignInBy, timeZone)}.`}
          {account.missingScopes.length > 0 ? " Some of the access it asks for was not allowed." : ""}
        </span>
        <span className="meta-sm">{usageLine(account)}</span>
        {account.keptBy === undefined || account.keptBy.length === 0 ? null : (
          <span className="meta-sm">{`The same sign-in also connects ${account.keptBy.join(" and ")}.`}</span>
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
            {account.health === "ready" ? "Open in Channels" : `Reconnect ${appName} in Channels`}
          </AppLink>
        </span>
      ) : (
        <span className="actions">
          <fieldset className="apps-sharing">
            <legend className="visually-hidden">{`Who may use ${name}`}</legend>
            <label>
              <input
                type="radio"
                name={sharingName}
                checked={account.sharing === "personal"}
                disabled={busy}
                onChange={() => onSharing("personal")}
              />{" "}
              Personal
            </label>
            <label>
              <input
                type="radio"
                name={sharingName}
                checked={account.sharing === "shared"}
                disabled={busy}
                onChange={() => onSharing("shared")}
              />{" "}
              Shared
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
                Let the agent read and draft in this mailbox
              </label>
              <label className="apps-check">
                <input
                  type="checkbox"
                  checked={account.mailbox === "send"}
                  disabled={busy || account.mailbox === "off"}
                  onChange={(event) => onMailbox(event.target.checked ? "send" : "read")}
                />{" "}
                Send drafts I approve (each one asks, showing it whole)
              </label>
            </>
          )}
          {account.receives === undefined || onReceive === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={account.receives} disabled={busy} onChange={(event) => onReceive(event.target.checked)} />{" "}
              Reach Tavi through this account
            </label>
          )}
          {account.calendar === undefined || onCalendar === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={account.calendar} disabled={busy} onChange={(event) => onCalendar(event.target.checked)} />{" "}
              Let the agent use this calendar (each event it adds or changes asks first)
            </label>
          )}
          {onPeople === undefined ? null : (
            <label className="apps-check">
              <input type="checkbox" checked={account.people} disabled={busy} onChange={(event) => onPeople(event.target.checked)} /> People
              you allowed may use it
            </label>
          )}
          {onReconnect === undefined ? null : (
            <RowAction disabled={busy} onClick={onReconnect}>
              {account.health !== "not-set-up"
                ? "Reconnect"
                : !signsIn
                  ? "Finish setting up"
                  : account.signedInAt === undefined
                    ? "Sign in"
                    : "Reconnect"}
            </RowAction>
          )}
          {onTest === undefined ? null : (
            <RowAction disabled={busy} onClick={onTest}>
              Test
            </RowAction>
          )}
          {canDisconnect ? (
            <RowAction tone="danger" disabled={busy} onClick={onDisconnect}>
              Disconnect
            </RowAction>
          ) : null}
        </span>
      )}
    </li>
  );
}

/** Where an account is used, as one sentence. */
function usageLine(account: AppAccountView): string {
  const people = account.people ? "by people you allowed" : undefined;
  if (account.workspaces.length === 0)
    return people === undefined ? "Not offered in any workspace yet." : `Not in your own chats yet; used ${people}.`;
  return `Used in your chats in ${account.workspaces.join(", ")}${people === undefined ? "" : `, and ${people}`}.`;
}
