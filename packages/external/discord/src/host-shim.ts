import type { TaviError as HostTaviError } from "@tavi/contracts";

/**
 * What the bundle takes from `@tavi/contracts` at run time: the
 * host's own `TaviError` class, set by `register(ctx)` from `ctx.TaviError`
 * before the connector is built, so `error instanceof TaviError` in the host
 * holds for what the bundle throws. Everything else the connector and the
 * channel kit read from the barrel is a type (the kit's URL helpers and the
 * repository URL come from the zod-free `@tavi/contracts/url-text`, the shared helpers
 * from `@tavi/contracts/util`). `tsdown.config.ts` aliases
 * `@tavi/contracts` here; type-checking and tests read the real package.
 */
// Unset until `register` runs, which is before anything here can throw: the bundle builds nothing at import.
export let TaviError: typeof HostTaviError;

export function useHostTaviError(value: typeof HostTaviError): void {
  TaviError = value;
}
