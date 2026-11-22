import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ConnectableApp } from "@tavi/contracts";

import { andList, keptByWords, lendingAccess } from "../../../src/features/apps/model.js";
import { setLocale } from "../../../src/lib/i18n.js";

const FIXTURE = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "generic-apps.json"), "utf8")) as {
  readonly apps: readonly ConnectableApp[];
};
const TOOL = FIXTURE.apps.flatMap((app) => app.tools)[0] as ConnectableApp["tools"][number];

/** An app whose tools do these kinds of things. */
function withTools(...access: ConnectableApp["tools"][number]["access"][]): Pick<ConnectableApp, "tools"> {
  return { tools: access.map((kind) => ({ ...TOOL, access: kind })) };
}

afterEach(async () => {
  await setLocale("en");
});

describe("names joined as one list", () => {
  it("joins English names as before", () => {
    expect(andList([])).toBe("");
    expect(andList(["Gmail"])).toBe("Gmail");
    expect(andList(["Gmail", "Calendar"])).toBe("Gmail and Calendar");
    expect(andList(["Gmail", "Calendar", "Drive"])).toBe("Gmail and Calendar and Drive");
  });

  it("joins Bulgarian names with commas and „и“ before the last", async () => {
    await setLocale("bg");
    expect(andList([])).toBe("");
    expect(andList(["Gmail"])).toBe("Gmail");
    expect(andList(["Gmail", "Calendar"])).toBe("Gmail и Calendar");
    expect(andList(["Gmail", "Calendar", "Drive"])).toBe("Gmail, Calendar и Drive");
  });
});

describe("who keeps a provider's grant after a disconnect", () => {
  it("names the provider, and says „it“ or „them“ by how many apps keep it", () => {
    expect(keptByWords(["Gmail"], "Google")).toBe(
      "Gmail stays connected; Google will still list Tavi under your account until you disconnect it too",
    );
    expect(keptByWords(["Gmail", "Calendar"], "Google")).toBe(
      "Gmail and Calendar stays connected; Google will still list Tavi under your account until you disconnect them too",
    );
  });

  it("says the provider in lowercase mid-sentence when it is not named", async () => {
    expect(keptByWords(["Gmail"], undefined)).toContain("; the provider will still list Tavi");
    await setLocale("bg");
    expect(keptByWords(["Gmail"], undefined)).toBe(
      "Gmail остава свързано; доставчикът ще показва Tavi в акаунта ти, докато не прекъснеш и него",
    );
  });
});

describe("what lending an account lets people ask for", () => {
  it("is the most its tools do: read, change, or send", () => {
    expect(lendingAccess(withTools())).toBe("read");
    expect(lendingAccess(withTools("read"))).toBe("read");
    expect(lendingAccess(withTools("read", "change"))).toBe("change");
    expect(lendingAccess(withTools("change", "send", "read"))).toBe("send");
  });
});
