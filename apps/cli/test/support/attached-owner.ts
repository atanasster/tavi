import type { ClientEvent, ModelOutcome, ModelPort } from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createFixtureSandbox } from "@tavi/test-support/sandbox";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach } from "vitest";

import type { OwnerModelTarget } from "../../src/features/run/owner.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "./serve-fixture.js";

/**
 * A live `tavi serve` for the attached-CLI suites: owners,
 * their directories and the clients attached to them, torn down after each
 * test, plus the output capture and model fixtures those suites share.
 */

/** Each attached command spends about a second discovering its owner; suites that run several need longer. */
export const ATTACHED = { timeout: 30_000 };

export interface AttachedOwners {
  tempDirectory(): string;
  /**
   * Serve `model` on a new directory, or on `directory` (a restart). `review`
   * gates only mutating tools, so an external `sandbox.run` goes straight to its
   * archived-output review.
   */
  startOwner(
    model: ModelPort,
    options?: { readonly directory?: string; readonly modelTarget?: OwnerModelTarget; readonly review?: boolean },
  ): Promise<{ readonly handle: ServeHandle; readonly directory: string }>;
  /** Shut the most recently started owner down, as a restart does. */
  stopLatest(reason: string): Promise<void>;
  /** A client attached to the owner of `handle`, closed after the test. */
  attach(handle: ServeHandle): Promise<IpcClient>;
}

/** Register the teardown and return the helpers; call once, at a suite's top level. */
export function useAttachedOwners(prefix: string): AttachedOwners {
  const directories = temporaryDirectories({ prefix });
  const handles: ServeHandle[] = [];
  const clients: IpcClient[] = [];

  afterEach(async () => {
    while (clients.length > 0) clients.pop()?.close();
    while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
    directories.cleanup();
  });

  const tempDirectory = (): string => directories.create();

  return {
    tempDirectory,
    async startOwner(model, options = {}) {
      const directory = options.directory ?? tempDirectory();
      const handle = await serve(
        fixtureServeOptions(directory, {
          defaultConnectionId: "fixture-conn",
          // A reviewed artifact comes from `fixture.capture`, a dev-only tool, as `browser.capture` makes one.
          ...(options.review === true ? { approvalRequiredFor: ["mutating" as const], devFixtureTools: true } : {}),
        }),
        {
          dataDirectory: directory,
          drainDeadlineMs: 5_000,
          ...(options.modelTarget === undefined ? {} : { modelTarget: options.modelTarget }),
        },
        { stdout: () => {}, stderr: () => {}, isTty: false },
        { modelOverride: model, browserOverride: createFixtureBrowser(), sandboxOverride: createFixtureSandbox({ mode: "echo" }) },
      );
      handles.push(handle);
      return { handle, directory };
    },
    async stopLatest(reason) {
      await handles.pop()?.shutdown(reason);
    },
    async attach(handle) {
      const owner = await findLiveOwner(handle.runtime.dataDirectory);
      if (owner === undefined) throw new Error("serve did not publish discovery");
      const client = await createIpcClient(owner);
      clients.push(client);
      return client;
    },
  };
}

export { capture } from "@tavi/test-support";

/** A model that calls `fixture.capture`, which makes an artifact a person must review, then answers `answer`. */
export function capturing(answer: string, blockId = "b-answer"): ModelPort {
  return {
    async stream(request, options) {
      if (!request.messages.some((message) => (message.toolResults?.length ?? 0) > 0)) {
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: "call-a", name: "fixture.capture", input: {} }],
          finishReason: "tool-calls",
          usage: {},
        };
      }
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId, text: answer });
      return { status: "completed", attemptId: request.attemptId, text: answer, toolCalls: [], usage: {} };
    },
  };
}

/** Gated browser calls, one per listed id, one per turn — each turn held until `hold` settles, when given — then an answer. */
export function turns(ids: readonly string[], hold?: Promise<void>): ModelPort {
  let calls = 0;
  return {
    async stream(request, options): Promise<ModelOutcome> {
      const index = calls;
      calls += 1;
      if (hold !== undefined) await hold;
      const id = ids[index];
      if (id === undefined) {
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `b-${index}`, text: "done" });
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      }
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: "",
        toolCalls: [{ id, name: "browser.create_session", input: {} }],
        finishReason: "tool-calls",
        usage: {},
      };
    },
  };
}

export const ndjson = (text: string): ClientEvent[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClientEvent);
