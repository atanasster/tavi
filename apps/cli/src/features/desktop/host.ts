import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TaviError,
  refusedEarly,
  defaultDesktopAppGrantTier,
  type DesktopAppGrantTier,
  type DesktopPort,
  type GatedDesktopPort,
} from "@tavi/contracts";
import { SwiftDesktopBridge, createGatedDesktopPort } from "@tavi/plugin-desktop";

/** The bridge to the helper at `desktopHelperPath`; `onAbort` runs when the person presses the abort hotkey. */
export function createOwnerDesktopBridge(dataDirectory: string, onAbort: () => void): SwiftDesktopBridge {
  // A helper missing when the bridge starts is built as the tools say: one instruction, valid for a release install.
  return new SwiftDesktopBridge({
    helperPath: desktopHelperPath(dataDirectory),
    onAbort,
    helperMissing: () => desktopHelperMissing(dataDirectory),
  });
}

/** Where `desktopHelperBuild` puts the helper: the data directory's, so a release install needs no write to its own files. */
export function desktopHelperPath(dataDirectory: string): string {
  return join(dataDirectory, "desktop", "tavi-desktop-helper");
}

/** The helper's Swift source as the plugin ships it. */
function desktopHelperSource(): string {
  return fileURLToPath(new URL("../native/helper.swift", import.meta.resolve("@tavi/plugin-desktop")));
}

/**
 * The commands that build the helper for this install: it ships as Swift
 * source and is compiled on the Mac it runs on, then signed ad hoc. Tavi never
 * runs them itself: the person does, once, from a terminal (the one the
 * Accessibility and Screen Recording permissions are granted to).
 */
export function desktopHelperBuild(dataDirectory: string): readonly string[] {
  const helper = shellQuoted(desktopHelperPath(dataDirectory));
  return [
    `mkdir -p ${shellQuoted(join(dataDirectory, "desktop"))}`,
    `swiftc -O ${shellQuoted(desktopHelperSource())} -o ${helper}`,
    `codesign -s - --force ${helper}`,
  ];
}

/** A path as a POSIX shell reads it literally, whatever it holds (`$`, a backtick, a quote). */
function shellQuoted(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Refuses when the helper is not built (or cannot be run), saying how to build it. */
export function requireDesktopHelper(dataDirectory: string): string {
  const helper = desktopHelperPath(dataDirectory);
  try {
    accessSync(helper, constants.X_OK);
    return helper;
  } catch {
    // Missing or not executable: either way it is built again.
  }
  throw refusedEarly("NOT_CONFIGURED", desktopHelperMissing(dataDirectory));
}

/** What to do when the helper is not built: the commands that build it for this install. */
export function desktopHelperMissing(dataDirectory: string): string {
  return (
    `desktop control's helper is not built: run, in the terminal you grant Accessibility and Screen Recording to,\n  ${desktopHelperBuild(dataDirectory).join("\n  ")}\n` +
    "If swiftc stops at \"redefinition of module 'SwiftBridging'\" (the Swift 6.1 Command Line Tools ship it twice), " +
    "docs/DESKTOP.md#build-the-helper-with-the-command-line-tools gives the overlay that builds it."
  );
}

/**
 * The grant tier of `app` under a workspace's `desktop.grantedApps`: the
 * built-in tier of an app the list names by bundle id or name (any case),
 * none for any other.
 */
export function grantedTierOf(
  granted: readonly string[],
  app: { readonly bundleId: string; readonly name: string },
): DesktopAppGrantTier | undefined {
  const names = new Set(granted.map((entry) => entry.trim().toLowerCase()));
  const named = names.has(app.bundleId.trim().toLowerCase()) || (app.name.trim() !== "" && names.has(app.name.trim().toLowerCase()));
  return named ? defaultDesktopAppGrantTier(app.bundleId, app.name) : undefined;
}

/** What each run the abort hotkey stopped is told, in its chat (QA 1906). */
export const DESKTOP_STOPPED_NOTICE = "Desktop control stopped for this run";

/** The most runs a workspace remembers for the abort hotkey: the ones it saw last. */
const REMEMBERED_RUNS = 32;

/**
 * One gate per workspace over one helper: each workspace sees and acts in only
 * the apps it granted, read again before each call (`refresh`), and keeps its
 * own observed trees. Attendance is the call's (`DesktopActOptions.attended`).
 * The abort hotkey (`abortAll`) stops what every gate is doing, and every run
 * that used desktop control so far (`noteRun`) for the rest of that run: a
 * later run acts again.
 */
export function createDesktopWorkspaces(options: {
  readonly desktop: DesktopPort;
  readonly grantedApps: (workspaceId: string) => Promise<readonly string[]>;
  /** The runs a press of the abort hotkey stopped, each once: told `DESKTOP_STOPPED_NOTICE` in its chat. */
  readonly onStopped?: (runs: readonly { readonly workspaceId: string; readonly runId: string }[]) => void;
}): {
  readonly portFor: (workspaceId: string) => GatedDesktopPort;
  /** Reads the workspace's grants for a call of run `runId`; refuses a run the abort hotkey stopped. */
  readonly refresh: (workspaceId: string, runId: string) => Promise<void>;
  /** A run that is using desktop control, as its card is asked about: the abort hotkey stops it too. */
  readonly noteRun: (workspaceId: string, runId: string) => void;
  readonly abortAll: () => void;
  /**
   * An app's tier under the workspace's grants as last read, for the approval card. Before they were ever read (a
   * fresh owner whose first desktop call is an act) its built-in tier, while they are read: the gate, which reads
   * them before it acts, still refuses an app they do not grant.
   */
  readonly tierOf: (workspaceId: string, app: { readonly bundleId: string; readonly name: string }) => DesktopAppGrantTier | undefined;
  /** The workspace's `desktop.grantedApps` as last read (`refresh`): what `desktop.observe` tells the model it may focus. */
  readonly grantedApps: (workspaceId: string) => readonly string[];
} {
  const grants = new Map<string, readonly string[]>();
  // Running apps' bundle ids by lowercased name, learned as grants are read: a call that names only "TextEdit" is
  // matched against a grant of "com.apple.TextEdit" (Mac mini tests). The gate resolves the real app before it acts.
  const bundleIds = new Map<string, string>();
  const learnApps = async (): Promise<void> => {
    try {
      for (const running of await options.desktop.apps()) bundleIds.set(running.name.trim().toLowerCase(), running.bundleId);
    } catch {
      // No helper, or no Accessibility: names stay unresolved, and the gate says why when it acts.
    }
  };
  const resolved = (app: { readonly bundleId: string; readonly name: string }): { readonly bundleId: string; readonly name: string } => {
    const unresolved = app.bundleId.trim() === "" || app.bundleId.trim().toLowerCase() === app.name.trim().toLowerCase();
    const bundleId = unresolved ? bundleIds.get(app.name.trim().toLowerCase()) : undefined;
    return bundleId === undefined ? app : { bundleId, name: app.name };
  };
  const ports = new Map<string, GatedDesktopPort>();
  const seen = new Map<string, Set<string>>();
  const stopped = new Map<string, Set<string>>();
  const remember = (runs: Map<string, Set<string>>, workspaceId: string, runId: string): void => {
    const set = runs.get(workspaceId) ?? new Set<string>();
    set.delete(runId);
    set.add(runId);
    while (set.size > REMEMBERED_RUNS) set.delete(set.values().next().value ?? "");
    runs.set(workspaceId, set);
  };
  const portFor = (workspaceId: string): GatedDesktopPort => {
    let port = ports.get(workspaceId);
    if (port === undefined) {
      port = createGatedDesktopPort(options.desktop, { grantedApps: (app) => grantedTierOf(grants.get(workspaceId) ?? [], app) });
      ports.set(workspaceId, port);
    }
    return port;
  };
  const noteRun = (workspaceId: string, runId: string): void => remember(seen, workspaceId, runId);
  return {
    portFor,
    tierOf: (workspaceId, app) => {
      const read = grants.get(workspaceId);
      if (read !== undefined) return grantedTierOf(read, resolved(app));
      void Promise.all([options.grantedApps(workspaceId), learnApps()])
        .then(([apps]) => {
          if (!grants.has(workspaceId)) grants.set(workspaceId, apps);
        })
        .catch(() => undefined);
      return defaultDesktopAppGrantTier(app.bundleId, app.name);
    },
    grantedApps: (workspaceId) => grants.get(workspaceId) ?? [],
    noteRun,
    refresh: async (workspaceId, runId) => {
      if (stopped.get(workspaceId)?.has(runId) === true)
        throw new TaviError("CANCELLED", "desktop control was stopped by the abort hotkey for this run: start a new one to act again");
      noteRun(workspaceId, runId);
      const [apps] = await Promise.all([options.grantedApps(workspaceId), learnApps()]);
      grants.set(workspaceId, apps);
    },
    abortAll: () => {
      const stoppedNow: { readonly workspaceId: string; readonly runId: string }[] = [];
      for (const [workspaceId, runs] of seen) {
        for (const runId of runs) {
          remember(stopped, workspaceId, runId);
          stoppedNow.push({ workspaceId, runId });
        }
        runs.clear();
      }
      for (const port of ports.values()) {
        // Refuses what is in flight; the runs stopped are held here, so the gate itself is clear for the next.
        void port.abort?.().catch(() => undefined);
        port.resetAbort();
      }
      // Told after the ports are stopped: a notice that cannot be posted never holds up the stop.
      if (stoppedNow.length > 0) {
        try {
          options.onStopped?.(stoppedNow);
        } catch {
          // Best effort: the runs are stopped whether or not they could be told.
        }
      }
    },
  };
}
