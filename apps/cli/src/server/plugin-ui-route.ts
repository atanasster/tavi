import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

import {
  PLUGIN_ID_PATTERN,
  PLUGIN_UI_PATH_PREFIX,
  PluginContentHashSchema,
  type PluginAppIconsEntry,
  type PluginUiEntry,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { readPluginSnapshot } from "@tavi/runtime";

/**
 * `GET /plugin-ui/<plugin-id>/<content-hash>/<path>`: a UI plugin's approved files, served for a sandboxed,
 * opaque-origin iframe.
 *
 * - **What is served.** An external plugin's files come from its installed
 *   snapshot (`<data-dir>/plugins/<id>/<version>`), a built-in's from the
 *   canvas build (`<canvas>/plugins/<id>`). Before the first use they are
 *   read once and hashed, the way the owner checks a snapshot before
 *   importing it, and the servable ones kept by that hash — the bytes served
 *   are the bytes hashed. A snapshot that no longer matches is refused.
 * - **Revocation.** Each document request asks the owner whether that plugin
 *   at that hash is still enabled and approved, so a disabled or rejected one
 *   is refused from the next load, and every cached copy of it is dropped. A
 *   served document drops the plugin's other hashes (older versions).
 *   Subresources come from the cache a document load filled; one asked
 *   for before any (the canvas's tab icon, say) asks the owner the same way.
 * - **App icons.** A plugin with no UI may still name icons in its `apps`
 *   block: only those files, asked of
 *   the owner for every load as a document is, and only as images.
 * - **Request checks for an opaque origin.** A sandboxed document's own
 *   requests are cross-site with `Origin: null`, so the canvas's same-origin
 *   rule cannot apply. A document must be an iframe the canvas embeds
 *   (`Sec-Fetch-Dest: iframe`, `Sec-Fetch-Site: same-origin`); a subresource
 *   a script, style, image or font, from the canvas (`same-origin`: an icon)
 *   or from the sandboxed document (`cross-site`, no `Origin` or `null`). A
 *   request without these headers is refused. No cookie is needed: the bytes
 *   are approved, non-secret code, and the bridge listens on loopback only.
 * - **Headers.** `Cross-Origin-Resource-Policy: cross-origin` (the canvas's
 *   `same-origin` would block the document's own scripts), no
 *   `X-Frame-Options` (`frame-ancestors` governs framing), CORS `null` on
 *   every subresource (module scripts, fonts and JSON are CORS fetches from
 *   the opaque origin), and on documents a CSP naming
 *   this plugin's own path as the only source, no network (`connect-src
 *   'none'`) and `sandbox allow-scripts` again in case a page is opened
 *   outside its iframe.
 */

/** The only file types served; anything else under a plugin is a 404. */
const PLUGIN_UI_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/** `Sec-Fetch-Dest` values a subresource may carry. */
const SUBRESOURCE_DESTINATIONS = new Set(["script", "style", "image", "font", "json"]);

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface PluginUiRouteOptions {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly dataDirectory: string;
  /** The canvas build, where built-ins' UI files are (`plugins/<id>`). */
  readonly staticDirectory?: string;
  /**
   * The owner's answer for one plugin at one hash, in one request: its UI
   * `entry` while it is enabled and approved, and the app `icons` its
   * approved `apps` block names;
   * neither when it is not (or no owner answers).
   */
  readonly lookup: (pluginId: string, contentHash: string) => Promise<PluginUiLookup>;
  readonly log?: (line: string) => void;
}

interface PluginUiLookup {
  readonly entry?: PluginUiEntry | undefined;
  readonly icons?: PluginAppIconsEntry | undefined;
}

export interface PluginUiRoute {
  /** Answers a `/plugin-ui/` request; `false` for any other path. */
  handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean>;
  /** What the canvas's own CSP adds so it may frame these documents. */
  readonly frameSource: string;
}

/** A parsed `/plugin-ui/` path, or `undefined` for one that is not well formed. */
export function parsePluginUiPath(
  path: string,
): { readonly pluginId: string; readonly contentHash: string; readonly file: string } | undefined {
  if (!path.startsWith(PLUGIN_UI_PATH_PREFIX)) return undefined;
  const [pluginId, contentHash, ...segments] = path.slice(PLUGIN_UI_PATH_PREFIX.length).split("/");
  if (pluginId === undefined || !PLUGIN_ID_PATTERN.test(pluginId) || pluginId.length > 64) return undefined;
  if (contentHash === undefined || !PluginContentHashSchema.safeParse(contentHash).success) return undefined;
  if (segments.length === 0 || segments.length > 8) return undefined;
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) return undefined;
  const file = segments.join("/");
  if (PLUGIN_UI_TYPES[extname(file).toLowerCase()] === undefined) return undefined;
  return { pluginId, contentHash, file };
}

export function createPluginUiRoute(options: PluginUiRouteOptions): PluginUiRoute {
  const log = options.log ?? (() => undefined);
  /** `<id>/<hash>` → the plugin's files by relative path, verified against that hash. */
  const cache = new Map<string, ReadonlyMap<string, Buffer>>();

  /** `<id>/<hash>` → an app-icons-only plugin's named icons, verified against that hash. */
  const iconCache = new Map<string, ReadonlyMap<string, Buffer>>();

  /** Drops every cached copy of `pluginId` but the one at `keep`. */
  function forget(pluginId: string, keep?: string): void {
    for (const key of [...cache.keys()]) if (key.startsWith(`${pluginId}/`) && key !== keep) cache.delete(key);
  }

  /** The plugin's servable files, read and hashed once before the first use; `undefined` when they do not match. */
  function filesOf(entry: PluginUiEntry): ReadonlyMap<string, Buffer> | undefined {
    const key = `${entry.pluginId}/${entry.contentHash}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const root =
      entry.kind === "external"
        ? entry.version === undefined
          ? undefined
          : join(options.dataDirectory, "plugins", entry.pluginId, entry.version)
        : options.staticDirectory === undefined
          ? undefined
          : join(options.staticDirectory, "plugins", entry.pluginId);
    const snapshot = snapshotOf(entry, root);
    if (snapshot === undefined) return undefined;
    // Only what could ever be served is kept: not the entry module, nor the manifest.
    const files = new Map([...snapshot.files].filter(([path]) => PLUGIN_UI_TYPES[extname(path).toLowerCase()] !== undefined));
    cache.set(key, files);
    return files;
  }

  /** An app-icons-only plugin's named icons and nothing else of it, read and hashed once. */
  function iconsOf(entry: PluginAppIconsEntry): ReadonlyMap<string, Buffer> | undefined {
    const key = `${entry.pluginId}/${entry.contentHash}`;
    const cached = iconCache.get(key);
    if (cached !== undefined) return cached;
    const snapshot = snapshotOf(entry, join(options.dataDirectory, "plugins", entry.pluginId, entry.version));
    if (snapshot === undefined) return undefined;
    for (const other of [...iconCache.keys()]) if (other.startsWith(`${entry.pluginId}/`)) iconCache.delete(other);
    const files = new Map([...snapshot.files].filter(([path]) => entry.paths.includes(path)));
    iconCache.set(key, files);
    return files;
  }

  function snapshotOf(
    entry: { readonly pluginId: string; readonly contentHash: string },
    root: string | undefined,
  ): ReturnType<typeof readPluginSnapshot> | undefined {
    if (root === undefined || !existsSync(root)) return undefined;
    let snapshot: ReturnType<typeof readPluginSnapshot>;
    try {
      snapshot = readPluginSnapshot(root);
    } catch (error) {
      log(`ui: plugin ${entry.pluginId}'s files could not be read: ${errorMessage(error)}`);
      return undefined;
    }
    if (snapshot.hash !== entry.contentHash) {
      log(`ui: plugin ${entry.pluginId}'s files no longer match their approved hash; they are not served`);
      return undefined;
    }
    return snapshot;
  }

  function refuse(response: ServerResponse, status: number): void {
    response.writeHead(status, { ...commonHeaders(), "content-type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "not found" : "refused");
  }

  return {
    frameSource: `${options.origin}${PLUGIN_UI_PATH_PREFIX}`,

    async handle(request, response, path) {
      if (!path.startsWith(PLUGIN_UI_PATH_PREFIX)) return false;
      if (request.method !== "GET") {
        refuse(response, 405);
        return true;
      }
      const parsed = parsePluginUiPath(path);
      if (parsed === undefined) {
        refuse(response, 404);
        return true;
      }
      const dest = request.headers["sec-fetch-dest"];
      const site = request.headers["sec-fetch-site"];
      const requestOrigin = request.headers.origin;
      const document = extname(parsed.file).toLowerCase() === ".html";
      const allowed = document
        ? dest === "iframe" && site === "same-origin"
        : typeof dest === "string" &&
          SUBRESOURCE_DESTINATIONS.has(dest) &&
          (site === "same-origin" || (site === "cross-site" && (requestOrigin === undefined || requestOrigin === "null")));
      if (!allowed) {
        refuse(response, 403);
        return true;
      }
      const key = `${parsed.pluginId}/${parsed.contentHash}`;
      let files: ReadonlyMap<string, Buffer> | undefined;
      const ask = async (): Promise<PluginUiLookup> => await options.lookup(parsed.pluginId, parsed.contentHash).catch(() => ({}));
      let asked: PluginUiLookup | undefined;
      if (document) {
        // Asked again for every document: rejection is revocation.
        const { entry } = await ask();
        if (entry === undefined) {
          forget(parsed.pluginId);
          refuse(response, 404);
          return true;
        }
        forget(parsed.pluginId, key);
        files = filesOf(entry);
      } else {
        // An icon the canvas shows before any of the plugin's documents loaded
        // (or after the bridge restarted) is not cached yet: ask, as a document does.
        files = cache.get(key);
        if (files === undefined) {
          asked = await ask();
          if (asked.entry !== undefined) files = filesOf(asked.entry);
        }
      }
      let body = files?.get(parsed.file);
      if (body === undefined && !document && dest === "image") {
        // An app's icon from a plugin with no UI: asked for every load, so a disabled or rejected one stops at once.
        const { icons } = asked ?? (await ask());
        if (icons === undefined) iconCache.delete(key);
        else if (icons.paths.includes(parsed.file)) body = iconsOf(icons)?.get(parsed.file);
      }
      if (body === undefined) {
        refuse(response, 404);
        return true;
      }
      const prefix = `${options.origin}${PLUGIN_UI_PATH_PREFIX}${parsed.pluginId}/${parsed.contentHash}/`;
      const type = PLUGIN_UI_TYPES[extname(parsed.file).toLowerCase()] ?? "application/octet-stream";
      response.writeHead(200, {
        ...commonHeaders(),
        "content-type": type,
        "content-length": String(body.byteLength),
        ...(document ? {} : { "access-control-allow-origin": "null" }),
        ...(document
          ? {
              "content-security-policy": [
                "default-src 'none'",
                `script-src ${prefix}`,
                `style-src ${prefix}`,
                `img-src data: ${prefix}`,
                `font-src ${prefix}`,
                "connect-src 'none'",
                "form-action 'none'",
                "base-uri 'none'",
                `frame-ancestors ${options.origin}`,
                "sandbox allow-scripts",
              ].join("; "),
            }
          : {}),
      });
      response.end(body);
      return true;
    },
  };
}

function commonHeaders(): Record<string, string> {
  return {
    "cross-origin-resource-policy": "cross-origin",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
}
