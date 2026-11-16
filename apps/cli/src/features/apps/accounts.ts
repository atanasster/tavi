import { TaviError, type ConnectableApp } from "@tavi/contracts";

/**
 * An app's account asked for by an id it does not have: refused with the ids it has, each beside the address or name
 * the canvas shows for it, so a person who gave the address finds the id to give instead.
 */
export function noSuchAccount(app: Pick<ConnectableApp, "name" | "accounts">, accountId: string): TaviError {
  const ids = app.accounts.map((account) =>
    account.identity === undefined || account.identity === account.accountId
      ? account.accountId
      : `${account.accountId} (${account.identity})`,
  );
  return new TaviError(
    "NOT_FOUND",
    ids.length === 0
      ? `${app.name} has no account ${accountId}, nor any yet`
      : `${app.name} has no account ${accountId}: its accounts are ${ids.join(", ")}`.slice(0, 500),
  );
}
