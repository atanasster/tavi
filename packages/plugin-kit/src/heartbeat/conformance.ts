import { describe, expect, it } from "vitest";
import { settlesWithin } from "../conformance/settles.js";

import {
  HEARTBEAT_LIMITS,
  HeartbeatItemSchema,
  HeartbeatSignalSchema,
  heartbeatCollected,
  heartbeatSignalsOf,
  type HeartbeatProvider,
  type HeartbeatSignalSource,
  type HeartbeatTickRequest,
  type HeartbeatTickResult,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/**
 * The conformance suite every heartbeat provider and signal source passes
 * — built in or a plugin's. It holds them to
 * what the host relies on: answers within the contract's bounds, a stop when
 * the tick's signal aborts, no destination of their own, a sensible answer
 * when every egress switch is off, the same keys for the same input, and
 * their own secrets kept out of errors and the memo.
 *
 * Test-only: it imports vitest, so it is exported for tests and never built.
 */

/** Fields that would name where something goes: the host picks destinations, never a provider. */
const DESTINATION_FIELDS = ["connectionId", "to", "destination", "target", "targets", "channel", "chatId"];

const AT = "2026-10-11T09:00:00.000Z";
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export interface HeartbeatConformanceOptions {
  /** Secrets the provider holds (keys, tokens): none may appear in its memo or its errors. */
  readonly secrets?: readonly string[];
}

/** What a fake `host.runTurn` saw, and how it answers. */
interface TurnLog {
  readonly calls: { readonly prompt: string; readonly tools?: readonly string[]; readonly model?: string }[];
}

/** A tick request with every egress switch on, as the built-in provider receives it. */
function fullRequest(log: TurnLog, signal: AbortSignal, turn?: () => Promise<never>): HeartbeatTickRequest {
  return Object.freeze({
    wake: Object.freeze({ reason: "interval", scheduledAt: AT, now: AT, timezone: "UTC" }),
    kind: "deep",
    instructions: "Tell me if a payment fails or a renewal is due this week",
    signals: Object.freeze([
      Object.freeze({
        key: "billing:payment:pay_1",
        hash: "failed",
        title: "A payment failed: ACME invoice 1042",
        at: AT,
        source: "Billing",
      }),
    ]),
    recent: Object.freeze([]),
    memory: Object.freeze([
      Object.freeze({ recordId: "mem-1", revisionId: "rev-1", kind: "fact" as const, text: "ACME pays late but always pays" }),
    ]),
    limits: Object.freeze({
      maxItems: HEARTBEAT_LIMITS.maxItems,
      deadlineMs: 5_000,
      budgetLeft: Object.freeze({ modelTicks: 10, tokens: 100_000 }),
    }),
    host: Object.freeze({
      runTurn: async (input: { readonly prompt: string; readonly tools?: readonly string[]; readonly model?: "fast" | "main" }) => {
        log.calls.push({
          prompt: input.prompt,
          ...(input.tools === undefined ? {} : { tools: input.tools }),
          ...(input.model === undefined ? {} : { model: input.model }),
        });
        if (turn !== undefined) return await turn();
        return Object.freeze({ reported: Object.freeze([]), usage: Object.freeze({}) });
      },
      publish: () => undefined,
    }),
    signal,
  });
}

/** The same request with every egress switch off: the withheld fields are absent. */
function egressOffRequest(log: TurnLog, signal: AbortSignal): HeartbeatTickRequest {
  const { instructions: _instructions, ...rest } = fullRequest(log, signal);
  return Object.freeze({ ...rest, signals: Object.freeze([]), recent: Object.freeze([]), memory: Object.freeze([]) });
}

/** Read the answer once as plain JSON, as the host does, and hold it to the contract. */
function expectValidAnswer(answer: HeartbeatTickResult): void {
  const raw = JSON.parse(JSON.stringify(answer)) as { items?: unknown; memo?: unknown };
  expect(Array.isArray(raw.items), "items is a list").toBe(true);
  const items = raw.items as unknown[];
  expect(items.length).toBeLessThanOrEqual(HEARTBEAT_LIMITS.maxItems);
  for (const item of items) {
    expect(HeartbeatItemSchema.safeParse(item).success, JSON.stringify(item)).toBe(true);
    for (const field of DESTINATION_FIELDS) expect(Object.keys(item as object), "an item names no destination").not.toContain(field);
  }
  if (raw.memo !== undefined) {
    expect(typeof raw.memo).toBe("string");
    expect(utf8Bytes(raw.memo as string)).toBeLessThanOrEqual(HEARTBEAT_LIMITS.memoBytes);
  }
}

/** The suite for one heartbeat provider; `subject` builds a fresh one per test. */
export function describeHeartbeatConformance(
  name: string,
  subject: () => HeartbeatProvider | Promise<HeartbeatProvider>,
  options: HeartbeatConformanceOptions = {},
): void {
  describe(`heartbeat provider conformance: ${name}`, () => {
    it("answers within the contract's bounds and names no destination", async () => {
      const log: TurnLog = { calls: [] };
      expectValidAnswer(await (await subject()).tick(fullRequest(log, new AbortController().signal)));
      expect(log.calls.length).toBeLessThanOrEqual(HEARTBEAT_LIMITS.turnsPerTick);
    });

    it("answers sensibly when every egress switch is off", async () => {
      const log: TurnLog = { calls: [] };
      expectValidAnswer(await (await subject()).tick(egressOffRequest(log, new AbortController().signal)));
    });

    it("stops when its tick's signal aborts, and runs no turn after it", async () => {
      const log: TurnLog = { calls: [] };
      const controller = new AbortController();
      controller.abort(new Error("the heartbeat tick ran past its time"));
      await settlesWithin((await subject()).tick(fullRequest(log, controller.signal)), 1_000);
      expect(log.calls).toEqual([]);
    });

    it("stops in the middle of its tick when its signal aborts, and starts no turn after", async () => {
      const log: TurnLog = { calls: [] };
      const controller = new AbortController();
      // The first turn is where the deadline lands: the host aborts the tick and the turn fails.
      const request = fullRequest(log, controller.signal, async () => {
        controller.abort(new Error("the heartbeat tick ran past its time"));
        throw new Error("the heartbeat tick was stopped");
      });
      await settlesWithin((await subject()).tick(request), 1_000);
      expect(log.calls.length).toBeLessThanOrEqual(1);
    });

    it("answers the same keys for the same input", async () => {
      const keys = async () => {
        const answer = await (await subject()).tick(fullRequest({ calls: [] }, new AbortController().signal));
        return answer.items.map((item) => item.key).sort();
      };
      expect(await keys()).toEqual(await keys());
    });

    it("keeps its secrets out of its memo and its errors", async () => {
      const secrets = options.secrets ?? [];
      const answer = await (await subject()).tick(fullRequest({ calls: [] }, new AbortController().signal));
      for (const secret of secrets) expect(answer.memo ?? "").not.toContain(secret);
      // A turn that fails: whatever the provider throws or answers carries none of its secrets.
      const failing = fullRequest({ calls: [] }, new AbortController().signal, async () => {
        throw new Error("the model call failed");
      });
      let text = "";
      try {
        text = JSON.stringify(await (await subject()).tick(failing));
      } catch (error) {
        text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      }
      for (const secret of secrets) expect(text).not.toContain(secret);
    });
  });
}

export interface SignalSourceConformanceOptions {
  /** The scope collected for; defaults to the `default` workspace's `alice`. */
  readonly scope?: { readonly workspaceId: string; readonly principalId: string; readonly timezone?: string; readonly now?: string };
  /** Secrets the source holds: none may appear in what it collects or its errors. */
  readonly secrets?: readonly string[];
}

/** The suite for one signal source; `subject` builds a fresh one per test (seeding whatever it reads). */
export function describeSignalSourceConformance(
  name: string,
  subject: () => HeartbeatSignalSource | Promise<HeartbeatSignalSource>,
  options: SignalSourceConformanceOptions = {},
): void {
  const scope = (signal: AbortSignal) => ({
    workspaceId: options.scope?.workspaceId ?? "default",
    principalId: options.scope?.principalId ?? "alice",
    now: options.scope?.now ?? AT,
    timezone: options.scope?.timezone ?? "UTC",
    signal,
  });

  describe(`heartbeat signal source conformance: ${name}`, () => {
    it("names itself and answers valid signals within the bounds", async () => {
      const source = await subject();
      expect(source.id).toMatch(/^[a-z][a-z0-9-]*$/);
      const collected = heartbeatCollected(JSON.parse(JSON.stringify(await source.collect(scope(new AbortController().signal)))));
      expect(collected, "a list of signals, or a batch of them").toBeDefined();
      const signals = collected?.signals ?? [];
      expect(signals.length).toBeLessThanOrEqual(HEARTBEAT_LIMITS.signalsPerSource);
      expect(utf8Bytes(JSON.stringify(signals))).toBeLessThanOrEqual(HEARTBEAT_LIMITS.sourceBytes);
      for (const signal of signals) expect(HeartbeatSignalSchema.safeParse(signal).success, JSON.stringify(signal)).toBe(true);
    });

    it("answers the same keys and hashes for the same input", async () => {
      const source = await subject();
      const read = async () =>
        heartbeatSignalsOf(await source.collect(scope(new AbortController().signal)))
          .map((signal) => `${signal.key}#${signal.hash}`)
          .sort();
      expect(await read()).toEqual(await read());
    });

    it("stops when its signal aborts", async () => {
      const source = await subject();
      const controller = new AbortController();
      controller.abort(new Error("the signal source ran past its time"));
      await settlesWithin(source.collect(scope(controller.signal)), HEARTBEAT_LIMITS.sourceDeadlineMs);
    });

    it("keeps its secrets out of what it collects and its errors", async () => {
      const source = await subject();
      let text = "";
      try {
        text = JSON.stringify(await source.collect(scope(new AbortController().signal)));
      } catch (error) {
        text = errorMessage(error);
      }
      for (const secret of options.secrets ?? []) expect(text).not.toContain(secret);
    });
  });
}
