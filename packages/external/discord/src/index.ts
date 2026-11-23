import type { ExternalPluginContext } from "@tavi/plugin-types";

import { createDiscordConnectorDefinition } from "./connector.js";
import { useHostTaviError } from "./host-shim.js";

/**
 * `discord.channel`: Discord
 * as an external group channel. The host's own `TaviError` is taken first, so
 * every refusal the bundle throws is one the host recognises; the
 * connector is built on the host's services (`ctx.channelHost`, channel ABI 2)
 * and its `z`, so the bundle carries no schema library.
 */

export const VERSION = "0.1.3";

/**
 * The workspace's language (`ctx.locale`): read on each answer, so a language changed while it runs
 * is followed. An older host's context has none, and the answers are English.
 */
function localeOf(ctx: ExternalPluginContext): () => string | undefined {
  return () => ctx.locale;
}

export function register(ctx: ExternalPluginContext): void {
  useHostTaviError(ctx.TaviError);
  ctx.registerChannel(
    createDiscordConnectorDefinition({
      z: ctx.z,
      version: VERSION,
      locale: localeOf(ctx),
      // Its own messages (`locales/<lang>.json`); an older host's context has no `t`, and the words stay English.
      ...(typeof ctx.t === "function"
        ? { t: (key: string, params?: Readonly<Record<string, string | number>>) => ctx.t(key, params) }
        : {}),
      ...(ctx.channelHost === undefined
        ? {}
        : { now: ctx.channelHost.now, fetch: ctx.channelHost.fetch, readArtifact: ctx.channelHost.readArtifact }),
    }),
  );
}
