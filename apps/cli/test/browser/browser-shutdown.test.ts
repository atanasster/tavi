import { tmpdir } from "node:os";

import { createPlaywrightBrowser, type PlaywrightBrowserOptions } from "@tavi/plugin-browser/playwright";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it, vi } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The shared browser is a child process: an in-process run (`tavi run`,
 * `tavi approvals approve|reject`, `tavi artifacts --resume`) that used it
 * never exited, because closing the runtime left it running. Closing the
 * runtime now disposes the adapter, which closes the browser.
 */

const directories = temporaryDirectories();

afterAll(() => directories.cleanup());

type Launch = NonNullable<PlaywrightBrowserOptions["launch"]>;

function fakeLaunch(): {
  readonly launch: Launch;
  readonly closeBrowser: ReturnType<typeof vi.fn>;
  readonly closeContext: ReturnType<typeof vi.fn>;
} {
  const closeBrowser = vi.fn(async () => {});
  const closeContext = vi.fn(async () => {});
  const page = { url: () => "about:blank", on: () => undefined };
  const context = { newPage: async () => page, close: closeContext };
  const browser = { newContext: async () => context, close: closeBrowser };
  return { launch: (async () => browser) as unknown as Launch, closeBrowser, closeContext };
}

describe("closing the runtime", () => {
  it("disposes the browser, closing its open sessions and the shared process", async () => {
    const directory = directories.create("tavi-browser-shutdown-");
    const { launch, closeBrowser, closeContext } = fakeLaunch();
    const browser = createPlaywrightBrowser({ stagingDirectory: tmpdir(), launch });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
      browserOverride: browser,
    });
    // A session left open, as a task that never called browser.close leaves one.
    await browser.createSession({ workspaceId: "default" });

    await runtime.close();

    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    await expect(browser.createSession({ workspaceId: "default" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
