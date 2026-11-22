// @vitest-environment jsdom
import type { ClientResponse } from "@tavi/client/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocale } from "../../src/lib/i18n.js";
import { ask, refusal, type SettingsClient } from "../../src/lib/ipc.js";
import { Failure, LoadError } from "../../src/ui/Parts.js";
import { mount, unmountAll } from "../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An owner's refusal with a key is said in the page's language; one without a key, or with a key this page does not know, in its English. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const answering = (response: ClientResponse): SettingsClient => ({ request: () => Promise.resolve(response) });

const keyed: ClientResponse = {
  ok: false,
  error: {
    code: "NOT_FOUND",
    message: "Reminder rem-1 does not exist",
    i18n: { key: "error.reminder.notFound", params: { reminderId: "rem-1" } },
  },
};
const unkeyed: ClientResponse = { ok: false, error: { code: "INTERNAL", message: "the database is locked" } };
const unknownKey: ClientResponse = {
  ok: false,
  error: { code: "NOT_FOUND", message: "Something a newer owner said", i18n: { key: "error.from.a.newer.owner" } },
};

describe("owner refusals in the canvas", () => {
  it("shows a keyed refusal in Bulgarian and an unkeyed one in its English", async () => {
    const said = await ask(answering(keyed), "reminders", { action: "get", reminderId: "rem-1" });
    const plain = await ask(answering(unkeyed), "reminders", { action: "list" });
    if (said.ok || plain.ok) throw new Error("expected refusals");
    expect(said.code).toBe("NOT_FOUND");
    const page = await mount(
      <>
        <Failure message={said.message} />
        <LoadError error={plain.message} reload={() => {}} />
      </>,
    );
    const text = page.textContent ?? "";
    expect(text).not.toContain("Reminder rem-1 does not exist");
    expect(text).toContain("Напомнянето rem-1 не съществува");
    expect(text).toContain("the database is locked");
  });

  it("falls back to the English for a key this page does not know", async () => {
    const said = await ask(answering(unknownKey), "reminders", { action: "list" });
    expect(said.ok ? undefined : said.message).toBe("Something a newer owner said");
    expect(refusal(unknownKey, "fallback")).toBe("Something a newer owner said");
    expect(refusal({}, "fallback")).toBe("fallback");
  });

  it("says a keyed refusal in English when the page speaks English", async () => {
    await setLocale("en");
    expect(refusal(keyed, "fallback")).toBe("Reminder rem-1 does not exist");
  });
});
