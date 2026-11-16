import { z } from "zod";

/**
 * Where an admission came from.
 *
 * Recorded at creation by the admitting caller so a later reader can tell who
 * owns a decision: a `schedule` round belongs to that fire's policy loop until
 * the fire ends, while every other origin's round is an operator's to answer.
 * `scheduleId` is present exactly when `origin` is `"schedule"`. A reminder
 * with a prompt starts its task as `reminder`.
 *
 * `web` is a run the owner received through `tavi ui`'s bridge; `ipc` is one
 * from any other attached client, such as `tavi chat`. The owner
 * decides between them from the connection, never from the payload.
 *
 * `heartbeat` is a heartbeat tick: unattended,
 * folderless and never listed as a chat. `ideas` is an idea's first step run
 * ahead of time: the same, with read-only tools only.
 */
export const TASK_ORIGINS = ["cli", "ipc", "messaging", "schedule", "agent", "reminder", "web", "heartbeat", "ideas"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];
export const TaskOriginSchema = z.enum(TASK_ORIGINS);

/**
 * The origins of plumbing, not chats: unattended, folderless, reading no
 * memory and capturing none, never listed, counted or shown as a day's work —
 * a heartbeat tick and an idea's prepared step.
 */
export const PLUMBING_ORIGINS: readonly TaskOrigin[] = ["heartbeat", "ideas"];
/** Whether `origin` is plumbing (`PLUMBING_ORIGINS`). */
export const isPlumbingOrigin = (origin: string | null | undefined): boolean =>
  origin !== null && origin !== undefined && (PLUMBING_ORIGINS as readonly string[]).includes(origin);
/** `PLUMBING_ORIGINS` as an SQL list: `origin IN (…)`, with a NULL origin read as `''` by the caller. */
export const PLUMBING_ORIGINS_SQL = PLUMBING_ORIGINS.map((origin) => `'${origin}'`).join(", ");

/**
 * The channel a turn is held to besides its task's origin: today only
 * `messaging`, for a turn sent from a messaging conversation and for every
 * worker such a turn spawned. A held channel only ever narrows what a turn may
 * do (`ruleAppliesToTurn`), so carrying one can never lift a rule.
 */
export const TURN_CHANNELS = ["messaging"] as const;
export type TurnChannel = (typeof TURN_CHANNELS)[number];
export const TurnChannelSchema = z.enum(TURN_CHANNELS);

/**
 * The front end an admission was typed in, on the owner's own local
 * connection: `web` through `tavi ui`'s bridge,
 * `ipc` from any other attached client. Set by the owner from the IPC
 * connection, never from a payload. A task's origin is fixed at its first
 * client, so a Home begun by `tavi chat` is `ipc` while its canvas turns are
 * `web`: rules apply to a turn as the narrower of the two
 * (`ruleAppliesToTurn`), so carrying one can never lift a rule.
 */
export const FRONT_ENDS = ["web", "ipc"] as const;
export type FrontEnd = (typeof FRONT_ENDS)[number];
export const FrontEndSchema = z.enum(FRONT_ENDS);

/**
 * Whether a task of this origin was started by a person attached to it now —
 * at a terminal (`cli`, `ipc`) or in the canvas (`web`). Such a task may ask
 * interactively and waits half an hour for an answer, not a day.
 */
export function isAttendedOrigin(origin: string | null | undefined): boolean {
  return origin === "cli" || origin === "ipc" || origin === "web";
}

/**
 * Whether an attached IPC client started the task (`ipc` or `web`): its
 * conversation is its start admission's operation key, where `reply` answers.
 */
export function isIpcOrigin(origin: string | null | undefined): boolean {
  return origin === "ipc" || origin === "web";
}

/**
 * Whether a rule scoped to `ruleOrigin` covers a task of `taskOrigin`.
 *
 * A rule scoped to `ipc` also covers `web`: before `web` existed every
 * canvas run was recorded as `ipc`, so a rule written then keeps applying to
 * the same runs.
 */
export function originCovers(ruleOrigin: TaskOrigin, taskOrigin: string | null | undefined): boolean {
  return ruleOrigin === taskOrigin || (ruleOrigin === "ipc" && taskOrigin === "web");
}

/**
 * A chat's memory mode, absent when
 * memory is on. `off`: the chat reads no memory, offers no `memory.*` or
 * `sessions.search` tool, and nothing is captured from it; anyone can turn it
 * back on. `private` is off for good, set only when the chat is created, and
 * adds: left out of past-chat search and *Earlier chats*, and its saved turns
 * forgotten 24 h after its last turn. A side chat takes its parent's mode when
 * it is created, and a worker follows the chat it works for.
 */
export const CHAT_MEMORY_MODES = ["off", "private"] as const;
export type ChatMemoryMode = (typeof CHAT_MEMORY_MODES)[number];
export const ChatMemoryModeSchema = z.enum(CHAT_MEMORY_MODES);
