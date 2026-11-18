// @vitest-environment jsdom
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import type { ClientResponse, ClientState, Opened, RunOptions, Subscription, TaviClient } from "@tavi/client/browser";
import { CLIENT_PROTOCOL_VERSION, type ClientEvent } from "@tavi/contracts";
import { act, Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { App } from "../../../src/App.js";
import { markdownReady } from "../../../src/ui/Markdown.js";
import { MEASURED, UNMEASURED } from "../../../src/features/shell/metrics.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { createCanvasStore } from "../../../src/features/chat/store/store.js";
import type { CanvasClient, CanvasScheduler } from "../../../src/features/chat/store/types.js";
import { instrumentRenders } from "../../../src/features/transcript/ToolCards.js";
import { mount } from "../../support/dom.js";

/**
 * The canvas's render budget, the TUI's in spirit
 * (`apps/cli/test/tui/chat-command.test.ts`) but measuring what jsdom actually
 * has — which is not layout and not paint. A scripted session of 10,000
 * deltas and 200 tool cards asserts:
 *
 *  (a) how many times the **store flushed** — the batch is what keeps
 *      this far below the number of events;
 *  (b) how many **React commits** the page made, through a `Profiler`, with
 *      the script driving one `act()` per frame so a commit is a commit rather
 *      than one coalesced batch for the whole stream;
 *  (c) that a delta **re-renders nothing but the answer it appends to**, through
 *      a per-entry render counter (not a DOM check: React writes no mutation when a wasted
 *      re-render produces identical output, so an observer sees nothing);
 *  (d) retained heap after a forced collection, with the collector acquired at
 *      run time as `apps/cli/test/tui/chat-store.test.ts` does, since the suite
 *      does not run under `--expose-gc`.
 *
 * It is the brake on the inspector's "just one more panel". The
 * acceptance check for (c) is that dropping `memo` from `Tool`, `ToolGroup` or
 * `Entry` in `Transcript.tsx` turns it red.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DELTAS = 10_000;
const TOOL_CARDS = 200;
/** Events between the frames the script serves, as a browser would serve one under a stream. */
const PER_FRAME = 250;

/** The collector, exposed at run time: the suite does not run under `--expose-gc`. */
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

/** Heap held now, measured after a collection so what is merely uncollected is not counted. */
function heap(): number {
  collect();
  return process.memoryUsage().heapUsed;
}

afterEach(() => {
  instrumentRenders(undefined);
});

/** A scheduler the script drives: frames and timers are served when it says so. */
function scripted(): {
  readonly scheduler: CanvasScheduler;
  paint: () => void;
  /** Advance the clock, firing the timers that come due — a tab given no frames. */
  tick: (ms: number) => void;
  readonly frames: () => number;
} {
  let clock = 0;
  let waiting: (() => void)[] = [];
  let timers: { at: number; run: () => void }[] = [];
  let served = 0;
  return {
    scheduler: {
      frame: (callback) => {
        waiting.push(callback);
        return () => (waiting = waiting.filter((pending) => pending !== callback));
      },
      timer: (ms, callback) => {
        const entry = { at: clock + ms, run: callback };
        timers.push(entry);
        return () => (timers = timers.filter((pending) => pending !== entry));
      },
      // Read, not advanced by reading: the store reads it once per deferred
      // event, and a clock that ticked per read would make the flush ceiling
      // fire on a count of events rather than on elapsed time.
      now: () => clock,
    },
    paint: () => {
      served += 1;
      const due = waiting;
      waiting = [];
      for (const callback of due) callback();
    },
    tick: (ms: number) => {
      clock += ms;
      const due = timers.filter((entry) => entry.at <= clock);
      timers = timers.filter((entry) => entry.at > clock);
      for (const entry of due) entry.run();
    },
    frames: () => served,
  };
}

/** A client that answers nothing and hands the script the run's event sink. */
function scriptClient(): { readonly client: CanvasClient; readonly emit: () => ((event: ClientEvent) => void) | undefined } {
  let sink: ((event: ClientEvent) => void) | undefined;
  const subscription = { close: () => Promise.resolve() } as unknown as Subscription;
  const client: CanvasClient = {
    state: "ready" as ClientState,
    failure: undefined,
    onState: () => () => undefined,
    run: (_payload: unknown, options: RunOptions) => {
      sink = options.onEvent;
      return Promise.resolve({ response: { ok: true, result: { taskId: "task-1" } } as ClientResponse, subscription } as Opened);
    },
    subscribe: () => Promise.resolve({ response: { ok: true, result: {} } as ClientResponse, subscription } as Opened),
    request: () => new Promise<never>(() => undefined),
  } as unknown as CanvasClient;
  return { client, emit: () => sink };
}

const silent: SettingsClient = { request: () => new Promise<never>(() => undefined) } as unknown as Pick<TaviClient, "request">;

let sequence = 0;
const event = (kind: string, fields: Record<string, unknown> = {}): ClientEvent =>
  ({
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "epoch-1",
    sequence: sequence++,
    runId: "task-1",
    attemptId: "attempt-1",
    at: "2026-09-20T12:00:00.000Z",
    kind,
    ...fields,
  }) as ClientEvent;

/** A page with a store the script feeds, and the sink it feeds it through. */
async function page(options: { readonly onRender?: ProfilerOnRenderCallback } = {}): Promise<{
  readonly host: HTMLElement;
  readonly send: (event: ClientEvent) => void;
  readonly clock: ReturnType<typeof scripted>;
  readonly flushes: () => number;
}> {
  sequence = 0;
  const clock = scripted();
  const { client, emit } = scriptClient();
  let flushes = 0;
  const store = createCanvasStore(client, {
    workspaceId: "default",
    principal: "operator",
    mintKey: () => "ui-1",
    scheduler: clock.scheduler,
  });
  store.subscribe(() => (flushes += 1));
  const canvas = <App store={store} client={silent} workspaceId="default" />;
  const mounted = await mount(
    options.onRender === undefined ? (
      canvas
    ) : (
      <Profiler id="canvas" onRender={options.onRender}>
        {canvas}
      </Profiler>
    ),
  );
  await act(async () => store.submit("replay a long answer"));
  const sink = emit();
  expect(sink, "the run never opened, so nothing was measured").toBeDefined();
  return { host: mounted, send: sink ?? (() => undefined), clock, flushes: () => flushes };
}

/**
 * The two stream tests replay 10,000 deltas through the real canvas: about 2 s
 * alone, and several times that while turbo runs every package's suite at once,
 * so Vitest's 5 s default cut them off mid-run (as apps/cli's integration tests
 * were). They measure commits, frames and retained memory, never time.
 */
const STREAM_TIMEOUT_MS = 30_000;

describe("the render budget", () => {
  // The Markdown renderer is its own chunk; its one-time arrival is not a
  // commit the stream caused.
  beforeAll(() => markdownReady);

  it("draws 10,000 deltas and 200 tool cards in frames, not in events", { timeout: STREAM_TIMEOUT_MS }, async () => {
    let commits = 0;
    let work = 0;
    const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      commits += 1;
      work += actualDuration;
    };
    const { host: shown, send, clock, flushes } = await page({ onRender });
    const before = { flushes: flushes(), commits };

    await act(async () => send(event("run.started", { threadId: "thread-1", workspaceId: "default" })));
    // One `act` per frame, so React commits per frame rather than coalescing
    // the whole stream into one — a single `act` around the script would pin
    // the commit count at 1 and no regression could move it.
    for (let start = 0; start < DELTAS; start += PER_FRAME) {
      await act(async () => {
        for (let index = start; index < Math.min(start + PER_FRAME, DELTAS); index += 1) {
          send(event("text.delta", { blockId: "b", text: `w${index} ` }));
          if (index % (DELTAS / TOOL_CARDS) === 0) {
            const callId = `c${index}`;
            send(event("tool.started", { blockId: `tb${index}`, callId, toolName: "sandbox.run", input: { command: `step ${index}` } }));
            send(event("tool.completed", { callId, toolName: "sandbox.run", output: "ok", durationMs: 12 }));
          }
        }
        clock.paint();
      });
    }
    await act(async () => {
      send(event("task.completed", { finalText: "done" }));
      clock.paint();
    });

    const events = DELTAS + TOOL_CARDS * 2 + 2;
    const flushed = flushes() - before.flushes;
    // (a) The batch is what keeps this far below one flush per event: the
    // blocking kinds bypass it, and everything else waits for a frame. 40
    // frames plus `run.started` and `task.completed` is the shape expected.
    expect(flushed, `flushed ${flushed} times for ${events} events`).toBeGreaterThan(DELTAS / PER_FRAME - 1);
    expect(flushed).toBeLessThan(DELTAS / PER_FRAME + 8);
    // (b) And React commits about once per flush, never once per event.
    const committed = commits - before.commits;
    expect(committed, `committed ${committed} times`).toBeGreaterThan(DELTAS / PER_FRAME - 1);
    expect(committed).toBeLessThanOrEqual(flushed + 2);
    // Everything arrived: the budget is about how it was drawn, not what was dropped.
    expect(shown.querySelector(".runs")?.textContent).toContain(`w${DELTAS - 1}`);
    expect(shown.querySelector(".runs")?.textContent).toContain("Worked · 200 steps");
    expect(work).toBeGreaterThan(0);
  });

  it("re-renders nothing but the answer a delta appends to", async () => {
    const { send, clock } = await page();
    await act(async () => {
      send(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      send(event("text.delta", { blockId: "b", text: "start " }));
      for (let index = 0; index < TOOL_CARDS; index += 1) {
        const callId = `c${index}`;
        send(event("tool.started", { blockId: `tb${index}`, callId, toolName: "sandbox.run", input: { command: `step ${index}` } }));
        send(event("tool.completed", { callId, toolName: "sandbox.run", output: "ok", durationMs: 5 }));
      }
      clock.paint();
    });

    // (c) One more delta, with every entry's renders counted. A `MutationObserver`
    // cannot serve here: a wasted re-render of a tool card produces identical
    // DOM and so no mutation record at all.
    const renders = new Map<string, number>();
    instrumentRenders((key) => renders.set(key, (renders.get(key) ?? 0) + 1));
    await act(async () => {
      send(event("text.delta", { blockId: "b", text: "and more " }));
      clock.paint();
    });
    instrumentRenders(undefined);

    const rendered = [...renders.entries()].filter(([, count]) => count > 0);
    // The answer's own entry re-rendered, because its text changed…
    expect(rendered.length, "no entry rendered at all: the counter is not wired").toBeGreaterThan(0);
    // …and nothing else did. A page without `memo` on the transcript's
    // components re-renders all 200 cards here, which is what this catches.
    const wasted = rendered.filter(([key]) => key.includes("c") && !key.includes("b"));
    expect(
      wasted.map(([key, count]) => `${key}×${count}`),
      `${wasted.length} entries re-rendered for one delta`,
    ).toEqual([]);
    expect(rendered).toHaveLength(1);
  });

  it("repaints a tab given no frames at all, on the coalescing timer", async () => {
    const { host: shown, send, clock, flushes } = await page();
    await act(async () => send(event("run.started", { threadId: "thread-1", workspaceId: "default" })));
    const before = flushes();
    await act(async () => send(event("text.delta", { blockId: "b", text: "unseen" })));
    // Deferred, and no frame is coming: the snapshot is current, the page is not.
    expect(flushes()).toBe(before);
    expect(shown.querySelector(".runs")?.textContent).not.toContain("unseen");
    await act(async () => clock.tick(250));
    expect(flushes()).toBe(before + 1);
    expect(shown.querySelector(".runs")?.textContent).toContain("unseen");
    expect(clock.frames()).toBe(0);
  });

  it("keeps what a long stream retains bounded", { timeout: STREAM_TIMEOUT_MS }, async () => {
    const { send, clock } = await page();
    const before = heap();
    await act(async () => send(event("run.started", { threadId: "thread-1", workspaceId: "default" })));
    for (let start = 0; start < DELTAS; start += PER_FRAME) {
      await act(async () => {
        for (let index = start; index < Math.min(start + PER_FRAME, DELTAS); index += 1)
          send(event("text.delta", { blockId: "b", text: `w${index} ` }));
        clock.paint();
      });
    }
    const retained = heap() - before;
    // 10,000 deltas of ~7 bytes fold into one block of ~70 KB of text. What is
    // retained beyond that is React's tree and jsdom's nodes for *one*
    // paragraph — a page keeping a node per token would be orders past this.
    expect(retained, `retained ${(retained / 2 ** 20).toFixed(1)} MiB`).toBeLessThan(16 * 2 ** 20);
  });
});

describe("what a reply's footer may say", () => {
  it("names a source for every figure it shows, and a reason for every one it does not", () => {
    for (const figure of [...MEASURED, ...UNMEASURED]) {
      expect(figure.name, "a figure with no name").not.toBe("");
      expect(figure.source, `${figure.name} has no stated source`).not.toBe("");
    }
    expect(MEASURED.map((figure) => figure.name)).toEqual(["time", "model", "tool calls"]);
    expect(UNMEASURED.map((figure) => figure.name)).toEqual(["cost", "context %", "tok/s"]);
  });

  it("shows no unmeasured figure under a reply, in any spelling of it", async () => {
    const { host: shown, send, clock } = await page();
    await act(async () => {
      send(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      send(event("text.delta", { blockId: "b", text: "an answer" }));
      send(
        event("task.completed", {
          at: "2026-09-20T12:00:42.000Z",
          finalText: "an answer",
          metrics: { models: ["ollama/gemma4-32k:latest"], totalTokens: 22_400, partial: false },
        }),
      );
      clock.paint();
    });
    const strip = shown.querySelector(".response-footer")?.textContent ?? "";
    expect(shown.querySelector(".reply-facts")).not.toBeNull();
    // Not the prose names — the shapes a figure would actually take, so
    // `ctx 42%`, `$0.03` or `128 tok/s` cannot slip past the guard.
    for (const shape of [/tok/i, /token/i, /\bctx\b/i, /%/, /\$/, /cost/i, /\bcontext\b/i, /\bper second\b/i]) {
      expect(shape.test(strip), `the footer says something matching ${String(shape)}: ${strip}`).toBe(false);
    }
  });
});
