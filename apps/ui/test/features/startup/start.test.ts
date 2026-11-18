import type { TaviClient } from "@tavi/client/browser";
import { describe, expect, it } from "vitest";

import { SESSION_SECRET_KEY, startPage, watchForNewLink, type PageHost, type PageStorage } from "../../../src/features/startup/start.js";

/** The page's start: scrub, exchange, connect, render — in that order. */

function host(overrides: Partial<PageHost> & { readonly hash?: string } = {}) {
  const steps: string[] = [];
  const client = { state: "ready" } as unknown as TaviClient;
  const page: PageHost = {
    location: { origin: "http://127.0.0.1:4100", pathname: "/", hash: overrides.hash ?? "#tok" },
    history: { replaceState: () => void steps.push("scrub") },
    fetch: () => {
      steps.push("exchange");
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ secret: "s3cret" }) });
    },
    connect: (secret) => {
      steps.push(`connect ${secret}`);
      return Promise.resolve(client);
    },
    message: (text) => void steps.push(`message ${text}`),
    render: (rendered) => void steps.push(rendered === client ? "render" : "render another"),
    ...overrides,
  };
  return { page, steps };
}

describe("startPage", () => {
  it("scrubs the link, exchanges it, connects with the secret, then renders", async () => {
    const { page, steps } = host();
    await startPage(page);
    expect(steps).toEqual(["scrub", "exchange", "message Connecting to the owner…", "connect s3cret", "render"]);
  });

  it("stops with a message when there is no link, the link is refused, or the owner cannot be reached", async () => {
    const none = host({ hash: "" });
    await startPage(none.page);
    expect(none.steps).toEqual([expect.stringContaining("message Open this page from the link")]);

    const refused = host({ fetch: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }) });
    await startPage(refused.page);
    expect(refused.steps).toEqual(["scrub", expect.stringContaining("used or has expired")]);

    const unreachable = host({ connect: () => Promise.reject(new Error("no tavi owner is serving")) });
    await startPage(unreachable.page);
    expect(unreachable.steps.at(-1)).toBe("message Could not reach the owner: no tavi owner is serving");
    expect(unreachable.steps).not.toContain("render");
  });

  it("keeps the session in the tab's storage, so a reload reuses it rather than ask for a new link", async () => {
    const kept = new Map<string, string>();
    const storage: PageStorage = {
      getItem: (key) => kept.get(key) ?? null,
      setItem: (key, value) => void kept.set(key, value),
      removeItem: (key) => void kept.delete(key),
    };
    const first = host({ storage });
    await startPage(first.page);
    expect(kept.get(SESSION_SECRET_KEY)).toBe("s3cret");
    // Reloaded: no fragment, no exchange — the kept secret connects.
    const reloaded = host({ hash: "", storage });
    await startPage(reloaded.page);
    expect(reloaded.steps).toEqual(["message Connecting to the owner…", "connect s3cret", "render"]);
    // The session has ended since: forgotten, and a new link asked for.
    const ended = host({ hash: "", storage, connect: () => Promise.reject(new Error("session refused")) });
    await startPage(ended.page);
    expect(ended.steps.at(-1)).toContain("This tab's sign-in has ended");
    expect(kept.has(SESSION_SECRET_KEY)).toBe(false);
  });

  it("works as before when the tab's storage refuses", async () => {
    const refusing: PageStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
    };
    const linked = host({ storage: refusing });
    await startPage(linked.page);
    expect(linked.steps.at(-1)).toBe("render");
    const reloaded = host({ hash: "", storage: refusing });
    await startPage(reloaded.page);
    expect(reloaded.steps).toEqual([expect.stringContaining("message Open this page from the link")]);
  });
});

describe("watchForNewLink", () => {
  const TOKEN = "18kCYRWNCKB9-RYpKhxqgLYc7x-LQB2RFesJcFxkXlw";

  function watched(pathname: string) {
    const location = { pathname, hash: "" };
    let changed: (() => void) | undefined;
    let reloads = 0;
    watchForNewLink({
      location,
      addEventListener: (_type, listener) => {
        changed = listener;
      },
      reload: () => {
        reloads += 1;
      },
    });
    return {
      open: (hash: string) => {
        location.hash = hash;
        changed?.();
      },
      reloads: () => reloads,
    };
  }

  it("loads the page again when a new link is opened in the tab", () => {
    const tab = watched("/");
    tab.open(`#${TOKEN}`);
    expect(tab.reloads()).toBe(1);
  });

  it("leaves an anchor, an emptied fragment, or a page off the root alone", () => {
    const root = watched("/");
    root.open("#rule-shell");
    root.open("");
    expect(root.reloads()).toBe(0);
    const settings = watched("/settings/permissions");
    settings.open(`#${TOKEN}`);
    expect(settings.reloads()).toBe(0);
  });
});
