import type { AdmissionRecord } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { stateOf } from "../../src/features/chat-panel/Activity.js";
import { effectLabel } from "../../src/features/chat/ApprovalParts.js";
import { networkModeLabel, runModeLabel } from "../../src/features/routines/api.js";
import { reviewStateLabel, statusLabel } from "../../src/lib/format.js";
import { setLocale } from "../../src/lib/i18n.js";

/** The owner's status, mode and effect codes in words: English as the code reads, Bulgarian in the catalogue's words, an unknown code as it arrives. */

afterEach(async () => {
  await setLocale("en");
});

const admission = (status: "completed" | "stopped" | "failed"): AdmissionRecord =>
  ({ state: "committed", result: { status, finalText: "" } }) as unknown as AdmissionRecord;

describe("the owner's codes in English", () => {
  it("read as the code, dashes as spaces", () => {
    expect(statusLabel("succeeded")).toBe("succeeded");
    expect(statusLabel("setup-needed")).toBe("setup needed");
    expect(statusLabel("paused-failures")).toBe("paused failures");
    expect(statusLabel("credential-blocked")).toBe("credential blocked");
    expect(reviewStateLabel("pending")).toBe("pending");
    for (const state of ["proposed", "approved", "rejected", "withheld", "removed", "disabled"])
      expect(reviewStateLabel(state)).toBe(state);
    expect(runModeLabel("production")).toBe("production");
    expect(runModeLabel("preview")).toBe("preview");
    for (const mode of ["allowlist", "primary_sources", "custom_hosts", "open_web"]) expect(networkModeLabel(mode)).toBe(mode);
    for (const effect of ["read-only", "mutating", "external"]) expect(effectLabel(effect)).toBe(effect);
    expect(stateOf(admission("completed"), false)).toBe("completed");
    expect(stateOf(admission("stopped"), false)).toBe("stopped");
    expect(stateOf(admission("failed"), false)).toBe("failed");
  });

  it("show a code the canvas does not know as it arrives", () => {
    expect(statusLabel("foo-bar")).toBe("foo bar");
    expect(statusLabel("constructor")).toBe("constructor");
    expect(reviewStateLabel("held-back")).toBe("held back");
    expect(runModeLabel("dry_run")).toBe("dry_run");
    expect(networkModeLabel("constructor")).toBe("constructor");
    expect(effectLabel("toString")).toBe("toString");
  });
});

describe("the owner's codes in Bulgarian", () => {
  it("name states in the catalogue's words", async () => {
    await setLocale("bg");
    expect(statusLabel("setup-needed")).toBe("иска настройка");
    expect(statusLabel("credential-blocked")).toBe("иска вход");
    expect(reviewStateLabel("pending")).toBe("чака преглед");
    expect(reviewStateLabel("withheld")).toBe("задържано");
    expect(statusLabel("proposed")).toBe("предложено");
    expect(statusLabel("approved")).toBe("одобрено");
    expect(runModeLabel("preview")).toBe("пробно");
    expect(networkModeLabel("open_web")).toBe("цялата мрежа");
    expect(effectLabel("read-only")).toBe("само за четене");
    expect(effectLabel("mutating")).toBe("променя данни");
    expect(effectLabel("external")).toBe("излиза навън");
    expect(stateOf(admission("completed"), false)).toBe("завършен");
    expect(stateOf(admission("stopped"), false)).toBe("спрян");
    expect(statusLabel("foo-bar")).toBe("foo bar");
  });
});
