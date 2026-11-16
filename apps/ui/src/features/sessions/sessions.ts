import {
  SessionPreferencesSchema,
  TASK_ORIGINS,
  TASK_SESSION_STATUSES,
  type SessionPreferences,
  type TaskListFilters,
  type TaskListRow,
  type UiPreferencesResult,
} from "@tavi/contracts";

import { localDate } from "../../lib/time.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { readStoredJson, writeStoredJson } from "../../lib/storage.js";

const SESSIONS_KEY = "tavi.sessions";
/** Keyword search with explicit, validated status/origin prefixes. */
export function sessionFilters(search: string): TaskListFilters {
  const words: string[] = [];
  const status: NonNullable<TaskListFilters["status"]> = [];
  const origin: NonNullable<TaskListFilters["origin"]> = [];
  for (const token of search.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("status:")) {
      const value = token.slice(7);
      if (!(TASK_SESSION_STATUSES as readonly string[]).includes(value)) throw new Error(`Unknown status: ${value}`);
      status.push(value as (typeof status)[number]);
    } else if (token.startsWith("origin:")) {
      const value = token.slice(7);
      if (!(TASK_ORIGINS as readonly string[]).includes(value)) throw new Error(`Unknown origin: ${value}`);
      origin.push(value as (typeof origin)[number]);
    } else words.push(token);
  }
  return {
    ...(words.length ? { query: words.join(" ") } : {}),
    ...(status.length ? { status: [...new Set(status)] } : {}),
    ...(origin.length ? { origin: [...new Set(origin)] } : {}),
  };
}
export type { SessionPreferences } from "@tavi/contracts";
/**
 * The panel's pins, archive and seen marks live with the owner (`ui-preferences`):
 * `tavi ui` serves on a new port each start and a browser's storage is per
 * origin, port included, so a copy kept here only bridges the moment before
 * the owner answers — or a page whose owner cannot.
 */
export function loadSessionPreferences(storage?: Pick<Storage, "getItem">): SessionPreferences {
  // Kept entry by entry: one unreadable pin drops itself, not the reader's others.
  const value = readStoredJson(SESSIONS_KEY, storage) as Partial<SessionPreferences> | null | undefined;
  try {
    return {
      pins: (value?.pins ?? []).filter((id) => typeof id === "string"),
      archived: (value?.archived ?? []).filter((id) => typeof id === "string"),
      seen: Object.fromEntries(Object.entries(value?.seen ?? {}).filter(([, at]) => typeof at === "string")),
    };
  } catch {
    return { pins: [], archived: [], seen: {} };
  }
}
/** The session remains usable with storage disabled. */
export function saveSessionPreferences(value: SessionPreferences, storage?: Pick<Storage, "setItem">): void {
  writeStoredJson(SESSIONS_KEY, value, storage);
}
/** The owner's copy, or `undefined` when it cannot answer: the local copy stands in. */
export async function fetchSessionPreferences(client: SettingsClient, workspaceId: string): Promise<SessionPreferences | undefined> {
  try {
    const answer = await client.request("ui-preferences", { action: "get", workspaceId });
    if (!answer.ok) return undefined;
    const value = (answer.result as UiPreferencesResult | undefined)?.preferences;
    return value === undefined ? undefined : SessionPreferencesSchema.parse(value);
  } catch {
    return undefined;
  }
}
export async function storeSessionPreferences(
  client: SettingsClient,
  workspaceId: string,
  preferences: SessionPreferences,
): Promise<boolean> {
  try {
    return (await client.request("ui-preferences", { action: "set", workspaceId, preferences })).ok;
  } catch {
    return false;
  }
}
/**
 * The sidebar group a session falls in. A finished one is grouped by the day
 * it was last touched in the workspace zone (`timeZone`, the Center's), so the
 * sidebar and the Center agree on what a day is; without one, the browser's. A
 * chat the person stopped has its own heading on that day: a reply goes on, so
 * it is not done.
 */
export function directoryGroup(row: TaskListRow, timeZone: string | undefined): string {
  if (row.needs.length) return "Needs you";
  if (["submitted", "working", "unknown", "input-required"].includes(row.status)) return "Working";
  return `${row.status === "stopped" ? "Stopped" : "Completed"} · ${localDate(row.updatedAt, timeZone)}`;
}

/** A sidebar section: its heading, and its chats in order. */
export interface DirectorySection {
  /** `pinned`: the reader's Home with `chat.home` off, an ordinary chat pinned on top under no heading. */
  readonly kind: "home" | "pinned" | "conversations" | "status" | "activity";
  readonly label: string;
  readonly rows: readonly TaskListRow[];
}

/** A finished group's day: what follows the ` · ` of its heading. */
const dayOf = (label: string): string => label.slice(label.indexOf(" · "));

/** The order a fleet is read in: what needs me, what is going, then each day newest first, its stopped chats before its completed. */
function bySection(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "Needs you" || b === "Needs you") return a === "Needs you" ? -1 : 1;
  if (a === "Working" || b === "Working") return a === "Working" ? -1 : 1;
  return dayOf(b).localeCompare(dayOf(a)) || b.localeCompare(a);
}

/**
 * How the sidebar lays `rows` out. A worker is never a chat, so never listed.
 * With `chat.home` on: `principal`'s Home pinned on top (any
 * other Home is an ordinary chat), a side chat beneath the chat it was opened
 * from (`sides`, by parent) when that chat is listed — unless it needs the
 * reader, when it stays under Needs you — and runs (a schedule's, a
 * routine's, `tavi run`) under Activity at the end. A channel conversation's
 * Home (`conversationHome`) is listed under Conversations after Home,
 * unless it needs the reader, when it stays under Needs you; its forum
 * topics' side chats sit beneath it. A run that needs the reader is listed
 * under Needs you, not Activity. Off, every chat is grouped by what it needs,
 * as before, except `principal`'s Home: an ordinary chat pinned on top under
 * no heading, so it is not lost among the days.
 */
export function directoryLayout(
  rows: readonly TaskListRow[],
  homeChat: boolean,
  timeZone: string | undefined,
  principal?: string,
): { readonly sections: readonly DirectorySection[]; readonly sides: ReadonlyMap<string, readonly TaskListRow[]> } {
  const listed = rows.filter((row) => row.chatKind !== "worker");
  const byId = new Map(listed.map((row) => [row.taskId, row]));
  const sides = new Map<string, TaskListRow[]>();
  const nested = new Set<string>();
  if (homeChat) {
    for (const row of listed) {
      if (row.parentChatId === undefined || !byId.has(row.parentChatId) || directoryGroup(row, timeZone) === "Needs you") continue;
      // A chain that loops back on itself is listed flat rather than nowhere.
      const seen = new Set([row.taskId]);
      let parent: string | undefined = row.parentChatId;
      while (parent !== undefined && byId.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        parent = byId.get(parent)?.parentChatId;
      }
      if (parent !== undefined && seen.has(parent)) continue;
      nested.add(row.taskId);
      sides.set(row.parentChatId, [...(sides.get(row.parentChatId) ?? []), row]);
    }
  }
  const top = listed.filter((row) => !nested.has(row.taskId));
  const mine = (row: TaskListRow): boolean =>
    row.chatKind === "home" && (principal === undefined || row.principalId === undefined || row.principalId === principal);
  const home = principal === undefined && !homeChat ? [] : top.filter(mine);
  const needsYou = (row: TaskListRow): boolean => directoryGroup(row, timeZone) === "Needs you";
  const run = (row: TaskListRow): boolean => row.chatKind === "run" && !needsYou(row);
  const runs = homeChat ? top.filter(run) : [];
  const conversation = (row: TaskListRow): boolean => row.conversationHome !== undefined && !needsYou(row);
  const conversations = homeChat ? top.filter((row) => !mine(row) && conversation(row)) : [];
  const chats = homeChat ? top.filter((row) => !mine(row) && !run(row) && !conversation(row)) : top.filter((row) => !home.includes(row));
  const labels = [...new Set(chats.map((row) => directoryGroup(row, timeZone)))].sort(bySection);
  return {
    sections: [
      ...(home.length === 0
        ? []
        : [homeChat ? { kind: "home" as const, label: "Home", rows: home } : { kind: "pinned" as const, label: "Pinned", rows: home }]),
      ...(conversations.length === 0 ? [] : [{ kind: "conversations" as const, label: "Conversations", rows: conversations }]),
      ...labels.map((label) => ({ kind: "status" as const, label, rows: chats.filter((row) => directoryGroup(row, timeZone) === label) })),
      ...(runs.length === 0 ? [] : [{ kind: "activity" as const, label: "Activity", rows: runs }]),
    ],
    sides,
  };
}
