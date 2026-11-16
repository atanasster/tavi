// @vitest-environment jsdom
import type { Idea, IdeaRun, IdeaSettings, IdeasListAnswer } from "@tavi/contracts";
import axe from "axe-core";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdeaCard } from "../../../src/features/ideas/IdeaCard.js";
import { IdeasPage } from "../../../src/features/ideas/IdeasPage.js";
import { IdeasSettings } from "../../../src/features/ideas/IdeasSettings.js";
import { ideasLayout } from "../../../src/features/ideas/ideas-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { announced, freshAnnouncer } from "../../announced.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, settledBy, unmountAll } from "../../support/dom.js";

beforeEach(() => void freshAnnouncer());

/**
 * The Ideas tab: "For you" holds four, each
 * section three until *More*, the footer ends the page; *Why this* links to
 * where the person said it; *Uses* says what it would use and whether it asks;
 * *Try it* hands over the prompt and sends nothing; the empty, unset-model and
 * failed states; and no WCAG 2.1 A/AA violation axe can find.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  unmountAll();
});

/** What was asked answered: microtasks only, as tests here fake the clock. */
const { settle, mount, click } = settledBy(() => flush());

const AT = "2026-10-19T10:00:00.000Z";

const idea = (key: string, overrides: Partial<Idea> = {}): Idea => ({
  id: `id-${key}`,
  workspaceId: "default",
  runId: "run-1",
  providerId: "tavi.ideasagent",
  key,
  category: key.split(".")[0] as Idea["category"],
  icon: "💡",
  title: `I can help with ${key}`,
  pitch: `A pitch for ${key}.`,
  label: key,
  prompt: `Help me with ${key}.`,
  basis: [{ kind: "general", ref: "general" }],
  uses: [{ capability: "web", approval: false }],
  score: 0.5,
  status: "active",
  pinned: false,
  shownRuns: 0,
  createdAt: AT,
  updatedAt: AT,
  expiresAt: "2026-11-19T10:00:00.000Z",
  ...overrides,
});

const IDEAS: readonly Idea[] = [
  idea("travel.fare-watch", {
    basis: [
      { kind: "memory", ref: "mem-1", excerpt: "Lisbon in May" },
      { kind: "task", ref: "task-1", excerpt: "Trip budget" },
    ],
    uses: [
      { capability: "travel", approval: false },
      { capability: "reminders", approval: true },
    ],
  }),
  idea("work.job-watch"),
  idea("learning.tutor", { basis: [{ kind: "brief", ref: "brief", excerpt: "More about the garden" }] }),
  idea("productivity.inbox"),
  ...["a", "b", "c", "d", "e"].map((name) => idea(`travel.${name}`)),
  idea("people.birthdays"),
];

function owner(answer: Partial<IdeasListAnswer> | "fail" = {}, tryFails = false, refuse?: string, settings: Partial<IdeaSettings> = {}) {
  const sent: Record<string, unknown>[] = [];
  const refreshes: string[] = ["started", "queued", "busy"];
  const client: SettingsClient = {
    request: (async (command: string, payload: Record<string, unknown>) => {
      sent.push({ command, ...payload });
      if (refuse !== undefined && payload["action"] === refuse)
        return { ok: false, error: { code: "CONFLICT", message: `${refuse} was refused` } };
      if (command === "routines") return { ok: true, result: { routine: { routineId: "routine-1" } } };
      if (command !== "ideas" || answer === "fail") return { ok: false, error: { code: "UNAVAILABLE", message: "the owner stopped" } };
      switch (payload["action"]) {
        case "list":
          return {
            ok: true,
            result: {
              ideas: IDEAS,
              mutedCategories: [],
              excludedBasis: [],
              provider: "tavi.ideasagent",
              providers: [],
              lastRun: {
                id: "run-1",
                workspaceId: "default",
                trigger: "schedule",
                startedAt: AT,
                outcome: "generated",
                generated: 10,
                dropped: 0,
                tokens: 0,
                usd: 0,
              },
              nextAt: "2026-10-20T05:00:00.000Z",
              modelSet: true,
              ...answer,
            },
          };
        case "try":
          if (tryFails) return { ok: false, error: { code: "NOT_FOUND", message: "Idea id-x does not exist" } };
          return { ok: true, result: { prompt: `Help me with ${String(payload["id"]).slice(3)}.`, idea: IDEAS[0] } };
        case "refresh":
          return { ok: true, result: { status: refreshes.shift() ?? "started" } };
        case "brief":
          return { ok: true, result: { text: "old" } };
        case "set-brief":
          return { ok: true, result: { text: payload["text"] } };
        case "feedback":
        case "pin":
        case "unpin":
        case "restore":
          return { ok: true, result: { idea: IDEAS[0] } };
        case "reset":
          return { ok: true, result: { cleared: 3 } };
        case "recur":
          return {
            ok: true,
            result: {
              draft: {
                name: "Watch fares",
                prompt: "Find the cheapest flights from Sofia to Lisbon.",
                cadence:
                  (answer as Partial<IdeasListAnswer>).ideas?.find((item) => item.id === payload["id"])?.recurring?.cadence ?? "weekly",
              },
            },
          };
        case "made-recurring":
          return { ok: true, result: { idea: IDEAS[0] } };
        case "remind":
          return { ok: true, result: { reminderId: "rem-1" } };
        case "settings":
        case "set-settings":
          return {
            ok: true,
            result: {
              settings: {
                enabled: true,
                provider: "tavi.ideasagent",
                chips: true,
                sources: { memory: true, tasks: true, brief: true },
                dailyTokens: 20_000,
                hours: { start: "08:00", end: "22:00" },
                ...settings,
                ...((payload["changes"] as object | undefined) ?? {}),
              },
            },
          };
        default:
          return { ok: false, error: { code: "UNSUPPORTED", message: "no" } };
      }
    }) as SettingsClient["request"],
  };
  return { client, sent };
}

const run = (overrides: Partial<IdeaRun> = {}): IdeaRun => ({
  id: "run-1",
  workspaceId: "default",
  trigger: "schedule",
  startedAt: AT,
  outcome: "generated",
  generated: 10,
  dropped: 0,
  tokens: 0,
  usd: 0,
  ...overrides,
});

const titles = (scope: Element | null | undefined): string[] =>
  [...(scope?.querySelectorAll(".idea-card h3") ?? [])].map((heading) => heading.textContent ?? "");
const section = (page: HTMLElement, name: string): Element | undefined =>
  [...page.querySelectorAll(".ideas-section")].find((element) => element.querySelector("h2")?.textContent === name);

describe("the Ideas tab", () => {
  it("lays out four for you, three a section until More, and ends the page", async () => {
    expect(ideasLayout(IDEAS).forYou.map((item) => item.key)).toEqual([
      "travel.fare-watch",
      "work.job-watch",
      "learning.tutor",
      "productivity.inbox",
    ]);
    const { client } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    expect(titles(section(page, "For you"))).toHaveLength(4);
    const travel = section(page, "Travel & errands");
    expect(titles(travel)).toEqual(["I can help with travel.a", "I can help with travel.b", "I can help with travel.c"]);
    await click([...(travel?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "More (2)"));
    expect(titles(section(page, "Travel & errands"))).toHaveLength(5);
    expect(titles(section(page, "People & culture"))).toEqual(["I can help with people.birthdays"]);
    // The day is said only when it is not today's.
    expect(page.querySelector(".ideas-foot")?.textContent).toMatch(
      /^That’s all for now\.Last looked (Mon 19 Oct )?10:00\. Next (Tue 20 Oct )?05:00\.$/u,
    );
  });

  it("links why each was offered to where it was said, and says what it uses and that it asks", async () => {
    const { client } = owner();
    const opened: string[] = [];
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={() => undefined} onOpenTask={(taskId) => opened.push(taskId)} onOpenMemory={() => opened.push("memory")} />
      </InWorkspace>,
    );
    const card = page.querySelector(".idea-card");
    const [why, uses] = [...(card?.querySelectorAll(".idea-meta") ?? [])];
    expect(why?.textContent).toBe("Why this: you said “Lisbon in May” · chat “Trip budget”");
    expect(uses?.textContent).toBe("Uses: Travel · Reminders — asks before acting");
    for (const button of why?.querySelectorAll("button") ?? []) await click(button);
    expect(opened).toEqual(["memory", "task-1"]);
    const cards = [...page.querySelectorAll(".idea-card")];
    expect(cards[1]?.querySelector(".idea-meta")?.textContent).toBe("Why this: something many people ask for");
    expect(cards[2]?.querySelector(".idea-meta")?.textContent).toBe("Why this: your brief: “More about the garden”");
  });

  it("names a plugin provider as the reason for its idea that rests on nothing personal", async () => {
    const page = await mount(
      <IdeaCard
        idea={idea("travel.plugin", { providerId: "acme.ideas", basis: [{ kind: "general", ref: "general" }] })}
        links={{}}
        onTry={() => undefined}
      />,
    );
    expect(page.querySelector(".idea-meta")?.textContent).toBe("Why this: suggested by acme.ideas");
  });

  it("Try it hands over the prompt and sends nothing", async () => {
    const { client, sent } = owner();
    const tried: string[] = [];
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={(prompt) => tried.push(prompt)} />
      </InWorkspace>,
    );
    await click(page.querySelector(".idea-card .idea-actions button"));
    expect(tried).toEqual(["Help me with travel.fare-watch."]);
    expect(sent.map((payload) => payload["action"])).toEqual(["list", "try"]);
  });

  it("says when there are none, when no fast model is set, and when the owner cannot answer", async () => {
    const empty = owner({ ideas: [], lastRun: undefined, nextAt: undefined, modelSet: false });
    const models: string[] = [];
    let page = await mount(
      <InWorkspace client={empty.client} workspaceId="default">
        <IdeasPage onTry={() => undefined} onModels={() => models.push("models")} />
      </InWorkspace>,
    );
    expect(page.querySelector(".ideas-empty")?.textContent).toContain("No ideas yet.");
    expect(page.querySelector(".ideas-foot")?.textContent).toBe("Not looked yet.");
    await click(page.querySelector(".ideas-model button"));
    expect(models).toEqual(["models"]);
    await click([...page.querySelectorAll(".ideas-head-actions button")].find((button) => button.textContent?.includes("Refresh")));
    expect(announced()).toBe("Looking for new ideas…");
    unmountAll();
    page = await mount(
      <InWorkspace client={owner("fail").client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    expect(page.querySelector(".failure")?.textContent).toBe("the owner stopped");
    expect([...page.querySelectorAll("button")].some((button) => button.textContent === "Try again")).toBe(true);
  });

  it("has no WCAG 2.1 A/AA violations axe can find", async () => {
    const page = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <IdeasPage onTry={() => undefined} onOpenTask={() => undefined} onOpenMemory={() => undefined} />
      </InWorkspace>,
    );
    await click([...page.querySelectorAll(".ideas-head-actions button")].find((button) => button.textContent?.includes("Tune")));
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("names a source whose words were dropped without empty quotes", async () => {
    const { IdeaCard } = await import("../../../src/features/ideas/IdeaCard.js");
    const bare = idea("learning.tutor", {
      basis: [
        { kind: "brief", ref: "brief" },
        { kind: "memory", ref: "mem-1", excerpt: "" },
        { kind: "task", ref: "task-1" },
      ],
    });
    const page = await mount(<IdeaCard idea={bare} links={{}} onTry={() => undefined} />);
    expect(page.querySelector(".idea-meta")?.textContent).toBe("Why this: your brief · something you told me · one of your chats");
  });

  it("refreshes one at a time and says how each went; Tune saves the brief and reads the list again; a failed Try it is said", async () => {
    const { client, sent } = owner({}, true);
    const tried: string[] = [];
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={(prompt) => tried.push(prompt)} />
      </InWorkspace>,
    );
    const button = (label: string) => [...page.querySelectorAll("button")].find((element) => element.textContent?.includes(label));
    const notes: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      await click(button("Refresh"));
      notes.push(announced() ?? "");
    }
    expect(notes).toEqual([
      "Looking for new ideas…",
      "A look is already under way; another follows it.",
      "New ideas are being looked for elsewhere.",
    ]);
    await click(button("Tune"));
    const brief = page.querySelector<HTMLTextAreaElement>(".ideas-tune textarea");
    expect(brief?.value).toBe("old");
    const lists = sent.filter((payload) => payload["action"] === "list").length;
    await click(button("Save"));
    expect(sent.find((payload) => payload["action"] === "set-brief")).toMatchObject({ text: "old" });
    expect(page.querySelector(".ideas-tune")).toBeNull();
    expect(announced()).toBe("Brief saved.");
    expect(sent.filter((payload) => payload["action"] === "list").length).toBe(lists + 1);
    await click(page.querySelector(".idea-card .idea-actions button"));
    expect(tried).toEqual([]);
    expect(announced()).toBe("Idea id-x does not exist");
  });

  it("sends each ⋯ action as its signal, says what it did and how to undo it, and reads the list again", async () => {
    const { client, sent } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const card = () => page.querySelector(".idea-card");
    const item = (label: string) =>
      [...(card()?.querySelectorAll(".idea-menu-panel button") ?? [])].find((button) => button.textContent === label);
    const actions = [
      "Pin",
      "More like this",
      "Not now",
      "Not interested",
      "Not interested in Travel & errands",
      "Don’t use “Lisbon in May”",
      "Don’t use “Trip budget”",
    ];
    const notes: string[] = [];
    for (const label of actions) {
      await click(card()?.querySelector(".idea-menu > button"));
      expect(card()?.querySelector(".idea-menu > button")?.getAttribute("aria-expanded")).toBe("true");
      await click(item(label));
      notes.push(announced() ?? "");
    }
    const asked = sent
      .filter((payload) => !["list"].includes(String(payload["action"])))
      .map(({ action, signal, category, basisRef, id }) => ({ action, signal, category, basisRef, id }));
    expect(asked).toEqual([
      { action: "pin", signal: undefined, category: undefined, basisRef: undefined, id: "id-travel.fare-watch" },
      { action: "feedback", signal: "more-like-this", category: undefined, basisRef: undefined, id: "id-travel.fare-watch" },
      { action: "feedback", signal: "not-now", category: undefined, basisRef: undefined, id: "id-travel.fare-watch" },
      { action: "feedback", signal: "not-interested", category: undefined, basisRef: undefined, id: "id-travel.fare-watch" },
      { action: "feedback", signal: "mute-category", category: undefined, basisRef: undefined, id: "id-travel.fare-watch" },
      { action: "feedback", signal: "exclude-basis", category: undefined, basisRef: "mem-1", id: "id-travel.fare-watch" },
      { action: "feedback", signal: "exclude-basis", category: undefined, basisRef: "task-1", id: "id-travel.fare-watch" },
    ]);
    expect(notes[2]).toBe("Hidden for a week. Bring it back in Settings → Ideas.");
    expect(notes[4]).toBe("No more Travel & errands ideas. Unmute it in Settings → Ideas.");
    // Each action read the list again.
    expect(sent.filter((payload) => payload["action"] === "list")).toHaveLength(1 + actions.length);
    // Escape closes the menu and gives focus back to its button.
    await click(card()?.querySelector(".idea-menu > button"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(card()?.querySelector(".idea-menu-panel")).toBeNull();
    expect(document.activeElement).toBe(card()?.querySelector(".idea-menu > button"));
  });

  it("Settings → Ideas brings back what the menu hid, and changes the switches a page may", async () => {
    const hidden = [
      idea("travel.hotels", { status: "snoozed" }),
      idea("work.cv", { status: "dismissed", basis: [{ kind: "task", ref: "task-9" }] }),
    ];
    const { client, sent } = owner({
      ideas: [...IDEAS.slice(0, 2), ...hidden],
      mutedCategories: ["shopping"],
      excludedBasis: ["brief", "task-9", "mem-7", "x-1"],
      excludedSources: [{ ref: "brief", kind: "brief" }, { ref: "task-9", kind: "task" }, { ref: "mem-7", kind: "memory" }, { ref: "x-1" }],
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasSettings />
      </InWorkspace>,
    );
    expect(sent.find((payload) => payload["action"] === "list")).toMatchObject({ includeInactive: true });
    const rows = [...page.querySelectorAll(".item-row")].map((row) => row.querySelector("span")?.textContent);
    expect(rows).toEqual([
      "I can help with travel.hotels (not now)",
      "I can help with work.cv (not interested)",
      "Shopping & style",
      "Your brief",
      "A chat (task-9)",
      "Something you told me (mem-7)",
      "A source (x-1)",
    ]);
    const button = (label: string) => page.querySelector(`button[aria-label="${label}"]`);
    await click(button("Bring back I can help with travel.hotels"));
    await click(button("Unmute Shopping & style"));
    await click(button("Use A chat (task-9) again"));
    const box = (text: string) =>
      [...page.querySelectorAll("label")].find((label) => label.textContent?.includes(text))?.querySelector("input");
    await click(box("Your brief"));
    await click(box("Look for ideas"));
    await click(box("Suggest prompts"));
    expect(
      sent
        .filter((payload) => !["list", "settings", "brief"].includes(String(payload["action"])))
        .map(({ action, id, signal, category, basisRef, changes }) => ({ action, id, signal, category, basisRef, changes })),
    ).toEqual([
      { action: "restore", id: "id-travel.hotels", signal: undefined, category: undefined, basisRef: undefined, changes: undefined },
      { action: "feedback", id: undefined, signal: "unmute-category", category: "shopping", basisRef: undefined, changes: undefined },
      { action: "feedback", id: undefined, signal: "include-basis", category: undefined, basisRef: "task-9", changes: undefined },
      {
        action: "set-settings",
        id: undefined,
        signal: undefined,
        category: undefined,
        basisRef: undefined,
        changes: { sources: { brief: false } },
      },
      { action: "set-settings", id: undefined, signal: undefined, category: undefined, basisRef: undefined, changes: { enabled: false } },
      { action: "set-settings", id: undefined, signal: undefined, category: undefined, basisRef: undefined, changes: { chips: false } },
    ]);
    expect(page.textContent).toContain("Switch it with tavi ideas provider in a terminal.");
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("says a menu action the owner refused and reads nothing again; Unpin is offered on a pinned idea", async () => {
    const pinned = [idea("travel.fare-watch", { pinned: true }), ...IDEAS.slice(1)];
    const { client, sent } = owner({ ideas: pinned }, false, "unpin");
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const card = page.querySelector(".idea-card");
    expect(card?.querySelector(".badge")?.textContent).toBe("Pinned");
    await click(card?.querySelector(".idea-menu > button"));
    await click([...(card?.querySelectorAll(".idea-menu-panel button") ?? [])].find((button) => button.textContent === "Unpin"));
    expect(announced()).toBe("unpin was refused");
    expect(sent.map((payload) => payload["action"])).toEqual(["list", "unpin"]);
  });

  it("Settings → Ideas edits the brief, says when it looks next, and starts over only once confirmed", async () => {
    const { client, sent } = owner({ nextAt: "2026-10-20T05:00:00.000Z" });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <IdeasSettings />
      </InWorkspace>,
    );
    expect(page.textContent).toMatch(/Next (Tue 20 Oct )?05:00, between 08:00 and 22:00\./u);
    const brief = page.querySelector<HTMLTextAreaElement>("textarea");
    expect(brief?.value).toBe("old");
    const save = [...page.querySelectorAll("button")].find((button) => button.textContent === "Save brief");
    expect(save?.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(brief, "Garden, not money");
      brief?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Another action reloads the page: what is being typed stays.
    await click(
      [...page.querySelectorAll("label")].find((label) => label.textContent?.includes("Suggest prompts"))?.querySelector("input"),
    );
    expect(page.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Garden, not money");
    await click(save);
    expect(sent.find((payload) => payload["action"] === "set-brief")).toMatchObject({ text: "Garden, not money" });
    await click([...page.querySelectorAll("button")].find((button) => button.textContent === "Forget what I hid"));
    expect(sent.some((payload) => payload["action"] === "reset")).toBe(false);
    await click([...document.querySelectorAll("dialog button")].find((button) => button.textContent === "Forget"));
    expect(sent.find((payload) => payload["action"] === "reset")).toMatchObject({ what: "ledger" });
    await click([...page.querySelectorAll("button")].find((button) => button.textContent === "Unmute every section"));
    await click([...document.querySelectorAll("dialog button")].find((button) => button.textContent === "Unmute all"));
    expect(sent.filter((payload) => payload["action"] === "reset").map((payload) => payload["what"])).toEqual(["ledger", "categories"]);
  });

  it("Make it recurring stops on a [part] left unfilled, once: nobody is there to ask when the routine runs", async () => {
    const recurring = [idea("travel.fare-watch", { recurring: { cadence: "weekly" } }), ...IDEAS.slice(1)];
    const { client, sent } = owner({ ideas: recurring });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const open = async (): Promise<HTMLTextAreaElement> => {
      await click(page.querySelector(".idea-card .idea-menu > button"));
      await click(
        [...(page.querySelector(".idea-card")?.querySelectorAll(".idea-menu-panel button") ?? [])].find(
          (button) => button.textContent === "Make it recurring…",
        ),
      );
      const box = document.querySelector<HTMLTextAreaElement>("dialog textarea");
      if (box === null) throw new Error("no box");
      return box;
    };
    const type = async (box: HTMLTextAreaElement, text: string): Promise<void> => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      await act(async () => {
        set?.call(box, text);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const save = async (): Promise<void> => {
      await act(async () => document.querySelector<HTMLFormElement>("dialog form")?.requestSubmit());
      await settle();
    };
    const made = () => sent.filter((payload) => payload["command"] === "routines");
    const box = await open();
    await type(box, "Plan my week for [exam] on [date].");
    await save();
    expect(made()).toEqual([]);
    expect(document.querySelector("dialog")?.textContent).toContain("[exam] is not filled in");
    // Focus stays in the dialog, on the part to type over, and the field carries the warning.
    expect(document.activeElement).toBe(box);
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe("[exam]");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    const warning = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    expect(warning?.textContent).toContain("[exam] is not filled in");
    expect(warning?.classList.contains("failure")).toBe(true);
    // Other words with a blank in them are asked about again.
    await type(box, "Plan my week for AWS on [date].");
    await save();
    expect(made()).toEqual([]);
    expect(document.querySelector("dialog")?.textContent).toContain("[date] is not filled in");
    // The same words again: the brackets were meant.
    await save();
    expect(made()).toHaveLength(1);
  });

  it("Make it recurring clears its warning once the words change, and warns only of a template blank", async () => {
    const recurring = [idea("travel.fare-watch", { recurring: { cadence: "weekly" } }), ...IDEAS.slice(1)];
    const { client, sent } = owner({ ideas: recurring });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    await click(page.querySelector(".idea-card .idea-menu > button"));
    await click(
      [...(page.querySelector(".idea-card")?.querySelectorAll(".idea-menu-panel button") ?? [])].find(
        (button) => button.textContent === "Make it recurring…",
      ),
    );
    const box = document.querySelector<HTMLTextAreaElement>("dialog textarea");
    if (box === null) throw new Error("no box");
    const type = async (text: string): Promise<void> => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      await act(async () => {
        set?.call(box, text);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("Plan for [exam].");
    await act(async () => document.querySelector<HTMLFormElement>("dialog form")?.requestSubmit());
    await settle();
    expect(box.getAttribute("aria-invalid")).toBe("true");
    await type("Plan from [the rules](https://example.com/r), section [1], and [[wiki]]:\n- [x] read\n- [ ] revise");
    expect(box.hasAttribute("aria-invalid")).toBe(false);
    expect(box.hasAttribute("aria-describedby")).toBe(false);
    expect(document.querySelector("dialog")?.textContent).not.toContain("is not filled in");
    await act(async () => document.querySelector<HTMLFormElement>("dialog form")?.requestSubmit());
    await settle();
    expect(document.querySelector("dialog")?.textContent ?? "").not.toContain("is not filled in");
    expect(sent.filter((payload) => payload["command"] === "routines")).toHaveLength(1);
  });

  it("Make it recurring creates the routine only once saved, through routines, then marks the idea done; Remind me sets a reminder", async () => {
    const recurring = [idea("travel.fare-watch", { recurring: { cadence: "weekly" } }), ...IDEAS.slice(1)];
    const { client, sent } = owner({ ideas: recurring });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const card = () => page.querySelector(".idea-card");
    const item = (label: string) =>
      [...(card()?.querySelectorAll(".idea-menu-panel button") ?? [])].find((button) => button.textContent === label);
    // Only a repeating idea offers it.
    await click(page.querySelectorAll(".idea-card")[1]?.querySelector(".idea-menu > button"));
    expect(
      [...(page.querySelectorAll(".idea-card")[1]?.querySelectorAll(".idea-menu-panel button") ?? [])].map((button) => button.textContent),
    ).not.toContain("Make it recurring…");
    await click(card()?.querySelector(".idea-menu > button"));
    await click(item("Make it recurring…"));
    const dialog = () => document.querySelector("dialog");
    expect(dialog()?.querySelector("textarea")?.value).toBe("Find the cheapest flights from Sofia to Lisbon.");
    // Cancelled: nothing is created.
    await click([...(dialog()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Cancel"));
    expect(sent.some((payload) => payload["command"] === "routines")).toBe(false);
    await click(card()?.querySelector(".idea-menu > button"));
    await click(item("Make it recurring…"));
    await act(async () => dialog()?.querySelector("form")?.requestSubmit());
    await settle();
    const created = sent.find((payload) => payload["command"] === "routines");
    expect(created).toMatchObject({
      action: "create",
      setup: {
        name: "Watch fares",
        objective: "Find the cheapest flights from Sofia to Lisbon.",
        timezone: "UTC",
        triggers: [{ id: "weekly", kind: "daily", at: "09:00", timezone: "UTC", daysOfWeek: [1] }],
      },
    });
    expect(sent.find((payload) => payload["action"] === "made-recurring")).toMatchObject({
      id: "id-travel.fare-watch",
      routineId: "routine-1",
    });
    expect(announced()).toBe("Routine “Watch fares” created; it starts once its check passes.");
    // Remind me: at the time picked, as an instant.
    await click(card()?.querySelector(".idea-menu > button"));
    await click(item("Remind me…"));
    const when = dialog()?.querySelector<HTMLInputElement>("input[type=datetime-local]");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(when, "2099-01-02T08:30");
      when?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => dialog()?.querySelector("form")?.requestSubmit());
    await settle();
    expect(sent.find((payload) => payload["action"] === "remind")).toMatchObject({
      id: "id-travel.fare-watch",
      at: "2099-01-02T08:30:00.000Z",
    });
  });

  it("a daily routine runs at its time; a monthly idea is not offered as one; a routine made but not noted says so", async () => {
    const ideasNow = [
      idea("travel.daily", { recurring: { cadence: "daily" } }),
      idea("travel.monthly", { recurring: { cadence: "monthly" } }),
      ...IDEAS.slice(2),
    ];
    const { client, sent } = owner({ ideas: ideasNow }, false, "made-recurring");
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const [daily, monthly] = [...page.querySelectorAll(".idea-card")];
    await click(monthly?.querySelector(".idea-menu > button"));
    expect([...(monthly?.querySelectorAll(".idea-menu-panel button") ?? [])].map((button) => button.textContent)).not.toContain(
      "Make it recurring…",
    );
    await click(daily?.querySelector(".idea-menu > button"));
    await click(
      [...(daily?.querySelectorAll(".idea-menu-panel button") ?? [])].find((button) => button.textContent === "Make it recurring…"),
    );
    await act(async () => document.querySelector("dialog form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    const created = sent.find((payload) => payload["command"] === "routines") as { setup?: Record<string, unknown> } | undefined;
    expect(created?.setup).toEqual({
      name: "Watch fares",
      objective: "Find the cheapest flights from Sofia to Lisbon.",
      timezone: "UTC",
      at: "09:00",
    });
    expect(announced()).toBe("Routine “Watch fares” created; the idea could not be marked done: made-recurring was refused");
  });

  it("says when an idea's first step is ready", async () => {
    const { IdeaCard } = await import("../../../src/features/ideas/IdeaCard.js");
    const page = await mount(
      <IdeaCard
        idea={idea("travel.a", { prepared: { taskId: "prep-1", text: "Cheapest: €120.", at: AT } })}
        links={{}}
        onTry={() => undefined}
      />,
    );
    expect([...page.querySelectorAll(".idea-meta")].map((line) => line.textContent)).toContain(
      "Ready: I looked already; Try it starts from what I found.",
    );
  });

  it("after a refresh, reads the list every few seconds until the look ends, says what it found, and then stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(AT));
    let lastRun = run();
    const { client, sent } = owner({
      get lastRun() {
        return lastRun;
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const lists = () => sent.filter((payload) => payload["action"] === "list").length;
    const note = () => announced();
    const wait = async (ms: number): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      await settle();
    };
    const refresh = () =>
      [...page.querySelectorAll(".ideas-head-actions button")].find((button) => button.textContent?.includes("Refresh"));
    await click(refresh());
    expect(note()).toBe("Looking for new ideas…");
    // Under way: still looking.
    lastRun = run({ id: "run-2", trigger: "refresh", outcome: "running" });
    await wait(3_000);
    expect(lists()).toBe(2);
    expect(note()).toBe("Looking for new ideas…");
    lastRun = run({ id: "run-2", trigger: "refresh", outcome: "unchanged", generated: 0 });
    await wait(3_000);
    expect(lists()).toBe(3);
    expect(note()).toBe("Nothing new to suggest yet.");
    // Over: nothing more is read.
    await wait(30_000);
    expect(lists()).toBe(3);
    await click(refresh());
    lastRun = run({ id: "run-3", trigger: "refresh" });
    await wait(3_000);
    expect(note()).toBe("New ideas are in.");
    await click(refresh());
    lastRun = run({ id: "run-4", trigger: "refresh", outcome: "failed", reason: "The provider did not answer." });
    await wait(3_000);
    expect(note()).toBe("The provider did not answer.");
    // The footer says why the last look came to nothing.
    expect(page.querySelector(".ideas-foot")?.textContent).toContain("Last looked 10:00: The provider did not answer.");
  });

  it("stops reading after two minutes and says so; leaving the page ends the watch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, sent } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const lists = () => sent.filter((payload) => payload["action"] === "list").length;
    const wait = async (ms: number): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      await settle();
    };
    const refresh = () =>
      [...page.querySelectorAll(".ideas-head-actions button")].find((button) => button.textContent?.includes("Refresh"));
    await click(refresh());
    for (let index = 0; index < 41; index += 1) await wait(3_000);
    expect(announced()).toBe("Still looking — check back in a minute.");
    expect(lists()).toBe(1 + 40);
    await wait(30_000);
    expect(lists()).toBe(1 + 40);
    // A watch under way when the page goes: no read follows.
    await click(refresh());
    await wait(3_000);
    const before = lists();
    unmountAll();
    await wait(30_000);
    expect(lists()).toBe(before);
  });

  it("applies only the newest list read, whatever order the answers land in", async () => {
    const pending: ((ideas: readonly Idea[]) => void)[] = [];
    const client: SettingsClient = {
      request: (async (_command: string, payload: Record<string, unknown>) => {
        switch (payload["action"]) {
          case "list":
            return new Promise((resolve) =>
              pending.push((ideas) =>
                resolve({
                  ok: true,
                  result: { ideas, mutedCategories: [], excludedBasis: [], provider: "tavi.ideasagent", providers: [] },
                }),
              ),
            );
          case "brief":
            return { ok: true, result: { text: "old" } };
          default:
            return { ok: true, result: { text: payload["text"] } };
        }
      }) as SettingsClient["request"],
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const button = (label: string) => [...page.querySelectorAll("button")].find((element) => element.textContent?.includes(label));
    await click(button("Tune"));
    await click(button("Save"));
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]?.([idea("work.newer")]));
    await settle();
    await act(async () => pending[0]?.(IDEAS));
    await settle();
    expect(titles(page)).toEqual(["I can help with work.newer"]);
  });

  it("says Ideas are off, with the way to turn them on, and offers no cards or refresh", async () => {
    const opened: string[] = [];
    const page = await mount(
      <InWorkspace client={owner({ enabled: false }).client} workspaceId="default">
        <IdeasPage onTry={() => undefined} onSettings={() => opened.push("ideas")} />
      </InWorkspace>,
    );
    expect(page.querySelector(".ideas-off p")?.textContent).toBe("Ideas are off — turn them on in Settings → Ideas.");
    expect(page.querySelectorAll(".idea-card")).toHaveLength(0);
    expect(page.querySelector(".ideas-empty")).toBeNull();
    expect(
      [...page.querySelectorAll(".ideas-head-actions button")]
        .find((button) => button.textContent?.includes("Refresh"))
        ?.hasAttribute("disabled"),
    ).toBe(true);
    await click(page.querySelector(".ideas-off button"));
    expect(opened).toEqual(["ideas"]);
  });

  it("keeps an open Remind me through a list read that drops its card, reads the time on the workspace's clock, and puts focus back", async () => {
    let shown: readonly Idea[] = IDEAS;
    const { client, sent } = owner({
      get ideas() {
        return shown;
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="Europe/Sofia">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const cards = () => [...page.querySelectorAll(".idea-card")];
    const toggle = (card: Element | undefined) => card?.querySelector(".idea-menu > button");
    const item = (card: Element | undefined, label: string) =>
      [...(card?.querySelectorAll(".idea-menu-panel button") ?? [])].find((button) => button.textContent === label);
    // An action that keeps the card gives focus back to its ⋯.
    await click(toggle(cards()[0]));
    await click(item(cards()[0], "Pin"));
    expect(document.activeElement).toBe(toggle(cards()[0]));
    await click(toggle(cards()[0]));
    await click(item(cards()[0], "Remind me…"));
    const dialog = () => document.querySelector("dialog");
    expect(dialog()?.querySelector("label")?.textContent).toBe("When (Europe/Sofia time)");
    // Another card's action reads the list again, and the first card is gone from it: its dialog stays open.
    shown = IDEAS.slice(1);
    await click(toggle(cards()[1]));
    await click(item(cards()[1], "More like this"));
    expect(titles(page)).not.toContain(IDEAS[0]?.title);
    expect(dialog()?.textContent).toContain(IDEAS[0]?.title);
    const when = dialog()?.querySelector<HTMLInputElement>("input[type=datetime-local]");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(when, "2099-01-02T08:30");
      when?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => dialog()?.querySelector("form")?.requestSubmit());
    await settle();
    // 08:30 in Sofia, in winter, is 06:30 UTC.
    expect(sent.find((payload) => payload["action"] === "remind")).toMatchObject({ id: IDEAS[0]?.id, at: "2099-01-02T06:30:00.000Z" });
    expect(dialog()).toBeNull();
    // Its card is gone: focus goes to the page's heading.
    expect(document.activeElement).toBe(page.querySelector("h1"));
    // A menu action that takes its own card away does the same.
    const leaving = cards()[0]?.querySelector("h3")?.textContent;
    shown = shown.filter((entry) => entry.title !== leaving);
    await click(toggle(cards()[0]));
    await click(item(cards()[0], "Not now"));
    expect(document.activeElement).toBe(page.querySelector("h1"));
  });

  it("names the panels Tune and ⋯ control only while they are open; Tune can be cancelled", async () => {
    const page = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const tune = [...page.querySelectorAll(".ideas-head-actions button")].find((button) => button.textContent?.includes("Tune"));
    expect(tune?.hasAttribute("aria-controls")).toBe(false);
    await click(tune);
    expect(tune?.getAttribute("aria-controls")).toBe(page.querySelector(".ideas-tune")?.id);
    await click([...page.querySelectorAll(".ideas-tune button")].find((button) => button.textContent === "Cancel"));
    expect(page.querySelector(".ideas-tune")).toBeNull();
    expect(tune?.hasAttribute("aria-controls")).toBe(false);
    const toggle = page.querySelector(".idea-card .idea-menu > button");
    expect(toggle?.hasAttribute("aria-controls")).toBe(false);
    await click(toggle);
    expect(toggle?.getAttribute("aria-controls")).toBe(page.querySelector(".idea-menu-panel")?.id);
  });

  it("Settings → Ideas names a set-aside chat by its title, says why the last look came to nothing, shows the digest, and a failed reload", async () => {
    const { client } = owner(
      {
        lastRun: run({ outcome: "skipped", reason: "Outside the ideas hours" }),
        excludedBasis: ["task-9", "mem-7"],
        excludedSources: [
          { ref: "task-9", kind: "task", title: "Trip budget" },
          { ref: "mem-7", kind: "memory" },
        ],
      },
      false,
      undefined,
      { digest: { channel: "telegram-1", weekday: 1 } },
    );
    let broken = false;
    const failing: SettingsClient = {
      request: ((command: string, payload: Record<string, unknown>) =>
        broken && payload["action"] === "list"
          ? Promise.resolve({ ok: false, error: { code: "UNAVAILABLE", message: "the owner stopped" } })
          : client.request(command as never, payload as never)) as SettingsClient["request"],
    };
    const page = await mount(
      <InWorkspace client={failing} workspaceId="default" timeZone="UTC">
        <IdeasSettings />
      </InWorkspace>,
    );
    expect([...page.querySelectorAll(".item-row > span")].map((row) => row.textContent)).toEqual([
      "Chat “Trip budget”",
      "Something you told me (mem-7)",
    ]);
    expect(page.textContent).toMatch(/Last looked (\w{3} \d+ \w{3} )?10:00: Outside the ideas hours\./u);
    expect(page.querySelector(".ideas-digest")?.textContent).toBe(
      "Weekly digest: on, to connection telegram-1 every Monday. Set it with tavi ideas digest in a terminal.",
    );
    broken = true;
    await click(
      [...page.querySelectorAll("label")].find((label) => label.textContent?.includes("Suggest prompts"))?.querySelector("input"),
    );
    expect(page.querySelector(".failure")?.textContent).toContain("the owner stopped");
    // The page read before stays.
    expect(page.querySelector(".ideas-digest")).not.toBeNull();
    unmountAll();
    const off = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <IdeasSettings />
      </InWorkspace>,
    );
    expect(off.querySelector(".ideas-digest")?.textContent).toBe("Weekly digest: off. Set it with tavi ideas digest in a terminal.");
  });
  it("starts no watch from a refresh that answers after the page went", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client: base, sent } = owner();
    let answer: (() => void) | undefined;
    const client: SettingsClient = {
      request: ((command: string, payload: Record<string, unknown>) =>
        payload["action"] === "refresh"
          ? new Promise((resolve) => {
              sent.push({ command, ...payload });
              answer = () => resolve({ ok: true, result: { status: "started" } });
            })
          : base.request(command as never, payload as never)) as SettingsClient["request"],
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    await click([...page.querySelectorAll(".ideas-head-actions button")].find((button) => button.textContent?.includes("Refresh")));
    const lists = () => sent.filter((payload) => payload["action"] === "list").length;
    const before = lists();
    unmountAll();
    await act(async () => answer?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(lists()).toBe(before);
  });

  it("takes one Try it at a time, and opens nothing once the page went", async () => {
    const { client: base, sent } = owner();
    const answers: (() => void)[] = [];
    const client: SettingsClient = {
      request: ((command: string, payload: Record<string, unknown>) =>
        payload["action"] === "try"
          ? new Promise((resolve) => {
              sent.push({ command, ...payload });
              answers.push(() =>
                resolve({ ok: true, result: { prompt: `Help me with ${String(payload["id"]).slice(3)}.`, idea: IDEAS[0] } }),
              );
            })
          : base.request(command as never, payload as never)) as SettingsClient["request"],
    };
    const tried: string[] = [];
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <IdeasPage onTry={(_prompt, ideaId) => tried.push(ideaId)} />
      </InWorkspace>,
    );
    const tries = () => [...page.querySelectorAll(".idea-card .idea-actions button")].filter((button) => button.textContent === "Try it");
    await click(tries()[0]);
    expect(tries().every((button) => button.hasAttribute("disabled"))).toBe(true);
    await click(tries()[1]);
    expect(sent.filter((payload) => payload["action"] === "try")).toHaveLength(1);
    await act(async () => answers.splice(0).forEach((resolve) => resolve()));
    await settle();
    expect(tried).toEqual(["id-travel.fare-watch"]);
    expect(tries().some((button) => button.hasAttribute("disabled"))).toBe(false);
    // Asked, then the page left before the answer: no chat opens.
    await click(tries()[1]);
    unmountAll();
    await act(async () => answers.splice(0).forEach((resolve) => resolve()));
    expect(tried).toEqual(["id-travel.fare-watch"]);
  });

  it("a refresh queued behind a look under way waits for its own run, not the one it followed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(AT));
    let lastRun = run({ id: "run-2", trigger: "refresh", outcome: "running" });
    const { client } = owner({
      get lastRun() {
        return lastRun;
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    const note = () => announced();
    const wait = async (ms: number): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      await settle();
    };
    const refresh = () =>
      [...page.querySelectorAll(".ideas-head-actions button")].find((button) => button.textContent?.includes("Refresh"));
    // The owner's first answer is "started", its second "queued".
    await click(refresh());
    await click(refresh());
    expect(note()).toBe("A look is already under way; another follows it.");
    // The look it was queued behind ends: that is not this refresh's answer.
    lastRun = run({ id: "run-2", trigger: "refresh", outcome: "generated" });
    await wait(3_000);
    expect(note()).toBe("A look is already under way; another follows it.");
    // Nor is a scheduled look that ends meanwhile.
    lastRun = run({ id: "run-3", trigger: "schedule", outcome: "generated" });
    await wait(3_000);
    expect(note()).toBe("A look is already under way; another follows it.");
    lastRun = run({ id: "run-4", trigger: "refresh", outcome: "unchanged", generated: 0 });
    await wait(3_000);
    expect(note()).toBe("Nothing new to suggest yet.");
  });

  it("says a saved brief is read only where it will be, and Tune's Save and Cancel give focus back to Tune", async () => {
    const button = (page: HTMLElement, label: string) =>
      [...page.querySelectorAll("button")].find((element) => element.textContent?.includes(label));
    const off = await mount(
      <InWorkspace client={owner({ enabled: false }).client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    await click(button(off, "Tune"));
    await click(button(off, "Save"));
    expect(announced()).toBe("Brief saved. Ideas are off: no look reads it until they are on.");
    expect(document.activeElement).toBe(button(off, "Tune"));
    unmountAll();
    const on = await mount(
      <InWorkspace client={owner({ enabled: true }).client} workspaceId="default">
        <IdeasPage onTry={() => undefined} />
      </InWorkspace>,
    );
    await click(button(on, "Tune"));
    await click(button(on, "Cancel"));
    expect(document.activeElement).toBe(button(on, "Tune"));
    await click(button(on, "Tune"));
    await click(button(on, "Save"));
    expect(announced()).toBe("Brief saved.");
    expect(document.activeElement).toBe(button(on, "Tune"));
    // Settings → Ideas knows both switches, and says which keeps the brief unread.
    const saved = async (settings: Partial<IdeaSettings>): Promise<string | null | undefined> => {
      unmountAll();
      const page = await mount(
        <InWorkspace client={owner({}, false, undefined, settings).client} workspaceId="default">
          <IdeasSettings />
        </InWorkspace>,
      );
      const brief = page.querySelector<HTMLTextAreaElement>("textarea");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(brief, "Garden");
        brief?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click([...page.querySelectorAll("button")].find((element) => element.textContent === "Save brief"));
      return announced();
    };
    expect(await saved({})).toBe("Brief saved: the next look reads it.");
    expect(await saved({ enabled: false })).toBe("Brief saved. Ideas are off: no look reads it until they are on.");
    expect(await saved({ sources: { memory: true, tasks: true, brief: false } })).toBe(
      "Brief saved. Ideas do not read it while “Your brief” is off above.",
    );
  });
});
