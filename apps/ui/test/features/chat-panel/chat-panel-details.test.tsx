// @vitest-environment jsdom
import { initialRunState, type RunState } from "@tavi/client/browser";
import { act, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { Details, modelsUsed, usage } from "../../../src/features/chat-panel/Details.js";
import { chatVersion } from "../../../src/features/chat-panel/load.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import type { Session } from "../../../src/features/shell/shell.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, mountSettled, rerender, unmountAll } from "../../support/dom.js";

/** `node` mounted, and one microtask turn let run in an act: the view is drawn within it. */
const mount = (node: ReactNode) => mountSettled(node, () => flush(1, 0));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tool = (callId: string, model?: string): RunState["transcript"][number] => ({
  kind: "tool",
  key: callId,
  attemptId: "a1",
  callId,
  toolName: "web.search",
  ...(model === undefined ? {} : { model }),
  status: "completed",
});

const session = (transcript: RunState["transcript"] = []): Session => ({
  key: "task-1",
  taskId: "task-1",
  title: "Audit the site",
  status: "completed",
  runs: [
    {
      id: "ui-1",
      prompt: "Audit the site",
      run: { ...initialRunState(), taskId: "task-1", status: "completed", transcript },
      roundCalls: {},
      deciding: undefined,
      aborting: false,
    },
  ],
});

const at = "2026-10-01T10:00:00.000Z";
const browserRow = (sessionId: string, taskId: string, lastTitle: string | null, host: string | null) => ({
  sessionId,
  taskId,
  principalId: "operator",
  openedAt: at,
  closedAt: null,
  closeReason: null,
  live: true,
  lastUrl: host === null ? null : `https://${host}/`,
  host,
  lastTitle,
  pages: 1,
  durationMs: 10,
});

const ARTIFACTS = {
  rows: [
    { artifactId: "art-1", workspaceId: "default", runId: "task-1", contentType: "image/png", byteSize: 4, reviewState: "approved" },
    { artifactId: "art-2", workspaceId: "default", runId: "task-2", contentType: "image/png", byteSize: 4, reviewState: "approved" },
  ],
  nextCursor: "more",
};
const BROWSER = { items: [browserRow("b1", "task-1", "Pricing", "example.com"), browserRow("b2", "task-2", "Elsewhere", "other.org")] };

function owner(
  answers: { readonly artifacts?: unknown; readonly browser?: unknown } = { artifacts: ARTIFACTS, browser: BROWSER },
): SettingsClient & { readonly sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    request: async (command, payload) => {
      sent.push(command);
      // The owner lists one task's browser sessions when asked by task.
      const taskId = (payload as { readonly taskId?: string }).taskId;
      const browser =
        answers.browser === BROWSER && taskId !== undefined
          ? { items: BROWSER.items.filter((item) => item.taskId === taskId) }
          : answers.browser;
      const answer = command === "artifacts" ? answers.artifacts : command === "browser" ? browser : undefined;
      return answer === undefined
        ? { ok: false, error: { code: "UNAVAILABLE", message: `${command} is unavailable` } }
        : { ok: true, result: answer };
    },
  } as SettingsClient & { readonly sent: string[] };
}

describe("the chat panel's Details tab", () => {
  it("names the models that requested the chat's calls, once each, in the order they were seen", () => {
    expect(modelsUsed(session([tool("c1", "gpt-5"), tool("c2"), tool("c3", "claude-opus"), tool("c4", "gpt-5")]))).toEqual([
      "gpt-5",
      "claude-opus",
    ]);
  });

  it("shows provider usage once reported: a recorded chat's totals, else the last execution's", async () => {
    expect(usage(session())).toBeUndefined();
    const reported = session();
    const live: Session = {
      ...reported,
      runs: [
        { ...reported.runs[0]!, run: { ...reported.runs[0]!.run, metrics: { models: ["local/model"], totalTokens: 1234, partial: true } } },
      ],
    };
    expect(usage(live)).toEqual({ scope: "last execution", models: ["local/model"], tokens: "at least 1,234 (partial)" });
    const recorded: Session = {
      ...live,
      runs: [
        { ...live.runs[0]!, recordedHistory: { metrics: { models: ["m"], totalTokens: 9, partial: false }, partial: false, tools: [] } },
      ],
    };
    expect(usage(recorded)?.scope).toBe("this chat");
    // A follow-up turn that has not reported yet keeps the previous turn's figures.
    const followUp: Session = {
      ...live,
      runs: [...live.runs, { ...reported.runs[0]!, id: "ui-2", run: { ...reported.runs[0]!.run, status: "running" } }],
    };
    expect(usage(followUp)?.tokens).toBe("at least 1,234 (partial)");
    const page = await mount(
      <InWorkspace workspaceId="default">
        <Details session={live} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Tokens (last execution)");
    expect(page.querySelector('dd[title="local/model"]')?.textContent).toBe("model");
    const empty = await mount(
      <InWorkspace workspaceId="default">
        <Details session={session()} />
      </InWorkspace>,
    );
    expect(empty.textContent).not.toContain("Tokens");
  });

  it("gives the chat's own artifacts and live browser sessions, and nothing of another chat's", async () => {
    const client = owner();
    const onChanges = vi.fn();
    const onBrowser = vi.fn();
    const page = await mount(
      <InWorkspace workspaceId="default">
        <Details
          session={session([tool("c1", "gpt-5")])}
          client={client}
          modelTarget="openrouter/gpt-5"
          onChanges={onChanges}
          onBrowser={onBrowser}
        />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("openrouter/gpt-5");
    expect(page.textContent).toContain("gpt-5");
    const artifacts = page.querySelector('[aria-label="this chat\'s artifacts"]');
    expect(artifacts?.textContent).toContain("1+ archived.");
    const browser = page.querySelector('[aria-label="this chat\'s browser sessions"]');
    expect(browser?.textContent).toContain("Pricing");
    expect(browser?.textContent).not.toContain("Elsewhere");
    await act(async () => (artifacts?.querySelector("button") as HTMLButtonElement).click());
    expect(onChanges).toHaveBeenCalledOnce();
    await act(async () => (browser?.querySelector("button") as HTMLButtonElement).click());
    expect(onBrowser).toHaveBeenCalledOnce();
  });

  it("asks the owner nothing before the chat has a task", async () => {
    const client = owner();
    const page = await mount(
      <InWorkspace workspaceId="default">
        <Details session={{ ...session(), taskId: undefined }} client={client} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("not admitted yet");
    expect(client.sent).toEqual([]);
  });

  it("says when there is nothing, says when a read failed, and offers no Center link the owner cannot open", async () => {
    const empty = await mount(
      <InWorkspace workspaceId="default">
        <Details session={session()} client={owner({ artifacts: { rows: [] }, browser: { items: [] } })} />
      </InWorkspace>,
    );
    expect(empty.textContent).toContain("None archived.");
    expect(empty.textContent).toContain("No live session.");
    expect(empty.querySelector('[aria-label="this chat\'s browser sessions"] button')).toBeNull();
    unmountAll();
    const failed = await mount(
      <InWorkspace workspaceId="default">
        <Details session={session()} client={owner({})} />
      </InWorkspace>,
    );
    expect(failed.textContent).toContain("artifacts is unavailable");
    expect(failed.textContent).toContain("browser is unavailable");
  });

  it("says some of the chat's live sessions are not shown when the owner sent only a page of them", async () => {
    const page = await mount(
      <InWorkspace workspaceId="default">
        <Details session={session()} client={owner({ artifacts: { rows: [] }, browser: { items: [], nextCursor: "next" } })} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("This chat has more live sessions than one list holds; some are not shown.");
  });

  it("reads again when a call finishes or a turn changes status, not on streamed text", async () => {
    const running = session([tool("c1"), { ...tool("c2"), status: "running" } as RunState["transcript"][number]]);
    const finished = session([tool("c1"), tool("c2")]);
    expect(chatVersion(running)).not.toBe(chatVersion(finished));
    const texted = session([
      tool("c1"),
      { ...tool("c2"), status: "running" } as RunState["transcript"][number],
      { kind: "text", key: "t", attemptId: "a1", text: "more" } as RunState["transcript"][number],
    ]);
    expect(chatVersion(texted)).toBe(chatVersion(running));
    const client = owner();
    await mount(
      <InWorkspace workspaceId="default">
        <Details session={running} client={client} />
      </InWorkspace>,
    );
    expect(client.sent).toEqual(["artifacts", "browser"]);
    await rerender(
      <InWorkspace workspaceId="default">
        <Details session={finished} client={client} />
      </InWorkspace>,
    );
    await act(async () => undefined);
    expect(client.sent).toEqual(["artifacts", "browser", "artifacts", "browser"]);
  });

  it("marks a session whose task ended as Ended, and closes it with Close browser, saying why when it cannot", async () => {
    const closes: unknown[] = [];
    let refuse = true;
    const client = {
      request: async (command: string, payload: Record<string, unknown>) => {
        if (command === "artifacts") return { ok: true, result: { rows: [] } };
        if (payload["action"] === "close") {
          closes.push(payload);
          if (refuse) return { ok: false, error: { code: "UNAVAILABLE", message: "the owner is stopping" } };
          return { ok: true, result: { closed: [payload["sessionId"]] } };
        }
        return { ok: true, result: { items: [{ ...browserRow("b1", "task-1", "Pricing", "example.com"), live: false, inactive: true }] } };
      },
    } as unknown as SettingsClient;
    const page = await mount(
      <InWorkspace workspaceId="default">
        <Details session={session()} client={client} />
      </InWorkspace>,
    );
    const browser = page.querySelector('[aria-label="this chat\'s browser sessions"]');
    expect(browser?.textContent).toContain("Ended");
    const close = () =>
      [...(browser?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Close browser") as HTMLButtonElement;
    await act(async () => close().click());
    expect(closes).toEqual([{ action: "close", workspaceId: "default", sessionId: "b1" }]);
    expect(browser?.textContent).toContain("the owner is stopping");
    refuse = false;
    await act(async () => close().click());
    expect(browser?.textContent).not.toContain("the owner is stopping");
    expect(browser?.textContent).toContain("closed");
    expect(browser?.textContent).not.toContain("Close browser");
  });
});
