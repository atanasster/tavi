/**
 * Coordinated revocation. Google
 * revokes a grant for every client of its Cloud project, so disconnecting one
 * Google app revokes upstream only when no other app holds a grant for the
 * same project and the same account; otherwise its token is deleted here,
 * and the other apps keep working.
 */

import type { ConnectableApp } from "@tavi/contracts";

/** One app's sign-in, as revocation weighs it. */
export interface ProviderGrant {
  readonly appName: string;
  readonly accountId: string;
  /** The account it signed in as; unknown is taken as any account (the safe side). */
  readonly identity?: string;
  readonly clientId?: string;
}

/**
 * A client id's project, by its provider's declared `clientProjectPattern` (the first group). An id that does not
 * match, or a provider that declares none, is taken as the same project as any other (the safe side).
 */
export function projectOf(clientId: string | undefined, pattern: string | undefined): string | undefined {
  if (clientId === undefined || pattern === undefined) return undefined;
  try {
    return new RegExp(pattern).exec(clientId)?.[1];
  } catch {
    return undefined;
  }
}

const sameProject = (a: string | undefined, b: string | undefined, pattern: string | undefined): boolean => {
  const left = projectOf(a, pattern);
  const right = projectOf(b, pattern);
  return left === undefined || right === undefined || left === right;
};

const sameAccount = (a: string | undefined, b: string | undefined): boolean =>
  a === undefined || b === undefined || a.toLowerCase() === b.toLowerCase();

/** The other apps whose sign-in a revoke of `grant` would end too: an upstream revoke waits until they are gone. */
export function keptBy(grant: ProviderGrant, others: readonly ProviderGrant[], projectPattern?: string): readonly string[] {
  return [
    ...new Set(
      others
        .filter(
          (other) =>
            other.accountId !== grant.accountId &&
            sameProject(grant.clientId, other.clientId, projectPattern) &&
            sameAccount(grant.identity, other.identity),
        )
        .map((other) => other.appName),
    ),
  ];
}

/** What a disconnect left when other apps keep the grant, as `tavi apps disconnect` and `tavi channels disconnect` say it. */
export function keptByNote(keptBy: readonly string[]): string {
  return keptBy.length === 0
    ? ""
    : `: its sign-in forgotten here; ${keptBy.join(" and ")} stays connected, so the provider still lists Tavi until you disconnect ${keptBy.length > 1 ? "them" : "it"} too`;
}

/** Each account's `keptBy`, by account id, as the apps' projection worked it out: what Settings → Channels weighs a disconnect by. */
export function keptByAccount(apps: readonly ConnectableApp[]): ReadonlyMap<string, readonly string[]> {
  return new Map(
    apps.flatMap((app) =>
      app.accounts.flatMap((account) => ((account.keptBy ?? []).length === 0 ? [] : [[account.accountId, account.keptBy ?? []] as const])),
    ),
  );
}
