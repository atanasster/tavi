// @vitest-environment jsdom
import type { NeedRow } from "@tavi/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NEED_NOTIFY_STORAGE_KEY,
  NeedToast,
  needHeadline,
  useFaviconDot,
  useNeedNotifications,
} from "../../../src/features/needs/NeedNotify.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, click, mount, rerender, settle, unmountAll } from "../../support/dom.js";

/** Wherever you are: needs said on the page, and in notifications. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  document.body.innerHTML = "";
  document.getElementById("tavi-needs-icon")?.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const question = (waitId: string, taskId = `task-${waitId}`): NeedRow => ({
  kind: "question",
  needId: `question:${waitId}`,
  taskId,
  askedAt: `2026-10-02T1${waitId.length}:00:00.000Z`,
  deadlineAt: "2099-01-01T00:00:00.000Z",
  question: {
    taskId,
    workspaceId: "default",
    principalId: "operator",
    originLabel: "Daily release",
    waitId,
    question: `Ship ${waitId}?`,
    deadlineAt: "2099-01-01T00:00:00.000Z",
    askedAt: "2026-10-02T10:00:00.000Z",
    deliveries: [],
  },
});

function owner(needs: { current: readonly NeedRow[] }) {
  const asked: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (_command, payload) => {
      asked.push(payload as Record<string, unknown>);
      return {
        ok: true,
        result: (payload as Record<string, unknown>)["action"] === "needs" ? { needs: needs.current, truncated: false } : {},
      } as never;
    },
  };
  return { client, asked };
}

function Probe(props: {
  client: SettingsClient;
  revision: number;
  currentTaskId?: string;
  onState: (state: ReturnType<typeof useNeedNotifications>) => void;
}) {
  const state = useNeedNotifications({
    client: props.client,
    workspaceId: "default",
    enabled: true,
    revision: props.revision,
    currentTaskId: props.currentTaskId,
    onOpen: () => {},
  });
  props.onState(state);
  return null;
}

/** Probes of the hook reading `client`: `probe(revision, currentTaskId)` drawn, and what it last returned in `seen.state`. */
function probes(client: SettingsClient) {
  const seen: { state?: ReturnType<typeof useNeedNotifications> } = {};
  const probe = (revision: number, currentTaskId?: string) => (
    <Probe
      client={client}
      revision={revision}
      {...(currentTaskId === undefined ? {} : { currentTaskId })}
      onState={(next) => {
        seen.state = next;
      }}
    />
  );
  return { seen, probe };
}

describe("useNeedNotifications", () => {
  it("takes the first read as the baseline, then toasts what is new from another chat — not the one in view", async () => {
    const needs = { current: [question("a")] };
    const { client } = owner(needs);
    const { seen, probe } = probes(client);
    await mount(probe(0));
    await settle();
    expect(seen.state?.toast).toBeUndefined();
    needs.current = [question("a"), question("bb"), question("ccc", "task-open")];
    await rerender(probe(1, "task-open"));
    await settle();
    expect(seen.state?.toast?.need.needId).toBe("question:bb");
    expect(seen.state?.toast?.more).toBe(0);
  });

  it("offers notifications once something arrived while hidden, and notifies when they are on", async () => {
    const shown: { title: string; body?: string }[] = [];
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn(async () => {
        FakeNotification.permission = "granted";
        return "granted" as const;
      });
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        shown.push({ title, ...(options?.body === undefined ? {} : { body: options.body }) });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const needs = { current: [] as readonly NeedRow[] };
    const { client } = owner(needs);
    const { seen, probe } = probes(client);
    await mount(probe(0));
    await settle();
    needs.current = [question("a")];
    await rerender(probe(1));
    await settle();
    expect(seen.state?.offer).toBe(true);
    expect(shown).toEqual([]);
    await act(async () => seen.state?.accept());
    await settle();
    expect(localStorage.getItem(NEED_NOTIFY_STORAGE_KEY)).toBe("on");
    needs.current = [question("a"), question("bb")];
    await rerender(probe(2));
    await settle();
    expect(shown).toEqual([{ title: "Daily release asks", body: "Ship bb?" }]);
    hidden.mockRestore();
  });
});

describe("useNeedNotifications over time", () => {
  it("keeps an open toast, counting what else arrives, and clears it when its need is resolved or its task opened", async () => {
    const needs = { current: [] as readonly NeedRow[] };
    const { client } = owner(needs);
    const { seen, probe } = probes(client);
    await mount(probe(0));
    await settle();
    needs.current = [question("a")];
    await rerender(probe(1));
    await settle();
    needs.current = [question("a"), question("bb")];
    await rerender(probe(2));
    await settle();
    expect(seen.state?.toast).toMatchObject({ need: { needId: "question:a" }, more: 1 });
    // Answered somewhere else: the queue drops it, and so does the toast.
    needs.current = [question("bb")];
    await rerender(probe(3));
    await settle();
    expect(seen.state?.toast).toBeUndefined();
    needs.current = [question("bb"), question("ccc")];
    await rerender(probe(4));
    await settle();
    expect(seen.state?.toast?.need.needId).toBe("question:ccc");
    await rerender(probe(4, "task-ccc"));
    expect(seen.state?.toast).toBeUndefined();
  });

  it("offers notifications when permission was already given but never chosen here, and Not now writes off", async () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: stands in for the Notification constructor, whose permission API is static
    class Granted {
      static permission: NotificationPermission = "granted";
      static requestPermission = vi.fn();
    }
    vi.stubGlobal("Notification", Granted);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const needs = { current: [] as readonly NeedRow[] };
    const { client } = owner(needs);
    const { seen, probe } = probes(client);
    await mount(probe(0));
    await settle();
    needs.current = [question("a")];
    await rerender(probe(1));
    await settle();
    expect(seen.state?.offer).toBe(true);
    await act(async () => seen.state?.decline());
    expect(seen.state?.offer).toBe(false);
    expect(localStorage.getItem(NEED_NOTIFY_STORAGE_KEY)).toBe("off");
    expect(Granted.requestPermission).not.toHaveBeenCalled();
    hidden.mockRestore();
  });
});

describe("NeedToast", () => {
  it("answers a question in the toast, and goes to the task or the inbox", async () => {
    const { client, asked } = owner({ current: [] });
    const opened: string[] = [];
    const need: NeedRow = {
      ...question("a"),
      question: {
        ...(question("a") as Extract<NeedRow, { kind: "question" }>).question,
        choices: { options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false },
      },
    } as NeedRow;
    const host = await mount(
      <InWorkspace timeZone="UTC" client={client} workspaceId="default">
        <NeedToast
          toast={{ need, more: 2 }}
          onOpen={(open) => opened.push(open.taskId)}
          onOpenAll={() => opened.push("inbox")}
          onDismiss={() => {}}
        />
      </InWorkspace>,
    );
    expect(host.querySelector("aside")?.getAttribute("aria-label")).toBe("Needs you");
    const yes = [...host.querySelectorAll<HTMLButtonElement>("button.need-option")][0];
    await act(async () => yes?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(asked.at(-1)).toEqual({ action: "answer", workspaceId: "default", taskId: "task-a", waitId: "a", answer: "Yes" });
    expect(host.textContent).toContain("You answered Yes");
    await click(button(host, "+2 more in Approvals"));
    expect(opened).toEqual(["inbox"]);
  });

  it("names a need in one line, whatever its kind", () => {
    expect(needHeadline(question("a"))).toEqual({ title: "Daily release asks", body: "Ship a?" });
    expect(
      needHeadline({
        kind: "approval",
        needId: "approval:x",
        taskId: "t",
        askedAt: "now",
        approval: {
          approvalId: "x",
          taskId: "t",
          toolId: "http.request",
          callId: "c",
          steps: 1,
          createdAt: "now",
          workspaceId: "default",
          principalId: "operator",
          taskStatus: "waiting",
          taskTitle: "Book trains",
          summary: "https://bahn.de",
          allowedScopes: ["once"],
        },
      }),
    ).toEqual({ title: "Book trains needs approval", body: "https://bahn.de" });
    expect(
      needHeadline({
        kind: "review",
        needId: "review:t",
        taskId: "t",
        askedAt: "now",
        review: { taskId: "t", workspaceId: "default", principalId: "operator", artifactCount: 2, askedAt: "now" },
      }),
    ).toEqual({ title: "A chat has results to review", body: "2 results" });
  });
});

describe("useFaviconDot", () => {
  it("shows a dot in the tab's icon while anything waits, and none otherwise", async () => {
    function Dot({ waiting }: { waiting: number }) {
      useFaviconDot(waiting);
      return null;
    }
    await mount(<Dot waiting={2} />);
    expect(document.getElementById("tavi-needs-icon")?.getAttribute("href")).toMatch(/^data:image\/svg\+xml,/);
    await rerender(<Dot waiting={0} />);
    expect(document.getElementById("tavi-needs-icon")).toBeNull();
    // Gone when the page that drew it goes.
    await rerender(<Dot waiting={1} />);
    unmountAll();
    expect(document.getElementById("tavi-needs-icon")).toBeNull();
  });
});
