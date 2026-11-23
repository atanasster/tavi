import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { modelActions } from "../../../src/features/settings/models-api.js";
import { setLocale } from "../../../src/lib/i18n.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";

/** A model's video disclosure, asked before it is turned on: said in the page's language from the provider the owner names. */

const refusing = (details: Record<string, unknown>): SettingsClient => ({
  request: async () =>
    ({
      ok: false,
      error: { code: "INVALID_INPUT", message: "English message. Confirm it to turn video on (tavi models video --yes).", details },
    }) as never,
});

const ENGLISH = "Each video goes whole to OpenRouter.";

beforeAll(async () => {
  await setLocale("bg");
});
afterAll(async () => {
  await setLocale("en");
});

describe("the video disclosure", () => {
  it("is said in Bulgarian on a Bulgarian page", async () => {
    const outcome = await modelActions.setVideo(refusing({ disclosure: ENGLISH, provider: "OpenRouter" }), "router", "qwen/vl", true);
    expect(outcome.ok).toBe(false);
    const disclosure = "disclosure" in outcome ? outcome.disclosure : "";
    expect(disclosure).toContain("OpenRouter");
    expect(disclosure).toContain("qwen/vl");
    expect(disclosure).toMatch(/\p{Script=Cyrillic}/u);
  });

  it("is the owner's English from an owner that names no provider, and on an English page", async () => {
    const older = await modelActions.setVideo(refusing({ disclosure: ENGLISH }), "router", "qwen/vl", true);
    expect("disclosure" in older ? older.disclosure : "").toBe(ENGLISH);
    await setLocale("en");
    const english = await modelActions.setVideo(refusing({ disclosure: ENGLISH, provider: "OpenRouter" }), "router", "qwen/vl", true);
    expect("disclosure" in english ? english.disclosure : "").toBe(ENGLISH);
    await setLocale("bg");
  });
});
