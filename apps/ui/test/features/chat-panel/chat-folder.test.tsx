// @vitest-environment jsdom
import { createHash } from "node:crypto";

import { initialRunState } from "@tavi/client/browser";
import { FOLDER_READ_MAX_BYTES, type ChatNotice, type FolderView } from "@tavi/contracts";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Canvas } from "../../../src/features/chat/Canvas.js";
import { DraftFolderChip, FolderChip, type DraftFolder } from "../../../src/features/chat-panel/Folder.js";
import { readFolderFile } from "../../../src/features/chat-panel/folder-api.js";
import { NoticeCards } from "../../../src/features/chat/Notices.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import type { CanvasRun } from "../../../src/features/chat/store/types.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, mountSettled as mount, settledBy } from "../../support/dom.js";

/**
 * The chat's working folder on the canvas:
 * the header chip, its panel and attach picker, the octet-stream download
 * checked against the file's hash, and the notices and rewind wording.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

const { settle, click } = settledBy(() => flush(6, 0));
const button = (page: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...page.querySelectorAll("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
const phone = (): void => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("720px"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
};

const at = "2026-10-01T10:00:00.000Z";
const TOKEN = (n: number) => `tok${String(n).padStart(13, "0")}`;
const managedView: FolderView = {
  taskId: "t1",
  revision: 1,
  managed: "/data/chats/default/t1",
  primary: { kind: "managed", path: "/data/chats/default/t1", label: "Chat files" },
  attachments: [{ path: "/home/me/docs", mode: "ro", label: "docs" }],
};
const hostView: FolderView = { ...managedView, revision: 2, primary: { kind: "host", path: "/home/me/project", label: "project" } };
const goneView: FolderView = {
  taskId: "t1",
  revision: 3,
  managed: "/data/chats/default/t1",
  attachments: [],
  unavailable: "The folder /home/me/old is gone.",
};

const roots = [
  { id: "primary", label: "Chat files", path: "/data/chats/default/t1", mode: "rw" as const },
  { id: "attachment:docs", label: "docs", path: "/home/me/docs", mode: "ro" as const },
];

/** A file the owner serves, chunked; `tamper` changes the bytes it serves after hashing the original. */
interface Served {
  readonly bytes: Uint8Array;
  readonly hash?: string;
  readonly chunk?: number;
}

/** An owner holding one chat's folder and answering `folder` and `browse`. */
function owner(options: { readonly view?: FolderView; readonly files?: Readonly<Record<string, Served>> } = {}) {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  let view = options.view ?? managedView;
  const client: SettingsClient = {
    request: async (command, payload) => {
      const input = payload as Record<string, unknown>;
      sent.push({ command, payload: input });
      if (command === "browse") {
        if (input["under"] === undefined)
          return { ok: true, result: { entries: [{ token: TOKEN(1), name: "me", path: "/home/me", opens: true }], truncated: false } };
        if (input["under"] === TOKEN(1))
          return {
            ok: true,
            result: {
              at: { token: TOKEN(2), name: "me", path: "/home/me", opens: true },
              entries: [{ token: TOKEN(3), name: "project", path: "/home/me/project", opens: false }],
              truncated: false,
            },
          };
        return { ok: false, error: { code: "NOT_FOUND", message: "unknown token" } };
      }
      if (command !== "folder") return { ok: false, error: { code: "UNAVAILABLE", message: `${command} unavailable` } };
      switch (input["action"]) {
        case "show":
          return { ok: true, result: view };
        case "reset":
          view = managedView;
          return { ok: true, result: view };
        case "attach":
          view = {
            ...view,
            revision: view.revision + 1,
            attachments: [
              ...view.attachments,
              { path: "/home/me/project", mode: (input["mode"] as "ro" | "rw") ?? "ro", label: "project" },
            ],
          };
          return { ok: true, result: view };
        case "set":
          view = hostView;
          return { ok: true, result: view };
        case "detach":
          view = { ...view, revision: view.revision + 1, attachments: view.attachments.filter((one) => one.label !== input["label"]) };
          return { ok: true, result: view };
        case "files": {
          const dir = (input["dir"] as string | undefined) ?? "";
          const entries =
            dir === ""
              ? [
                  { name: "out", kind: "directory", size: 0, modifiedAt: at },
                  { name: "page.html", kind: "file", size: 12, modifiedAt: at },
                ]
              : [{ name: "report.txt", kind: "file", size: 5, modifiedAt: at }];
          return { ok: true, result: { taskId: "t1", root: roots[0], roots, dir, entries, truncated: false } };
        }
        case "read": {
          const file = options.files?.[input["path"] as string];
          if (file === undefined) return { ok: false, error: { code: "NOT_FOUND", message: "no such file" } };
          const hash = file.hash ?? createHash("sha256").update(file.bytes).digest("hex");
          const offset = input["offset"] as number;
          const size = file.chunk ?? file.bytes.length;
          const part = file.bytes.slice(offset, offset + size);
          const next = offset + part.length;
          return {
            ok: true,
            result: {
              taskId: "t1",
              name: (input["path"] as string).split("/").at(-1),
              hash,
              totalBytes: file.bytes.length,
              offset,
              base64: Buffer.from(part).toString("base64"),
              nextOffset: next >= file.bytes.length ? null : next,
            },
          };
        }
        default:
          return { ok: false, error: { code: "INVALID", message: "?" } };
      }
    },
  };
  return { client, sent };
}

const chip = (page: HTMLElement) => page.querySelector<HTMLButtonElement>(".folder-chip");

describe("the folder chip", () => {
  it("says Chat files for the chat's own folder", async () => {
    const { client } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    expect(chip(page)?.getAttribute("aria-label")).toBe("Chat files");
    expect(page.querySelector(".folder-chip-mark")).toBeNull();
  });

  it("names a host folder as Folder <label>", async () => {
    const { client } = owner({ view: hostView });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    expect(chip(page)?.getAttribute("aria-label")).toBe("Folder project");
    expect(chip(page)?.title).toContain("/home/me/project");
  });

  it("offers Reset beside a folder that is gone, which resets it without a terminal (decision j)", async () => {
    const { client, sent } = owner({ view: goneView });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    expect(chip(page)?.getAttribute("aria-label")).toBe("Folder unavailable");
    expect(chip(page)?.className).toContain("folder-chip-unavailable");
    await click(button(page, "Reset"));
    expect(sent.at(-1)).toEqual({ command: "folder", payload: { action: "reset", workspaceId: "default", taskId: "t1" } });
    expect(chip(page)?.getAttribute("aria-label")).toBe("Chat files");
  });

  it("offers Reset for a folder record that no longer reads, as the owner answers it, which recovers it (decision j)", async () => {
    const tornView: FolderView = {
      ...goneView,
      unavailable: "The working folder stored for task t1 cannot be read. Run /folder reset to go back to the chat's own folder.",
    };
    const { client, sent } = owner({ view: tornView });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    expect(chip(page)?.getAttribute("aria-label")).toBe("Folder unavailable");
    expect(chip(page)?.title).toContain("cannot be read");
    await click(chip(page));
    const panel = page.querySelector<HTMLElement>(".folder-panel")!;
    expect(panel.querySelector(".folder-unavailable")?.textContent).toContain("cannot be read");
    expect(sent.some((one) => one.payload["action"] === "files")).toBe(false);
    await click(button(panel, "Reset"));
    expect(sent).toContainEqual({ command: "folder", payload: { action: "reset", workspaceId: "default", taskId: "t1" } });
    expect(chip(page)?.getAttribute("aria-label")).toBe("Chat files");
  });

  it("keeps Reset for a folder that is gone on the phone", async () => {
    phone();
    const { client, sent } = owner({ view: goneView });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    await click(chip(page));
    const panel = page.querySelector(".folder-panel")!;
    await click(button(panel as HTMLElement, "Reset"));
    expect(sent.some((one) => one.payload["action"] === "reset")).toBe(true);
  });

  it("shows in the chat header only when the Canvas is given one", async () => {
    const run: CanvasRun = {
      id: "r1",
      prompt: "go",
      run: { ...initialRunState({ taskId: "t1" }), status: "completed" },
      roundCalls: {},
      deciding: undefined,
      aborting: false,
    };
    const noop = () => {};
    const session = { key: "t1", taskId: "t1", title: "go", status: "completed" as const, runs: [run] };
    const { client } = owner();
    const page = await mount(
      <Canvas
        state={{ connection: "ready", runs: [run] }}
        session={session}
        onSubmit={noop}
        onDecide={noop}
        onAbort={noop}
        onExpand={noop}
        folderChip={
          <InWorkspace client={client} workspaceId="default">
            <FolderChip taskId="t1" canBrowse />
          </InWorkspace>
        }
      />,
    );
    expect(page.querySelector(".task-header .folder-chip")?.getAttribute("aria-label")).toBe("Chat files");
  });
});

describe("the folder panel", () => {
  it("shows a folder that is gone with Reset, and does not list it", async () => {
    const { client, sent } = owner({ view: goneView });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    await click(chip(page));
    const panel = page.querySelector<HTMLElement>(".folder-panel")!;
    expect(panel.querySelector(".folder-unavailable")?.textContent).toContain("The folder /home/me/old is gone.");
    expect(button(panel, "Reset")).toBeDefined();
    expect(sent.some((one) => one.payload["action"] === "files")).toBe(false);
    expect(panel.querySelector(".failure")).toBeNull();
    expect(panel.querySelector(".folder-files")).toBeNull();
  });

  it("opens again without the note of a change made the last time it was open", async () => {
    const { client } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    await click(chip(page));
    await click(button(page.querySelector<HTMLElement>(".folder-panel")!, "Detach docs"));
    expect(page.querySelector(".folder-panel")?.textContent).toContain("Detached docs.");
    await click(button(page.querySelector<HTMLElement>(".folder-panel")!, "Close"));
    await click(chip(page));
    expect(page.querySelector(".folder-panel")?.textContent).not.toContain("Detached docs.");
  });

  it("takes focus as it opens, and gives it back to the chip as it closes", async () => {
    const { client } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    await click(chip(page));
    expect(document.activeElement).toBe(page.querySelector(".folder-panel h2"));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(page.querySelector(".folder-panel")).toBeNull();
    expect(document.activeElement).toBe(chip(page));
    await click(chip(page));
    await click(button(page.querySelector<HTMLElement>(".folder-panel")!, "Close"));
    expect(document.activeElement).toBe(chip(page));
  });

  it("lists the folder's roots with their modes and its files, and opens a subfolder", async () => {
    const { client, sent } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    await click(chip(page));
    const panel = page.querySelector<HTMLElement>(".folder-panel")!;
    expect([...panel.querySelectorAll(".folder-root")].map((row) => row.textContent)).toEqual([
      "Chat filesread-write",
      "docsread-onlyDetach",
    ]);
    expect(panel.querySelector(".folder-where")?.textContent).toBe("/data/chats/default/t1");
    expect(button(panel, "Download page.html")).toBeDefined();
    await click(button(panel, "Open out"));
    expect(sent.at(-1)?.payload).toMatchObject({ action: "files", dir: "out" });
    expect(button(panel, "Download report.txt")).toBeDefined();
    await click(button(panel, "Detach docs"));
    expect(sent.some((one) => one.payload["action"] === "detach" && one.payload["label"] === "docs")).toBe(true);
  });

  it("saves a folder's HTML file as application/octet-stream, never as HTML", async () => {
    const bytes = new TextEncoder().encode("<script>1</script>");
    const { client } = owner({ files: { "page.html": { bytes, chunk: 7 } } });
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:x";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    await click(chip(page));
    await click(button(page, "Download page.html"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe("application/octet-stream");
    expect([...new Uint8Array(await blobs[0]!.arrayBuffer())]).toEqual([...bytes]);
    expect(clicked).toHaveBeenCalled();
    expect(page.querySelector(".folder-panel .failure")).toBeNull();
  });

  it("offers the attach picker by token, and never sends a path or asks for one", async () => {
    const { client, sent } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    await click(chip(page));
    await click(button(page, "Attach a folder…"));
    const picker = page.querySelector<HTMLElement>(".folder-picker")!;
    expect(sent.at(-1)).toEqual({ command: "browse", payload: { workspaceId: "default" } });
    await click(button(picker, "Open me"));
    expect(sent.at(-1)).toEqual({ command: "browse", payload: { workspaceId: "default", under: TOKEN(1) } });
    expect(picker.querySelector(".folder-where")?.textContent).toBe("/home/me");
    // A folder too deep to open may still be picked.
    expect(button(picker, "Open project")).toBeUndefined();
    await click(button(picker, "Attach read-write: project"));
    // The answer is the folder now: its listing is read again.
    expect(sent.findLast((one) => one.payload["action"] === "attach")).toEqual({
      command: "folder",
      payload: { action: "attach", workspaceId: "default", taskId: "t1", folder: { pick: TOKEN(3) }, mode: "rw" },
    });
    await click(button(page.querySelector<HTMLElement>(".folder-picker")!, "Work in this folder: project"));
    expect(sent.findLast((one) => one.payload["action"] === "set")).toEqual({
      command: "folder",
      payload: { action: "set", workspaceId: "default", taskId: "t1", folder: { pick: TOKEN(3) } },
    });
    // Going up from a root's child lists the roots again.
    await click(button(page.querySelector<HTMLElement>(".folder-picker")!, "Up"));
    expect(sent.at(-1)).toEqual({ command: "browse", payload: { workspaceId: "default" } });
    // No path ever leaves the page, and there is nowhere to type one.
    const choices = sent.filter((one) => one.command === "browse" || ["set", "attach"].includes(one.payload["action"] as string));
    expect(choices.length).toBeGreaterThan(0);
    expect(JSON.stringify(choices)).not.toContain('"path"');
    expect(page.querySelectorAll("input, textarea")).toHaveLength(0);
  });

  it("is list-and-download only on the phone", async () => {
    phone();
    const { client } = owner({ view: hostView });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <FolderChip taskId="t1" canBrowse />
      </InWorkspace>,
    );
    await click(chip(page));
    const panel = page.querySelector<HTMLElement>(".folder-panel")!;
    expect(button(panel, "Download page.html")).toBeDefined();
    for (const label of ["Attach a folder…", "Detach docs", "Work in Chat files", "Reset…"])
      expect(button(panel, label), label).toBeUndefined();
    expect(page.querySelector(".folder-picker")).toBeNull();
  });
});

describe("the folder chip on a chat not started", () => {
  /** The draft as the page holds it: what the chip changed it to last. */
  function Drafting({ seen }: { readonly seen: (draft: readonly DraftFolder[]) => void }) {
    const [draft, setDraft] = useState<readonly DraftFolder[]>([]);
    return (
      <DraftFolderChip
        draft={draft}
        onChange={(next) => {
          seen(next);
          setDraft(next);
        }}
      />
    );
  }

  it("holds the folders picked by token in the page, asks nothing of a chat, and detaches from the draft", async () => {
    const { client, sent } = owner();
    let draft: readonly DraftFolder[] = [];
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Drafting seen={(next) => (draft = next)} />
      </InWorkspace>,
    );
    expect(chip(page)?.textContent).toBe("Chat files");
    await click(chip(page));
    const panel = page.querySelector<HTMLElement>(".folder-panel")!;
    expect(panel.textContent).toContain("go with its first message");
    expect(panel.textContent).toContain("Reloading the page drops them");
    await click(button(panel, "Attach a folder…"));
    await click(button(panel, "Open me"));
    expect(button(panel, "Work in this folder: project")).toBeUndefined();
    await click(button(panel, "Attach read-write: project"));
    expect(draft).toEqual([{ token: TOKEN(3), name: "project", path: "/home/me/project", mode: "rw" }]);
    expect(chip(page)?.textContent).toBe("Chat files +1");
    expect(panel.querySelector('[aria-label="Folders"]')?.textContent).toContain("read-write");
    // The same folder again is refused: detach it to change its mode.
    await click(button(panel, "Attach read-only: project"));
    expect(draft).toHaveLength(1);
    expect(panel.textContent).toContain("attached already");
    await click(button(panel, "Detach project"));
    expect(draft).toEqual([]);
    expect(chip(page)?.textContent).toBe("Chat files");
    expect(sent.map((one) => one.command)).toEqual(["browse", "browse"]);
  });
});

describe("a folder download", () => {
  it("passes the first chunk's hash on every later chunk, and assembles the file", async () => {
    const bytes = new TextEncoder().encode("hello, folder");
    const { client, sent } = owner({ files: { "a.txt": { bytes, chunk: 4 } } });
    const file = await readFolderFile(client, "default", "t1", undefined, "a.txt");
    expect(file.ok && new TextDecoder().decode(file.value.bytes)).toBe("hello, folder");
    const reads = sent.filter((one) => one.payload["action"] === "read");
    expect(reads[0]!.payload["sha256"]).toBeUndefined();
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(reads.slice(1).every((one) => one.payload["sha256"] === hash)).toBe(true);
    expect(reads.map((one) => one.payload["offset"])).toEqual([0, 4, 8, 12]);
  });

  it("fails with a mismatch when the assembled bytes do not hash to the file's hash", async () => {
    const { client } = owner({ files: { "a.txt": { bytes: new TextEncoder().encode("changed"), hash: "0".repeat(64) } } });
    const file = await readFolderFile(client, "default", "t1", undefined, "a.txt");
    expect(file.ok).toBe(false);
    expect(!file.ok && file.message).toMatch(/SHA-256 mismatch/);
    expect(!file.ok && file.message).toContain("changed while it was downloaded");
  });

  it("refuses a file past the size cap", async () => {
    const client: SettingsClient = {
      request: async () => ({
        ok: true,
        result: {
          taskId: "t1",
          name: "big",
          hash: "a".repeat(64),
          totalBytes: FOLDER_READ_MAX_BYTES + 1,
          offset: 0,
          base64: "",
          nextOffset: 1,
        },
      }),
    };
    const big = await readFolderFile(client, "default", "t1", undefined, "big");
    expect(big.ok).toBe(false);
  });

  it("says a file the owner refused as changed was changed", async () => {
    const client: SettingsClient = { request: async () => ({ ok: false, error: { code: "CONFLICT", message: "file changed" } }) };
    const file = await readFolderFile(client, "default", "t1", undefined, "dir/a.txt");
    expect(!file.ok && file.message).toBe("a.txt changed while it was downloaded. Download it again.");
  });
});

describe("the folder's notices and wording", () => {
  it("shows a folder notice as a card", async () => {
    const notice: ChatNotice = {
      noticeId: "n1",
      taskId: "t1",
      kind: "folder",
      title: "This chat still reads and writes every --fs-root",
      summary: "Reset narrows it.",
      afterSeq: 0,
      createdAt: at,
    };
    const page = await mount(<NoticeCards notices={[notice]} connected onReply={() => undefined} />);
    const card = page.querySelector('.chat-notice[data-notice-kind="folder"]');
    expect(card?.textContent).toContain("Folder: This chat still reads and writes every --fs-root");
    expect(button(page, "Reply in a side chat")).toBeUndefined();
  });

  it("says rewind leaves the chat's folder alone (decision m)", async () => {
    const turn = (id: string, prompt: string): CanvasRun => ({
      id,
      prompt,
      run: { ...initialRunState({ taskId: "t1" }), status: "completed" },
      roundCalls: {},
      deciding: undefined,
      aborting: false,
    });
    const runs = [turn("r1", "first")];
    const noop = () => {};
    const page = await mount(
      <Canvas
        state={{ connection: "ready", runs }}
        session={{ key: "t1", taskId: "t1", title: "first", status: "completed", runs }}
        onSubmit={noop}
        onDecide={noop}
        onAbort={noop}
        onExpand={noop}
        onRewind={vi.fn()}
      />,
    );
    await click(page.querySelector('button[aria-label="Rewind to here"]'));
    expect(page.querySelector(".rewind-confirm")?.textContent).toContain("Files in the chat's folder were not changed.");
  });
});
