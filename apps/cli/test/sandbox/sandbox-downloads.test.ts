import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { holdsDownloads } from "../../src/features/sandbox/tools.js";

/** Whether a shell run's result is untrusted because the chat's folder holds downloads. */

const directories = temporaryDirectories({ prefix: "tavi-sandbox-downloads-" });
afterAll(() => directories.cleanup());

function chatFolder(): { readonly dataDirectory: string; readonly managed: string } {
  const dataDirectory = directories.create();
  const managed = join(dataDirectory, "chats", "chat-1");
  mkdirSync(managed, { recursive: true });
  return { dataDirectory, managed };
}

describe("a chat folder's downloads", () => {
  it("holds none with no downloads folder or an empty one, and some once a file is there", () => {
    const { dataDirectory, managed } = chatFolder();
    expect(holdsDownloads(dataDirectory, { managed, attachments: [] })).toBe(false);
    mkdirSync(join(managed, "downloads"));
    expect(holdsDownloads(dataDirectory, { managed, attachments: [] })).toBe(false);
    writeFileSync(join(managed, "downloads", "page.html"), "<p>from the web</p>");
    expect(holdsDownloads(dataDirectory, { managed, attachments: [] })).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("counts a downloads folder that cannot be listed as holding some: the result is untrusted", () => {
    const { dataDirectory, managed } = chatFolder();
    const downloads = join(managed, "downloads");
    mkdirSync(downloads);
    writeFileSync(join(downloads, "page.html"), "<p>from the web</p>");
    chmodSync(downloads, 0o000);
    try {
      expect(holdsDownloads(dataDirectory, { managed, attachments: [] })).toBe(true);
    } finally {
      chmodSync(downloads, 0o700);
    }
  });
});
