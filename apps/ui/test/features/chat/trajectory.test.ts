import { expect, it } from "vitest";
import { durationBand, retainedBytes } from "../../../src/features/chat/Trajectory.js";
import type { ToolCard } from "@tavi/client/browser";
it("marks only the 50% and 75% duration thresholds", () => {
  expect(durationBand(499, 1000)).toBe("");
  expect(durationBand(500, 1000)).toBe("notable");
  expect(durationBand(749, 1000)).toBe("notable");
  expect(durationBand(750, 1000)).toBe("major");
  expect(durationBand(undefined, 1000)).toBe("");
  expect(durationBand(100, 0)).toBe("");
});
it("counts retained payload bytes without inventing bytes for absent payloads", () => {
  const card: ToolCard = { kind: "tool", key: "c", attemptId: "a", callId: "c", toolName: "t", status: "completed" };
  expect(retainedBytes(card)).toBe(0);
  expect(retainedBytes({ ...card, input: "é" })).toBe(4);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(retainedBytes({ ...card, input: cyclic })).toBeUndefined();
});
