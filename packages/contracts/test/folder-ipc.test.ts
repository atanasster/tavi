import { describe, expect, it } from "vitest";

import {
  CHAT_NOTICE_KINDS,
  DISPLAY_ONLY_NOTICE_KINDS,
  IPC_COMMANDS,
  IPC_PROTOCOL_VERSION,
  UI_BRIDGE_COMMANDS,
  chatFolderPruneCommand,
  parseCommandPayload,
  protocolMismatchError,
} from "../src/index.js";

/**
 * A chat's working folder over IPC: the
 * `run` payload's `folder` and `clientCwd`, the `folder` and `browse`
 * commands, and the protocol bump that keeps an older peer from dropping them.
 */

const run = { prompt: "hi", workspaceId: "default", principal: "operator", operationKey: "op-1", approval: "client" } as const;

describe("protocol 7", () => {
  it("refuses a protocol-6 peer with the standard upgrade message", () => {
    expect(IPC_PROTOCOL_VERSION).toBe(7);
    expect(protocolMismatchError(6).message).toBe("the running `tavi serve` speaks protocol 6; this CLI speaks 7 — restart the service");
  });

  it("adds folder and browse to the contract and, deliberately, to the bridge's allowlist", () => {
    expect(IPC_COMMANDS).toEqual(expect.arrayContaining(["folder", "browse"]));
    expect(UI_BRIDGE_COMMANDS).toEqual(expect.arrayContaining(["folder", "browse"]));
  });
});

describe("run.folder and run.clientCwd", () => {
  it("takes the managed folder, a path or a picker token, and a client directory", () => {
    for (const folder of [{ managed: true }, { path: "/work/app" }, { pick: "a".repeat(24) }]) {
      expect(parseCommandPayload("run", { ...run, folder }).ok).toBe(true);
    }
    expect(parseCommandPayload("run", { ...run, clientCwd: "/work/app" }).ok).toBe(true);
  });

  it("refuses a folder that is none of them, or several", () => {
    expect(parseCommandPayload("run", { ...run, folder: { path: "/a", pick: "a".repeat(24) } }).ok).toBe(false);
    expect(parseCommandPayload("run", { ...run, folder: { managed: false } }).ok).toBe(false);
    expect(parseCommandPayload("run", { ...run, folder: { pick: "short" } }).ok).toBe(false);
    expect(parseCommandPayload("run", { ...run, clientCwd: "" }).ok).toBe(false);
  });
});

describe("folder", () => {
  const target = { workspaceId: "default", taskId: "task-1" };

  it("parses every action", () => {
    for (const payload of [
      { action: "show" },
      { action: "set", folder: { managed: true } },
      { action: "set", folder: { pick: "b".repeat(24) } },
      { action: "attach", folder: { path: "/work/lib" }, mode: "rw" },
      { action: "detach", label: "lib" },
      { action: "reset" },
      { action: "files", root: "attachment:lib", dir: "src" },
      { action: "read", root: "primary", path: "notes/a.txt", offset: 0 },
      { action: "read", path: "a.txt", offset: 262_144, sha256: "0".repeat(64) },
    ]) {
      expect(parseCommandPayload("folder", { ...target, ...payload }).ok, JSON.stringify(payload)).toBe(true);
    }
  });

  it("refuses a path that leaves the folder, an unknown root, and attaching the managed folder by name", () => {
    expect(parseCommandPayload("folder", { ...target, action: "read", path: "../secret", offset: 0 }).ok).toBe(false);
    expect(parseCommandPayload("folder", { ...target, action: "read", path: "/etc/passwd", offset: 0 }).ok).toBe(false);
    expect(parseCommandPayload("folder", { ...target, action: "files", dir: "a/../../b" }).ok).toBe(false);
    expect(parseCommandPayload("folder", { ...target, action: "files", root: "somewhere" }).ok).toBe(false);
    expect(parseCommandPayload("folder", { ...target, action: "attach", folder: { managed: true } }).ok).toBe(false);
  });

  it("browse takes a token to list inside, never a path", () => {
    expect(parseCommandPayload("browse", {}).ok).toBe(true);
    expect(parseCommandPayload("browse", { under: "c".repeat(24) }).ok).toBe(true);
    expect(parseCommandPayload("browse", { path: "/" }).ok).toBe(false);
  });
});

describe("folder notices and forget", () => {
  it("adds a display-only folder notice kind, and names the prune command", () => {
    expect(CHAT_NOTICE_KINDS).toContain("folder");
    expect(DISPLAY_ONLY_NOTICE_KINDS).toEqual(expect.arrayContaining(["epoch", "folder"]));
    expect(chatFolderPruneCommand("task-1")).toBe("tavi tasks folders prune --chat task-1");
  });
});
