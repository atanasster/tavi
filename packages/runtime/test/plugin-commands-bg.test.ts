import { describe, expect, it } from "vitest";

import type { ModEnvelope } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";

import { TurnHookRegistry } from "../src/plugin-host/turn-hooks.js";

/** A plugin command's refusals are said in the language of the chat it was typed in. */

const envelope: ModEnvelope = { workspaceId: "ws", principalId: "p", taskId: "t", runId: "t", source: "cli", attended: true };
const bulgarian: ModEnvelope = { ...envelope, locale: "bg" };

describe("plugin command refusals in Bulgarian", () => {
  it("says a command that ran out of time, failed or was suspended in Bulgarian", async () => {
    const registry = new TurnHookRegistry({ budgetMs: 40, breakerLimit: 3 });
    registry.registerCommand("acme.x", [{ name: "slow", description: "Slow." }], "slow", async () => {
      await sleep(120);
      return { text: "late" };
    });
    registry.registerCommand("acme.y", [{ name: "boom", description: "Fails." }], "boom", () => {
      throw new Error("no");
    });
    expect(await registry.runCommand("slow", { envelope: bulgarian, args: "" })).toEqual({
      text: "/slow от acme.x се провали: времето ѝ изтече.",
    });
    expect(await registry.runCommand("boom", { envelope: bulgarian, args: "" })).toEqual({ text: "/boom от acme.y се провали." });
    for (let attempt = 0; attempt < 2; attempt += 1) await registry.runCommand("boom", { envelope, args: "" });
    expect(await registry.runCommand("boom", { envelope: bulgarian, args: "" })).toEqual({
      text: "/boom от acme.y е изключена: проваляше се твърде често и остава спряна до рестарт на сървъра на Tavi.",
    });
    // English, as before.
    expect(await registry.runCommand("boom", { envelope, args: "" })).toEqual({
      text: "/boom from acme.y is off: it failed too often and is suspended until the owner restarts.",
    });
  });
});
