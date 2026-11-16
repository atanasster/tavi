import { UI_SESSION_PATH } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { openSession, type SessionFetch } from "../../../src/features/startup/session.js";

/** The page's first step: the link's token, exchanged once, and scrubbed first. */

const location = (hash: string) => ({ origin: "http://127.0.0.1:4100", pathname: "/", hash });

function history() {
  const replaced: (string | undefined)[] = [];
  return { replaced, replaceState: (_data: unknown, _unused: string, url?: string) => void replaced.push(url) };
}

const answering =
  (status: number, body: unknown, calls: { url: string; body: string; credentials: string }[] = []): SessionFetch =>
  (url, init) => {
    calls.push({ url, body: init.body, credentials: init.credentials });
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
  };

describe("openSession", () => {
  it("scrubs the token from the address bar before exchanging it, and holds the secret it answers", async () => {
    const page = history();
    const calls: { url: string; body: string; credentials: string }[] = [];
    let scrubbedFirst = false;
    const fetch: SessionFetch = (url, init) => {
      scrubbedFirst = page.replaced.length === 1;
      return answering(200, { secret: "s3cret" }, calls)(url, init);
    };
    expect(await openSession(location("#tok-123"), page, fetch)).toEqual({ kind: "session", secret: "s3cret" });
    expect(scrubbedFirst).toBe(true);
    expect(page.replaced).toEqual(["/"]);
    expect(calls).toEqual([
      { url: `http://127.0.0.1:4100${UI_SESSION_PATH}`, body: JSON.stringify({ token: "tok-123" }), credentials: "same-origin" },
    ]);
  });

  it("asks for a link when there is none, touching nothing", async () => {
    const page = history();
    const calls: { url: string; body: string; credentials: string }[] = [];
    expect(await openSession(location(""), page, answering(200, {}, calls))).toEqual({ kind: "no-link" });
    expect(page.replaced).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reads a bare # as no link, and a body that is no JSON as unreadable", async () => {
    const page = history();
    expect(await openSession(location("#"), page, answering(200, {}))).toEqual({ kind: "no-link" });
    expect(page.replaced).toEqual([]);
    const notJson: SessionFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("not JSON")) });
    expect(await openSession(location("#t"), history(), notJson)).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("cannot read"),
    });
  });

  it("says why a link was refused, and scrubs it all the same", async () => {
    const page = history();
    const used = await openSession(location("#old"), page, answering(401, {}));
    expect(used).toMatchObject({ kind: "refused", message: expect.stringContaining("used or has expired") });
    expect(page.replaced).toEqual(["/"]);
    expect(await openSession(location("#t"), history(), answering(403, {}))).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("403"),
    });
    expect(await openSession(location("#t"), history(), answering(200, { nothing: true }))).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("cannot read"),
    });
    expect(await openSession(location("#t"), history(), () => Promise.reject(new TypeError("Failed to fetch")))).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("not answering"),
    });
  });
});
