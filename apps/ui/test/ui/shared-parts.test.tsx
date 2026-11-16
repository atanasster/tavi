// @vitest-environment jsdom
import type { PendingQuestionRow } from "@tavi/contracts";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppLink } from "../../src/features/shell/AppLink.js";
import { useUnsavedGuard } from "../../src/hooks/page.js";
import { useNow } from "../../src/hooks/use-poll.js";
import { useOpenError, useAction } from "../../src/hooks/use-action.js";
import { useLazyLoad, useSerialRead } from "../../src/hooks/use-loaded.js";
import { announced, freshAnnouncer } from "../announced.js";
import { answerOutcome, ANSWERED_ELSEWHERE, deliveryName, questionNeed, sentAnswer } from "../../src/features/needs/NeedCard.js";
import { appendPage, refreshFirstPage, useOlderPage } from "../../src/lib/paging.js";
import {
  ActionNote,
  BusyFieldset,
  DetailHead,
  Disclosure,
  Failure,
  InlineConfirm,
  LoadMore,
  LoadState,
  PageHead,
  Pending,
  StatusNote,
} from "../../src/ui/Parts.js";
import { when } from "../../src/lib/time.js";
import type { Outcome } from "../../src/lib/ipc.js";
import { centerPath, isPlainClick, reminderPath, routinePath, taskPath } from "../../src/features/shell/route.js";
import { FormActions, FormFailure } from "../../src/features/settings/FormParts.js";
import { mount, rerender, unmountAll } from "../support/dom.js";

/**
 * The pieces the canvas's areas share: paged lists, in-app addresses and
 * links, page heads, the inline confirm, form footers, and the hooks for the
 * time, a failed open, an unsaved draft and an action's note.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("paging", () => {
  const key = (item: { readonly id: string }) => item.id;
  const at = (item: { readonly at: string }) => item.at;

  it("appends the next page, each item once and the newer copy in its place", () => {
    const held = {
      items: [
        { id: "a", at: "3", v: 1 },
        { id: "b", at: "2", v: 1 },
      ],
      nextCursor: "c1",
      pages: 1,
    };
    expect(
      appendPage(
        held,
        {
          items: [
            { id: "b", at: "2", v: 2 },
            { id: "c", at: "1", v: 1 },
          ],
          nextCursor: "c2",
        },
        key,
      ),
    ).toEqual({
      items: [
        { id: "a", at: "3", v: 1 },
        { id: "b", at: "2", v: 2 },
        { id: "c", at: "1", v: 1 },
      ],
      nextCursor: "c2",
      pages: 2,
    });
    expect(appendPage(undefined, { items: [{ id: "a", at: "1" }] }, key)).toEqual({
      items: [{ id: "a", at: "1" }],
      nextCursor: undefined,
      pages: 2,
    });
  });

  it("keeps a refresh's older pages only below its last item", () => {
    const held = {
      items: [
        { id: "x", at: "5" },
        { id: "y", at: "1" },
      ],
      nextCursor: "p3",
      pages: 3,
    };
    expect(
      refreshFirstPage(
        held,
        {
          items: [
            { id: "n", at: "4" },
            { id: "m", at: "2" },
          ],
          nextCursor: "p2",
        },
        key,
        at,
      ),
    ).toEqual({
      items: [
        { id: "n", at: "4" },
        { id: "m", at: "2" },
        { id: "y", at: "1" },
      ],
      nextCursor: "p3",
      pages: 3,
    });
    // An empty fresh page keeps every older item.
    expect(refreshFirstPage(held, { items: [] }, key, at).items).toEqual(held.items);
  });
});

describe("in-app addresses", () => {
  it("spells each page as routePath does", () => {
    expect([taskPath("t 1"), routinePath("r/1"), reminderPath("m1"), centerPath("approvals"), centerPath("activity")]).toEqual([
      "/tasks/t%201",
      "/center/schedule/routines/r%2F1",
      "/center/schedule/reminders/m1",
      "/center/approvals",
      "/center",
    ]);
  });

  it("follows only a plain primary click", () => {
    const plain = { metaKey: false, ctrlKey: false, shiftKey: false, button: 0 };
    expect([
      isPlainClick(plain),
      isPlainClick({ ...plain, metaKey: true }),
      isPlainClick({ ...plain, ctrlKey: true }),
      isPlainClick({ ...plain, shiftKey: true }),
      isPlainClick({ ...plain, button: 1 }),
    ]).toEqual([true, false, false, false, false]);
  });

  it("follows a link in place, and leaves a modified click or a page with nowhere to go to the browser", async () => {
    const follow = vi.fn();
    const host = await mount(
      <>
        <AppLink href="/tasks/t1" className="x" onFollow={follow}>
          Open
        </AppLink>
        <AppLink href="/tasks/t2" onFollow={undefined}>
          Nowhere
        </AppLink>
      </>,
    );
    const [first, second] = [...host.querySelectorAll("a")];
    expect(first?.outerHTML).toBe('<a class="x" href="/tasks/t1">Open</a>');
    expect(second?.outerHTML).toBe('<a href="/tasks/t2">Nowhere</a>');
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => void first?.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(true);
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    act(() => void first?.dispatchEvent(modified));
    expect(modified.defaultPrevented).toBe(false);
    const nowhere = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => void second?.dispatchEvent(nowhere));
    expect(nowhere.defaultPrevented).toBe(false);
    expect(follow).toHaveBeenCalledTimes(1);
  });
});

describe("when", () => {
  it("says an owner timestamp in the workspace zone, the day only when it is not today there", () => {
    const now = new Date("2026-10-04T15:00:00.000Z");
    expect(when("2026-10-04T09:30:00.000Z", "UTC", "—", now)).toBe("09:30");
    // In Tokyo it is already the 5th, so 18:30 there on the 4th is yesterday.
    expect(when("2026-10-04T09:30:00.000Z", "Asia/Tokyo", "—", now)).toBe("Sun 4 Oct 18:30");
    // 03:30 UTC on the 4th is the evening of the 3rd in Los Angeles.
    expect(when("2026-10-04T03:30:00.000Z", "America/Los_Angeles", "—", now)).toBe("Sat 3 Oct 20:30");
    expect(when(undefined, "UTC", "never", now)).toBe("never");
    expect(when("soon", "UTC", "—", now)).toBe("soon");
  });
});

describe("shared parts", () => {
  it("renders a page head with and without the line under its title", async () => {
    const host = await mount(
      <>
        <PageHead className="settings-head" title="Plugins">
          <button type="button">Install</button>
        </PageHead>
        <PageHead className="center-head" id="t" title="Activity" description="Every task." />
      </>,
    );
    const [bare, described] = [...host.querySelectorAll("header")];
    expect(bare?.outerHTML).toBe('<header class="settings-head"><h1>Plugins</h1><button type="button">Install</button></header>');
    expect(described?.outerHTML).toBe(
      '<header class="center-head"><div><h1 id="t">Activity</h1><p class="settings-description">Every task.</p></div></header>',
    );
  });

  it("renders a drilled-in page's head, its title focusable", async () => {
    const host = await mount(<DetailHead back="Routines" onBack={() => {}} headingRef={null} title="News" description="Daily" />);
    expect(host.innerHTML).toBe(
      '<button type="button" class="button-sm ghost back-link">← Routines</button><header class="settings-head"><div><h2 class="page-title" tabindex="-1">News</h2><p class="settings-description">Daily</p></div></header>',
    );
  });

  it("says loading, a failure, a note and a next page", async () => {
    const host = await mount(
      <>
        <Pending error={undefined} />
        <Pending error="boom" />
        <StatusNote note={undefined} />
        <StatusNote note="Saved." />
        <LoadMore busy={false} onLoad={() => {}} />
        <LoadMore busy label="Load more" className="center-more extra" onLoad={() => {}}>
          <span>2 of 3</span>
        </LoadMore>
      </>,
    );
    expect(host.innerHTML).toBe(
      '<p class="empty">Loading…</p><p class="failure">boom</p><p class="notice">Saved.</p>' +
        '<p class="center-more"><button type="button" class="button-sm">Load older</button></p>' +
        '<p class="center-more extra"><span>2 of 3</span><button type="button" class="button-sm" disabled="">Loading…</button></p>',
    );
  });

  it("says each of them as its site does: another class, no class, no live region, Retry", async () => {
    const reload = vi.fn();
    const host = await mount(
      <>
        <Pending label="Loading run…" className="notice" status />
        <Pending className="" label="Loading agents…" />
        <Pending error="down" reload={reload} />
        <StatusNote note="Copied." className="" />
        <StatusNote note="Kept." className="notice memory-row-note" />
        <StatusNote note="More." announce={false} />
        <Failure message={undefined} />
        <Failure message="Refused." />
        <Failure message="Not opened." alert={false} />
      </>,
    );
    expect(host.innerHTML).toBe(
      '<p class="notice">Loading run…</p><p>Loading agents…</p>' +
        '<p class="failure" role="alert">down <button type="button">Retry</button></p>' +
        '<p>Copied.</p><p class="notice memory-row-note">Kept.</p><p class="notice">More.</p>' +
        '<p class="failure" role="alert">Refused.</p><p class="failure">Not opened.</p>',
    );
    act(() => host.querySelector("button")?.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("says a note through the page's one live region, which was there before the note", async () => {
    const region = freshAnnouncer();
    function Saver() {
      const [note, setNote] = useState<string>();
      return (
        <>
          <button type="button" onClick={() => setNote("Saved.")}>
            Save
          </button>
          <StatusNote note={note} />
          <StatusNote note="Quiet." announce={false} />
        </>
      );
    }
    const host = await mount(<Saver />);
    expect(announced()).toBe("");
    act(() => host.querySelector("button")?.click());
    expect(document.getElementById("announcer")).toBe(region);
    expect(announced()).toBe("Saved.");
    // The line on the page is no live region of its own: two would talk over each other.
    expect(host.querySelector('[role="status"], [aria-live]')).toBeNull();
  });

  it("keeps a form's place while it saves: focus waits on a Saving line, then goes back to Save", async () => {
    function Form() {
      const [busy, setBusy] = useState(false);
      return (
        <form>
          <BusyFieldset busy={busy} className="settings-fields">
            <input aria-label="Name" />
            <button type="button" onClick={() => setBusy(true)}>
              Save
            </button>
          </BusyFieldset>
          <button type="button" onClick={() => setBusy(false)}>
            Done
          </button>
        </form>
      );
    }
    const host = await mount(<Form />);
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    save.focus();
    act(() => save.click());
    // Not dropped to the page's body as the fields disable: a line says what is happening.
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.querySelector("fieldset")?.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Saving…");
    act(() =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Done")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(document.activeElement).toBe(save);
    expect(host.querySelector("fieldset")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("keeps that place in a browser that drops focus the moment a fieldset disables, as Chromium does", async () => {
    const setAttribute = Element.prototype.setAttribute;
    const blurring = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name, value) {
      if (name === "disabled" && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setAttribute.call(this, name, value);
    });
    function Form() {
      const [busy, setBusy] = useState(false);
      return (
        <>
          <BusyFieldset busy={busy}>
            <button type="button" onClick={() => setBusy(true)}>
              Save
            </button>
          </BusyFieldset>
          <button type="button" onClick={() => setBusy(false)}>
            Done
          </button>
        </>
      );
    }
    try {
      const host = await mount(<Form />);
      const [save, done] = host.querySelectorAll("button");
      save?.focus();
      act(() => save?.click());
      expect(document.activeElement?.textContent).toBe("Saving…");
      act(() => done?.click());
      expect(document.activeElement).toBe(save);
    } finally {
      blurring.mockRestore();
    }
  });

  it("shows a page's failed reload, its note and its loading line each on its own", async () => {
    const host = await mount(
      <>
        <LoadState error="down" reload={() => {}} loading label="Loading activity…" status>
          <span>note</span>
        </LoadState>
        <LoadState error={undefined} reload={() => {}} loading={false} />
        <LoadState error={undefined} reload={() => {}} loading />
      </>,
    );
    expect(host.innerHTML).toBe(
      '<p class="failure" role="alert">down <button type="button">Retry</button></p><span>note</span><p class="notice">Loading activity…</p>' +
        '<p class="notice">Loading…</p>',
    );
  });

  it("offers a next page as a bare button that keeps its words while busy", async () => {
    const host = await mount(
      <LoadMore
        className={null}
        buttonClassName="ghost button-sm"
        busy
        label="Load older runs"
        busyLabel="Load older runs"
        onLoad={() => {}}
      />,
    );
    expect(host.innerHTML).toBe('<button type="button" class="ghost button-sm" disabled="">Load older runs</button>');
  });

  it("asks a row action's second question inline, its way back never disabled", async () => {
    const confirm = vi.fn();
    const keep = vi.fn();
    const host = await mount(
      <span className="item-actions">
        <InlineConfirm
          inline
          message={<>Remove “Brief”?</>}
          confirmLabel="Confirm removal"
          cancelLabel="Keep schedule"
          busy
          onConfirm={confirm}
          onCancel={keep}
        />
      </span>,
    );
    expect(host.innerHTML).toBe(
      '<span class="item-actions"><span>Remove “Brief”?</span><button type="button" class="button-sm" disabled="">Confirm removal</button><button type="button" class="button-sm ghost">Keep schedule</button></span>',
    );
    act(() => host.querySelectorAll("button")[1]?.click());
    expect(keep).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("draws a row's disclosure: the toggle, and while open its loading line, failure and list", async () => {
    const closed = await mount(
      <Disclosure
        className="center-followups"
        id="list-1"
        label="2 follow-ups"
        open={false}
        onToggle={() => {}}
        loading={false}
        loadingLabel="Loading…"
        error={undefined}
        reload={() => {}}
      >
        <ol />
      </Disclosure>,
    );
    expect(closed.querySelector("button")?.outerHTML).toMatch(
      /^<button type="button" class="button-bare center-followups-toggle" aria-expanded="false" aria-controls="list-1">2 follow-ups <svg/,
    );
    expect(closed.querySelector("#list-1")).toBeNull();
    const open = await mount(
      <Disclosure
        className="browser-visits"
        id="list-2"
        label="Hide visits"
        open
        onToggle={() => {}}
        loading
        loadingLabel="Loading visits…"
        error="down"
        reload={() => {}}
      >
        <ol className="browser-visits-list" />
      </Disclosure>,
    );
    expect(open.querySelector("#list-2")?.innerHTML).toBe(
      '<p class="muted">Loading visits…</p><p class="failure" role="alert">down <button type="button">Retry</button></p><ol class="browser-visits-list"></ol>',
    );
  });

  it("opens an inline confirm on its way back, so a repeated Enter cannot confirm", async () => {
    const confirm = vi.fn();
    const host = await mount(
      <InlineConfirm
        focusCancel
        label="Unsaved"
        message="Discard?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={confirm}
        onCancel={() => {}}
      />,
    );
    expect(host.innerHTML).toBe(
      '<div class="confirmation" role="group" aria-label="Unsaved"><p>Discard?</p><div class="actions"><button type="button" class="button-sm button-danger">Discard</button><button type="button" class="button-sm ghost">Keep editing</button></div></div>',
    );
    expect(document.activeElement?.textContent).toBe("Keep editing");
    const large = await mount(
      <InlineConfirm
        small={false}
        busy={false}
        className="extra"
        message="Run?"
        confirmLabel="Confirm"
        cancelLabel="Go back"
        onConfirm={confirm}
        onCancel={() => {}}
      />,
    );
    expect(large.querySelector(".confirmation")?.className).toBe("confirmation extra");
    expect([...large.querySelectorAll("button")].map((button) => button.className)).toEqual(["button-danger", "ghost"]);
  });

  it("lays a form's footer out as a dialog's or an inline form's", async () => {
    const host = await mount(
      <>
        <FormActions saving={false} label="Save" onCancel={() => {}} />
        <FormActions small saving disabled cancelDisabled label="Remember" onCancel={() => {}} />
        <FormFailure message={undefined} />
        <FormFailure message="Refused." />
      </>,
    );
    expect(host.innerHTML).toBe(
      '<div class="actions"><button type="button" class="ghost">Cancel</button><button type="submit" class="button-primary">Save</button></div>' +
        '<div class="actions"><button type="submit" class="button-sm button-primary" disabled="">Saving…</button><button type="button" class="button-sm ghost" disabled="">Cancel</button></div>' +
        '<p class="failure" role="alert">Refused.</p>',
    );
  });
});

describe("question helpers", () => {
  const row = {
    question: "Ship?",
    context: "Flaky",
    deadlineAt: "2026-10-02T14:30:00.000Z",
    askedAt: "2026-10-02T14:00:00.000Z",
    deliveries: [{ connectionId: "tg", channel: "Telegram" }, { connectionId: "mail" }],
  } as unknown as PendingQuestionRow;

  it("builds a card's need, listing the chats only when asked to name them", () => {
    expect(questionNeed(row)).toEqual({
      question: "Ship?",
      choices: undefined,
      context: "Flaky",
      deadlineAt: row.deadlineAt,
      askedAt: row.askedAt,
    });
    expect(questionNeed(row, deliveryName, "Release")).toMatchObject({ askedBy: "Release", channels: ["Telegram", "mail"] });
  });

  it("says where an answer stands", () => {
    expect(answerOutcome("1", { ok: true })).toEqual({ status: "recorded", text: "1" });
    expect(answerOutcome("1", { ok: false, code: "CONFLICT", message: "x" })).toEqual({
      status: "uncertain",
      text: "1",
      message: ANSWERED_ELSEWHERE,
    });
    expect(answerOutcome("1", { ok: false, message: "down" })).toEqual({ status: "failed", text: "1", message: "down" });
    expect([
      sentAnswer(undefined),
      sentAnswer({ status: "sending", text: "a" }),
      sentAnswer({ status: "failed", text: "a", message: "m" }),
    ]).toEqual([undefined, { status: "sending", text: "a" }, { status: "failed", text: "a", message: "m" }]);
  });
});

describe("shared hooks", () => {
  it("moves the time while enabled, and reads it at once when enabled again", async () => {
    let time = 1_000;
    const clock = () => time;
    let shown: number | undefined;
    let enable: (on: boolean) => void = () => {};
    vi.useFakeTimers();
    function Clock() {
      const [on, setOn] = useState(true);
      enable = setOn;
      shown = useNow(100, on, clock);
      return null;
    }
    await mount(<Clock />);
    expect(shown).toBe(1_000);
    time = 1_100;
    await act(async () => void vi.advanceTimersByTime(100));
    expect(shown).toBe(1_100);
    act(() => enable(false));
    time = 5_000;
    await act(async () => void vi.advanceTimersByTime(1_000));
    expect(shown).toBe(1_100);
    act(() => enable(true));
    expect(shown).toBe(5_000);
  });

  it("reads a disclosure's list on its first open only, again on a retry, and again when its key moves while open", async () => {
    let answer: Outcome<string> = { ok: true, value: "first" };
    const read = vi.fn(async () => answer);
    let lazy: ReturnType<typeof useLazyLoad<string>> | undefined;
    function List({ count }: { readonly count: number }) {
      lazy = useLazyLoad(read, count);
      return null;
    }
    await mount(<List count={1} />);
    expect(read).not.toHaveBeenCalled();
    await act(async () => lazy?.toggle());
    expect([read.mock.calls.length, lazy?.open, lazy?.loaded, lazy?.loading]).toEqual([1, true, "first", false]);
    // Closed and opened again, the list held is shown without a read.
    await act(async () => lazy?.toggle());
    await act(async () => lazy?.toggle());
    expect(read).toHaveBeenCalledTimes(1);
    answer = { ok: false, message: "down" };
    await act(async () => lazy?.load());
    expect([read.mock.calls.length, lazy?.error, lazy?.loaded]).toEqual([2, "down", "first"]);
    // A moved key drops what is held and, the list being open, reads it again.
    answer = { ok: true, value: "second" };
    await rerender(<List count={2} />);
    expect([read.mock.calls.length, lazy?.loaded, lazy?.error]).toEqual([3, "second", undefined]);
    // Closed, a moved key only drops it: the next open reads.
    await act(async () => lazy?.toggle());
    await rerender(<List count={3} />);
    expect([read.mock.calls.length, lazy?.loaded]).toEqual([3, undefined]);
  });

  it("drops a disclosure's answer read for a key that moved while it was closed", async () => {
    let settle: (value: Outcome<string>) => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<Outcome<string>>((resolve) => {
          settle = resolve;
        }),
    );
    let lazy: ReturnType<typeof useLazyLoad<string>> | undefined;
    function List({ count }: { readonly count: number }) {
      lazy = useLazyLoad(read, count);
      return null;
    }
    await mount(<List count={1} />);
    await act(async () => lazy?.toggle());
    const stale = settle;
    await act(async () => lazy?.toggle());
    await rerender(<List count={2} />);
    await act(async () => stale({ ok: true, value: "before" }));
    expect([lazy?.loaded, lazy?.loading]).toEqual([undefined, false]);
    await act(async () => lazy?.toggle());
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => settle({ ok: true, value: "after" }));
    expect(lazy?.loaded).toBe("after");
  });

  it("keeps one read in flight, running one asked for meanwhile once it ends", async () => {
    let serial: ReturnType<typeof useSerialRead> | undefined;
    function Reader() {
      serial = useSerialRead();
      return null;
    }
    await mount(<Reader />);
    const next = vi.fn();
    expect(serial?.begin()).toBe(true);
    expect(serial?.begin()).toBe(false);
    expect(serial?.begin()).toBe(false);
    serial?.end(next);
    expect(next).toHaveBeenCalledTimes(1);
    // Nothing asked meanwhile: nothing runs after.
    expect(serial?.begin()).toBe(true);
    serial?.end(next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("reads one older page at a time, and drops one a newer first page overtook", async () => {
    const generation = { current: 0 };
    let older: ReturnType<typeof useOlderPage> | undefined;
    function List() {
      older = useOlderPage(generation);
      return null;
    }
    await mount(<List />);
    let answer: (outcome: Outcome<string>) => void = () => {};
    const read = vi.fn((_cursor: string) => new Promise<Outcome<string>>((resolve) => (answer = resolve)));
    const pages: string[] = [];
    const failures: string[] = [];
    act(() =>
      older?.load(
        undefined,
        read,
        (page) => pages.push(page),
        (message) => failures.push(message),
      ),
    );
    expect(read).not.toHaveBeenCalled();
    act(() =>
      older?.load(
        "c1",
        read,
        (page) => pages.push(page),
        (message) => failures.push(message),
      ),
    );
    expect([read.mock.calls[0]?.[0], older?.busy]).toEqual(["c1", true]);
    // A second ask while the first is read asks nothing.
    act(() =>
      older?.load(
        "c1",
        read,
        (page) => pages.push(page),
        (message) => failures.push(message),
      ),
    );
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ok: true, value: "p2" }));
    expect([pages, older?.busy]).toEqual([["p2"], false]);
    act(() =>
      older?.load(
        "c2",
        read,
        (page) => pages.push(page),
        (message) => failures.push(message),
      ),
    );
    generation.current += 1;
    await act(async () => answer({ ok: false, message: "down" }));
    expect([pages, failures, older?.busy]).toEqual([["p2"], [], false]);
    act(() =>
      older?.load(
        "c2",
        read,
        (page) => pages.push(page),
        (message) => failures.push(message),
      ),
    );
    await act(async () => answer({ ok: false, message: "down" }));
    expect(failures).toEqual(["down"]);
  });

  it("names what could not be opened, and clears it as the next open begins", async () => {
    let opened: ReturnType<typeof useOpenError> | undefined;
    function Opener() {
      opened = useOpenError();
      return null;
    }
    await mount(<Opener />);
    await act(async () => opened?.open("Task t1", () => Promise.reject(new Error("gone"))));
    expect(opened?.openError).toBe("Task t1 could not be opened: gone");
    await act(async () => opened?.open("Task t2", () => Promise.resolve()));
    expect(opened?.openError).toBeUndefined();
  });

  it("asks before a reload only while dirty", async () => {
    function Editor({ dirty }: { readonly dirty: boolean }) {
      useUnsavedGuard(dirty);
      return null;
    }
    const unload = (): Event => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event;
    };
    await mount(<Editor dirty={false} />);
    expect(unload().defaultPrevented).toBe(false);
    await rerender(<Editor dirty />);
    expect(unload().defaultPrevented).toBe(true);
    await rerender(<Editor dirty={false} />);
    expect(unload().defaultPrevented).toBe(false);
  });

  it("puts a dialog's own success over the note until the next action", async () => {
    let action: ReturnType<typeof useAction> | undefined;
    function Page() {
      action = useAction(() => {});
      return null;
    }
    await mount(<Page />);
    await act(async () => action?.run("a", async () => ({ ok: true, value: "Ran." })));
    expect(action?.note).toBe("Ran.");
    act(() => action?.say("Stored."));
    expect(action?.note).toBe("Stored.");
    let finish: (value: { readonly ok: false; readonly message: string }) => void = () => {};
    let running: Promise<void> | undefined;
    act(() => {
      running = action?.run("b", () => new Promise((resolve) => (finish = resolve)));
    });
    // The dialog's note gives way as the next action starts; the last action's shows meanwhile.
    expect(action?.note).toBe("Ran.");
    await act(async () => {
      finish({ ok: false, message: "Refused." });
      await running;
    });
    expect(action?.note).toBe("Refused.");
    expect(action?.tone).toBe("failure");
  });

  it("says whether an action's note is its success or its refusal", async () => {
    let action: ReturnType<typeof useAction> | undefined;
    function Page() {
      action = useAction(() => {});
      return <ActionNote note={action.note} tone={action.tone} />;
    }
    const page = await mount(<Page />);
    expect(action?.tone).toBe("note");
    await act(async () => action?.run("a", async () => ({ ok: false, message: "Refused: in flight." })));
    expect(action?.tone).toBe("failure");
    expect(page.querySelector(".failure")?.getAttribute("role")).toBe("alert");
    expect(page.querySelector(".failure")?.textContent).toBe("Refused: in flight.");
    await act(async () => action?.run("b", async () => ({ ok: true, value: "Morning brief paused." })));
    expect(action?.tone).toBe("note");
    expect(page.querySelector(".failure")).toBeNull();
    expect(page.querySelector(".notice")?.textContent).toBe("Morning brief paused.");
    // A dialog's own word is a note, whatever came before.
    await act(async () => action?.run("c", async () => ({ ok: false, message: "No." })));
    act(() => action?.say("Stored."));
    expect(action?.tone).toBe("note");
  });
});
