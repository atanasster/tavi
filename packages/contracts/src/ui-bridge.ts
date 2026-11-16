import { z } from "zod";

import { IPC_COMMANDS, type IpcCommand } from "./ipc.js";

/**
 * `tavi ui`'s bridge, as a page and the bridge both see it.
 *
 * The bridge is its own process: it serves the web canvas on a loopback port
 * and carries IPC frames between a page's WebSocket and the owner's socket,
 * over one IPC connection. A page speaks the IPC protocol itself — the same
 * frames, one per WebSocket text message — so `@tavi/client`'s handshake,
 * cursors, reconnect and reducers work unchanged over it; what differs is only
 * who the page authenticates to, and how it finds the owner:
 *
 * 1. The URL `tavi ui` opens carries a one-time token in its fragment. The
 *    page exchanges it (`POST UI_SESSION_PATH`) for a session cookie and a
 *    session secret; neither alone authenticates.
 * 2. `POST UI_OWNER_PATH` (cookie and secret) answers the owner the bridge is
 *    connected to now — its session, which a restart changes.
 * 3. The WebSocket at `UI_IPC_PATH` opens with the IPC `hello`, whose `token`
 *    is the session secret and whose `sessionId` is that owner's session; the
 *    bridge answers `ready` for the owner. Resuming (`since`) is the client's
 *    own: it resubscribes from its cursors, as over the socket. (A
 *    `{ hello, secret, since }` first message, carried by frames that already
 *    exist: the IPC `hello`, and each subscription's `subscribe` from its
 *    cursor.)
 */

/** The token exchange: a one-time token for a session. */
export const UI_SESSION_PATH = "/session";
/**
 * The owner the bridge reaches now. The bridge applies the same check here as
 * on the `UI_IPC_PATH` upgrade — exact `Host` and `Origin`, the session cookie
 * and its secret — so a page refused one is refused the other: a page cannot
 * read why an upgrade failed, and learns it from this answer (401) instead.
 */
export const UI_OWNER_PATH = "/api/owner";
/** The WebSocket carrying IPC frames. */
export const UI_IPC_PATH = "/ipc";
/** The header a state-changing HTTP request carries the session secret in. */
export const UI_SECRET_HEADER = "x-tavi-secret";
/** The session cookie's name. */
export const UI_SESSION_COOKIE = "tavi_ui";

/**
 * Why the bridge closed a tab's WebSocket, beyond the standard codes: for the
 * bridge's log and a page that wants to say why. `@tavi/client/browser` does
 * not branch on them — on any close it reconnects, asking the bridge which
 * owner serves now (`UI_OWNER_PATH`); that answer (401 for a session that
 * ended) is what says whether a new link is needed.
 */
export const UI_CLOSE = {
  /** A frame the bridge could not handle. */
  internal: 1011,
  /** The owner stopped or restarted. */
  ownerGone: 1012,
  /** The tab left more unread than its bound. */
  fallingBehind: 1013,
  /** No `hello` in time, or one without this session's secret. */
  unauthenticated: 4401,
  /** The session ended: expired, or forgotten for newer ones. */
  sessionExpired: 4403,
  /** The bridge holds as many tabs as it serves. */
  busy: 4429,
} as const;

/**
 * The commands a page may send: what a browser needs to run,
 * follow, decide and configure. `shutdown`, `recover` and `doctor` are refused
 * by the bridge itself — a page never stops the owner, repairs its tasks or
 * reads its full diagnostics (`models video-status` answers doctor's `video`
 * section alone, for Settings → Models). `reset-instance` is the one exception: the
 * owner stops to wipe its directory and starts again on it.
 */
export const UI_BRIDGE_COMMANDS = [
  "routines",
  "artifacts",
  "run",
  "subscribe",
  "unsubscribe",
  "approve",
  "review",
  "reply",
  "abort",
  "cancel",
  "tasks",
  "approvals",
  "agents",
  // With `video-status`: doctor's `video` section alone, for Settings → Models' Video analysers.
  "models",
  "credentials",
  "channels",
  "ui-preferences",
  "projects",
  "schedules",
  "search",
  "system-prompt",
  "plugins",
  // MCP servers' own section: the owner refuses from a page whatever weakens a server's
  // sandbox or turns MCP on; those stay `tavi mcp`'s.
  "mcp",
  // Connected apps: a façade over the sources' own commands, so the owner's
  // page refusals for `mcp` and `plugins` apply unchanged; a page never adds an allow rule.
  "apps",
  // Listing and revoking only: the owner refuses `add` from a page,
  // whose standing rules come from the approvals a person made on it.
  "permissions",
  "workspace-settings",
  // Read-only: the Command Center's summary and change feed.
  "center",
  // The operator's memory: listing, review and edits authored by the operator.
  "memory",
  // The operator's skills: listing, reading a version's body, review, activation and rollback.
  "skills",
  // Every person's reminders, and the operator's edits, snoozes and
  // acknowledgements.
  "reminders",
  // The operator's heartbeat: Center → Heartbeat and the rail's pill.
  "heartbeat",
  // The Ideas tab: reading, trying and steering the operator's ideas. The owner refuses
  // a page's switch of provider or digest, which send the person's words somewhere new.
  "ideas",
  // Setup's Welcome: status, the flow, detection in the owner's own environment,
  // a key typed or signed in, and verify. The owner refuses a page's `reset` and provider change.
  "onboarding",
  // Browser history as stored, scrubbed URLs only,
  // and the operator's Close browser.
  "browser",
  // A chat's own instructions, read and saved by the chat panel.
  "chat-context",
  // The live view of the agent's browser: a
  // watch is a subscription the bridge routes to its tab, and a tab may ack or
  // unwatch only its own.
  "browser-live",
  // Settings → General's Reset instance: a typed confirmation, then the
  // owner stops, deletes its state and starts again.
  "reset-instance",
  // Plugins' slash commands: listed and run from the chat's composer.
  "plugin-commands",
  // A chat's working folder: the header's
  // chip and its panel — show, list, download, detach, reset — and attaching a
  // folder the picker offered. A page never names a host path: the
  // owner refuses `set`/`attach` with a `path` from the bridge, and redeems
  // only the picker tokens it issued on the bridge's own connection.
  "folder",
  // The attach picker over the `--fs-root` folders: directories only, each
  // with an owner-issued token in place of a path the page could send.
  "browse",
] as const satisfies readonly IpcCommand[];
export type UiBridgeCommand = (typeof UI_BRIDGE_COMMANDS)[number];

/** Whether a page may send `command` through the bridge. */
export function isUiBridgeCommand(command: string): command is UiBridgeCommand {
  return (UI_BRIDGE_COMMANDS as readonly string[]).includes(command);
}

/** The commands the bridge refuses: every IPC command the allowlist leaves out. */
export const UI_BRIDGE_REFUSED: readonly IpcCommand[] = IPC_COMMANDS.filter((command) => !isUiBridgeCommand(command));

/** `POST UI_SESSION_PATH`'s body. */
export const UiSessionRequestSchema = z.object({ token: z.string().min(1).max(128) });
export type UiSessionRequest = z.infer<typeof UiSessionRequestSchema>;

/** `POST UI_SESSION_PATH`'s answer: the secret, beside the cookie the response sets. */
export const UiSessionAnswerSchema = z.object({ secret: z.string().min(1).max(128) });
export type UiSessionAnswer = z.infer<typeof UiSessionAnswerSchema>;

/** `POST UI_OWNER_PATH`'s answer: the owner the WebSocket's `hello` names. */
export const UiOwnerAnswerSchema = z.object({
  sessionId: z.string().min(1).max(128),
  protocolVersion: z.number().int().positive(),
});
export type UiOwnerAnswer = z.infer<typeof UiOwnerAnswerSchema>;
