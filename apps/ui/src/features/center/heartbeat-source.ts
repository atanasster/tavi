import type { HeartbeatGetAnswer } from "@tavi/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { SettingsClient } from "../../lib/ipc.js";
import { useWorkspace } from "../shell/Workspace.js";
import { getHeartbeat } from "./heartbeat-api.js";

/** How often the heartbeat is read again while something shows it: its next check moves on its own. */
export const HEARTBEAT_POLL_MS = 30_000;

/** What the views showing the heartbeat draw from. */
interface Held {
  readonly data: HeartbeatGetAnswer | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
}

/**
 * One workspace's heartbeat, read once for every view that shows it (the
 * rail's pill, its row in Recurring): one read in flight at a time, one beat
 * at the shortest pace any view asks for, none while the page is hidden, and a
 * read as soon as it shows again.
 */
class Source {
  held: Held = { data: undefined, error: undefined, loading: false };
  private readonly listeners = new Set<() => void>();
  private readonly paces = new Map<symbol, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private again = false;

  private readonly client: SettingsClient;
  private readonly workspaceId: string;
  private readonly gone: () => void;

  constructor(client: SettingsClient, workspaceId: string, gone: () => void) {
    this.client = client;
    this.workspaceId = workspaceId;
    this.gone = gone;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): Held => this.held;

  /** A view starts showing it at `ms` a beat; the returned call is its leaving. */
  join(ms: number): () => void {
    const id = Symbol("view");
    if (this.paces.size === 0) document.addEventListener("visibilitychange", this.shown);
    this.paces.set(id, ms);
    this.arm();
    if (this.held.data === undefined && !this.reading) this.read();
    return () => {
      this.paces.delete(id);
      if (this.paces.size > 0) {
        this.arm();
        return;
      }
      clearInterval(this.timer);
      this.timer = undefined;
      document.removeEventListener("visibilitychange", this.shown);
      this.gone();
    };
  }

  readonly read = (): void => {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    this.set({ ...this.held, loading: true });
    void getHeartbeat(this.client, this.workspaceId).then((outcome) => {
      this.reading = false;
      this.set(
        outcome.ok
          ? { data: outcome.value, error: undefined, loading: false }
          : { data: this.held.data, error: outcome.message, loading: false },
      );
      if (!this.again) return;
      this.again = false;
      this.read();
    });
  };

  readonly replace = (value: HeartbeatGetAnswer): void => this.set({ data: value, error: undefined, loading: this.reading });

  private set(next: Held): void {
    this.held = next;
    for (const listener of this.listeners) listener();
  }

  private readonly beat = (): void => {
    if (!document.hidden) this.read();
  };

  private readonly shown = (): void => {
    if (!document.hidden) this.read();
  };

  private arm(): void {
    clearInterval(this.timer);
    const pace = Math.min(...this.paces.values());
    this.timer = Number.isFinite(pace) && pace > 0 ? setInterval(this.beat, pace) : undefined;
  }
}

const sources = new WeakMap<SettingsClient, Map<string, Source>>();

function sourceFor(client: SettingsClient, workspaceId: string): Source {
  let byWorkspace = sources.get(client);
  if (byWorkspace === undefined) {
    byWorkspace = new Map();
    sources.set(client, byWorkspace);
  }
  const known = byWorkspace.get(workspaceId);
  if (known !== undefined) return known;
  const made: Source = new Source(client, workspaceId, () => {
    if (byWorkspace?.get(workspaceId) === made) byWorkspace.delete(workspaceId);
  });
  byWorkspace.set(workspaceId, made);
  return made;
}

const NONE: Held = { data: undefined, error: undefined, loading: false };
const noSubscribe = (): (() => void) => () => undefined;
const noSnapshot = (): Held => NONE;

/**
 * The workspace's heartbeat as every view shows it, read again every
 * `refreshMs` (shared with the other views showing it: one read serves them
 * all), and at once when `revision` moves. Off (`enabled: false`), nothing is
 * read. `replace` puts a write's answer in place for every view.
 */
export function useSharedHeartbeat({
  enabled = true,
  refreshMs = HEARTBEAT_POLL_MS,
  revision = 0,
}: {
  readonly enabled?: boolean;
  readonly refreshMs?: number;
  readonly revision?: number;
} = {}): Held & { readonly reload: () => void; readonly replace: (value: HeartbeatGetAnswer) => void } {
  const { client, workspaceId } = useWorkspace();
  const source = enabled ? sourceFor(client, workspaceId) : undefined;
  const held = useSyncExternalStore(source?.subscribe ?? noSubscribe, source?.snapshot ?? noSnapshot);
  useEffect(() => source?.join(refreshMs), [source, refreshMs]);
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    source?.read();
  }, [source, revision]);
  return { ...held, reload: () => source?.read(), replace: (value) => source?.replace(value) };
}
