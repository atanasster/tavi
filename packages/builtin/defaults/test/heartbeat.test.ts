import { describeHeartbeatConformance } from "@tavi/plugin-kit/heartbeat/conformance";
import { HEARTBEAT_PROMPT_SEPARATOR } from "@tavi/plugin-kit/heartbeat";
import type { HeartbeatTickRequest } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createBuiltinHeartbeatProvider } from "../src/heartbeat.js";

/** The built-in heartbeat provider. */

describeHeartbeatConformance("tavi.heartbeatagent", () => createBuiltinHeartbeatProvider());

function request(now: string, prompts: string[], signals: HeartbeatTickRequest["signals"] = []): HeartbeatTickRequest {
  return {
    wake: { reason: "interval", scheduledAt: now, now, timezone: "Europe/Sofia" },
    kind: "signal",
    instructions: "Tell me if a payment fails",
    signals,
    recent: [],
    memory: [],
    limits: { maxItems: 5, deadlineMs: 60_000, budgetLeft: { modelTicks: 10, tokens: 100_000 } },
    host: {
      runTurn: async (input) => {
        prompts.push(input.prompt);
        return { reported: [{ key: "billing:pay_1", urgency: "now" }], usage: {} };
      },
      publish: () => undefined,
    },
    signal: new AbortController().signal,
  };
}

describe("the built-in heartbeat provider", () => {
  it("runs one turn on the fast model and returns nothing of its own: the host delivers what the turn reported", async () => {
    const prompts: string[] = [];
    let model: string | undefined;
    const answer = await createBuiltinHeartbeatProvider().tick({
      ...request("2026-10-11T09:00:00.000Z", prompts),
      host: {
        runTurn: async (input) => {
          prompts.push(input.prompt);
          model = input.model;
          return { reported: [], usage: {} };
        },
        publish: () => undefined,
      },
    });
    expect(answer).toEqual({ items: [] });
    expect(prompts).toHaveLength(1);
    expect(model).toBe("fast");
  });

  it("sends two ticks with the same instructions a byte-identical prefix", async () => {
    const prompts: string[] = [];
    const provider = createBuiltinHeartbeatProvider();
    await provider.tick(request("2026-10-11T09:00:00.000Z", prompts));
    await provider.tick(
      request("2026-10-11T09:30:00.000Z", prompts, [
        { key: "test:a", hash: "1", title: "Something changed", at: "2026-10-11T09:20:00.000Z", source: "Test" },
      ]),
    );
    const [first, second] = prompts.map((prompt) => prompt.split(HEARTBEAT_PROMPT_SEPARATOR));
    expect(first?.[0]).toBe(second?.[0]);
    expect(first?.[1]).not.toBe(second?.[1]);
    expect(first?.[0]).not.toContain("2026-10-11");
  });

  it("refuses a tick whose signal already aborted, without a turn", async () => {
    const prompts: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error("the heartbeat tick ran past its time"));
    await expect(
      createBuiltinHeartbeatProvider().tick({ ...request("2026-10-11T09:00:00.000Z", prompts), signal: controller.signal }),
    ).rejects.toThrow("ran past its time");
    expect(prompts).toEqual([]);
  });
});
