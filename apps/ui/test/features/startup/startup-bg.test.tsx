import type { TaviClient } from "@tavi/client/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openSession, type SessionFetch } from "../../../src/features/startup/session.js";
import { startPage, type PageHost } from "../../../src/features/startup/start.js";
import { setLocale } from "../../../src/lib/i18n.js";

/** The page's start in Bulgarian: every line it shows in place of the canvas, and no English left in them. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  await setLocale("en");
});

const location = (hash: string) => ({ origin: "http://127.0.0.1:4100", pathname: "/", hash });
const noHistory = { replaceState: () => undefined };
const answering =
  (status: number, body: unknown): SessionFetch =>
  () =>
    Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });

function host(overrides: Partial<PageHost> & { readonly hash?: string } = {}) {
  const messages: string[] = [];
  const page: PageHost = {
    location: location(overrides.hash ?? "#tok"),
    history: noHistory,
    fetch: answering(200, { secret: "s3cret" }),
    connect: () => Promise.resolve({ state: "ready" } as unknown as TaviClient),
    message: (text) => void messages.push(text),
    render: () => undefined,
    ...overrides,
  };
  return { page, messages };
}

const ENGLISH = [
  "Connecting to the owner",
  "Open this page from the link",
  "Could not reach the owner",
  "used or has expired",
  "cannot read",
  "not answering",
];

describe("the page's start in Bulgarian", () => {
  it("says why a link was refused", async () => {
    const refusals = [
      await openSession(location("#old"), noHistory, answering(401, {})),
      await openSession(location("#t"), noHistory, answering(403, {})),
      await openSession(location("#t"), noHistory, answering(200, { nothing: true })),
      await openSession(location("#t"), noHistory, () => Promise.reject(new TypeError("Failed to fetch"))),
    ].map((outcome) => (outcome.kind === "refused" ? outcome.message : outcome.kind));
    expect(refusals).toEqual([
      "Този линк вече е използван или е изтекъл. За нова натисни Enter там, където работи `tavi ui`.",
      "tavi ui отказа линка (403).",
      "tavi ui отговори във вид, който тази страница не може да прочете. Отвори я отново от нов линк.",
      "tavi ui не отговаря. Още ли работи?",
    ]);
    for (const text of refusals) for (const word of ENGLISH) expect(text).not.toContain(word);
  });

  it("says what it is doing, and why it stopped", async () => {
    const started = host();
    await startPage(started.page);
    expect(started.messages).toEqual(["Свързвам се със сървъра на Tavi…"]);

    const none = host({ hash: "" });
    await startPage(none.page);
    expect(none.messages).toEqual(["Отвори тази страница от линка, който ти дава `tavi ui`. За нова натисни Enter там, където работи."]);

    const unreachable = host({ connect: () => Promise.reject(new Error("boom")) });
    await startPage(unreachable.page);
    expect(unreachable.messages.at(-1)).toBe("Не успях да се свържа със сървъра на Tavi: boom");

    for (const text of [...started.messages, ...none.messages, ...unreachable.messages])
      for (const word of ENGLISH) expect(text).not.toContain(word);
  });
});
