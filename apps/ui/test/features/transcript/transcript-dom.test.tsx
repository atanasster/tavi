// @vitest-environment jsdom
import type { ToolCard } from "@tavi/client/browser";
import { act, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FOLLOW_THRESHOLD, TURN_GAP, useAutoscroll, useScrollIntoView } from "../../../src/hooks/scroll.js";
import { Transcript } from "../../../src/features/transcript/Transcript.js";
import { EntryBoundary, OpenChatContext, TOOL_RENDERERS } from "../../../src/features/transcript/ToolCards.js";
import { markdownReady } from "../../../src/ui/Markdown.js";
import { click, mount, rerender } from "../../support/dom.js";
import { textEntry as text, toolCard as card } from "../../support/rows.js";

/**
 * The two parts of the transcript's drawing that need a DOM: an entry that throws taking only its
 * own row, and the threshold the transcript follows the stream by.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an entry that cannot be rendered", () => {
  it("takes its own row and nothing else", async () => {
    // React logs the caught error; the test is about what the reader sees.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = (): never => {
      throw new Error("a payload this page cannot draw");
    };
    const page = await mount(
      <>
        <EntryBoundary what="answer">
          <p className="text">before</p>
        </EntryBoundary>
        <EntryBoundary what="toolCall">
          <Boom />
        </EntryBoundary>
        <EntryBoundary what="answer">
          <p className="text">after</p>
        </EntryBoundary>
      </>,
    );
    expect(page.textContent).toContain("before");
    expect(page.textContent).toContain("after");
    expect(page.querySelector(".unrendered")?.textContent).toContain("This tool call could not be shown");
    expect(page.querySelector(".unrendered")?.textContent).toContain("a payload this page cannot draw");
    expect(page.querySelector(".unrendered")?.textContent).toContain("The rest of the session is unaffected.");
  });

  it("survives a renderer that throws on an odd payload, rather than blanking the transcript", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const family = TOOL_RENDERERS["sandbox"];
    expect(family).toBeDefined();
    vi.spyOn(family as { headline?: (card: ToolCard) => string | undefined }, "headline").mockImplementation(() => {
      throw new Error("bad payload");
    });
    const page = await mount(<Transcript entries={[text("t1", "an answer"), card("c1")]} />);
    // The headline is skipped; the card and its neighbour are still there.
    expect(page.textContent).toContain("an answer");
    expect(page.textContent).toContain("sandbox.run");
    expect(page.querySelector(".unrendered")).toBeNull();
  });
});

describe("a past-chat search's card", () => {
  const search = (over: Partial<ToolCard>): ToolCard =>
    card("s1", { toolName: "sessions.search", input: { query: "ACME budget" }, ...over });
  const answer = {
    found: 2,
    matches: [
      { taskId: "t-apart", title: "ACME renewal and the Lisbon budget", at: "2026-09-01T00:00:01.000Z", excerpt: "…" },
      { taskId: "t-one", title: "ACME call notes", at: "2026-09-01T00:00:00.000Z", excerpt: "…" },
    ],
  };

  it("says what it did and how many it found, and links each chat by its title, opened in place", async () => {
    const opened: string[] = [];
    const page = await mount(
      <OpenChatContext.Provider value={(taskId) => opened.push(taskId)}>
        <Transcript entries={[search({ output: answer })]} />
      </OpenChatContext.Provider>,
    );
    expect(page.querySelector("summary")?.textContent).toContain("Searched earlier chats · 2 found");
    expect(page.querySelector("summary")?.textContent).toContain("ACME budget");
    const list = page.querySelector("ul[aria-label='Earlier chats found']");
    const links = [...(list?.querySelectorAll("a") ?? [])];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["ACME renewal and the Lisbon budget", "/tasks/t-apart"],
      ["ACME call notes", "/tasks/t-one"],
    ]);
    await act(async () => links[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(opened).toEqual(["t-one"]);
  });

  it("cites the chats an oversized answer's preview still holds, and says how many it cannot list", async () => {
    const preview = JSON.stringify({
      found: 3,
      matches: [...answer.matches, { taskId: "t-cut", title: "cut", at: "x", excerpt: "y" }],
    }).slice(0, 220);
    const page = await mount(
      <Transcript entries={[search({ output: { truncated: true, note: "payload exceeded 8192 bytes", preview } })]} />,
    );
    expect(page.querySelector("summary")?.textContent).toContain("Searched earlier chats · 3 found");
    expect([...page.querySelectorAll("ul.past-chats a")].map((link) => link.textContent)).toEqual([
      "ACME renewal and the Lisbon budget",
      "ACME call notes",
    ]);
    expect(page.textContent).toContain("1 more chat not listed");
  });

  it("keeps the tool's own line when it failed", async () => {
    const page = await mount(<Transcript entries={[search({ status: "failed", message: "boom" })]} />);
    expect(page.querySelector("summary code")?.textContent).toBe("sessions.search");
    expect(page.querySelector("ul.past-chats")).toBeNull();
  });

  it("says a failed call's {error, detail} as its code and its words, with the detail's own lines", async () => {
    const detail =
      "desktop control's helper is not built: run, in the terminal you grant Accessibility and Screen Recording to:\n  cd helper\n  swift build";
    const page = await mount(
      <Transcript
        entries={[card("d1", { toolName: "desktop.type", status: "failed", message: JSON.stringify({ error: "NOT_CONFIGURED", detail }) })]}
      />,
    );
    expect(page.querySelector(".failure")?.textContent).toBe(`NOT_CONFIGURED: ${detail}`);
    // As a tool's failure reaches the page: with whether to retry beside it (QA 1904).
    await rerender(
      <Transcript
        entries={[
          card("d3", {
            toolName: "desktop.observe",
            status: "failed",
            message: JSON.stringify({ error: "NOT_CONFIGURED", detail, retryable: false }),
          }),
        ]}
      />,
    );
    expect(page.querySelector(".failure")?.textContent).toBe(`NOT_CONFIGURED: ${detail}`);
    // A message that is not that shape is shown as it came.
    await rerender(<Transcript entries={[card("d2", { status: "failed", message: '{"error":"X","extra":1}' })]} />);
    expect(page.querySelector(".failure")?.textContent).toBe('{"error":"X","extra":1}');
  });

  it("says it is searching while it runs, and lists nothing yet", async () => {
    const page = await mount(<Transcript entries={[search({ status: "running" })]} />);
    expect(page.querySelector("summary")?.textContent).toContain("Searching earlier chats");
    expect(page.querySelector("ul.past-chats")).toBeNull();
  });
});

describe("scroll discipline", () => {
  /** A scroll container whose geometry the test controls, since jsdom lays nothing out. */
  function Harness({ count, size, of }: { readonly count: number; readonly size?: number; readonly of?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const { following, missed, jump } = useAutoscroll(ref, size ?? count, count, of);
    return (
      <div>
        <div className="runs" ref={ref} />
        <span className="state">{following ? "following" : `missed ${missed}`}</span>
        <button type="button" onClick={jump}>
          Jump
        </button>
      </div>
    );
  }

  /** Give the container a layout jsdom will not: `scrollTop` is writable, the rest are not. */
  function measure(element: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }): void {
    Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(element, "clientHeight", { value: clientHeight, configurable: true });
  }

  it("stays at the end when the scroller shrinks under a reader following it, and not when they scrolled away", async () => {
    // The composer growing (attachments, a long draft) shrinks the scroller: its last lines must not slip under it.
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const page = await mount(<Harness count={1} />);
    const runs = page.querySelector<HTMLDivElement>(".runs");
    if (runs === null) throw new Error("no scroller");
    measure(runs, { scrollHeight: 1000, clientHeight: 400 });
    runs.scrollTop = 600;
    measure(runs, { scrollHeight: 1000, clientHeight: 300 });
    act(() => observers.forEach((observe) => observe()));
    expect(runs.scrollTop).toBe(1000);
    // Scrolled away: a resize leaves the reader where they are.
    runs.scrollTop = 100;
    await act(async () => runs.dispatchEvent(new Event("scroll")));
    measure(runs, { scrollHeight: 1000, clientHeight: 250 });
    act(() => observers.forEach((observe) => observe()));
    expect(runs.scrollTop).toBe(100);
    vi.unstubAllGlobals();
  });

  it("follows the stream while the reader is near the bottom, and counts what they miss when they are not", async () => {
    const page = await mount(<Harness count={1} />);
    const runs = page.querySelector<HTMLDivElement>(".runs");
    expect(runs).not.toBeNull();
    if (runs === null) return;
    measure(runs, { scrollHeight: 1000, clientHeight: 200 });
    expect(page.querySelector(".state")?.textContent).toBe("following");
    // Following: a new entry is scrolled to rather than counted.
    await rerender(<Harness count={2} />);
    expect(page.querySelector(".state")?.textContent).toBe("following");
    expect(runs.scrollTop).toBe(1000);

    // The reader scrolls away, well past the threshold: the view stops moving.
    runs.scrollTop = 100;
    await act(async () => runs.dispatchEvent(new Event("scroll")));
    expect(page.querySelector(".state")?.textContent).toBe("missed 0");

    // Three more arrive while they are up there: counted, and the view stays put.
    await rerender(<Harness count={5} />);
    expect(page.querySelector(".state")?.textContent).toBe("missed 3");
    expect(runs.scrollTop).toBe(100);
  });

  it("follows a streaming answer, which grows one block rather than adding entries", async () => {
    // One text block, getting longer: the entry count never moves (the
    // reducer folds each delta into the block of the same id).
    const page = await mount(<Harness count={1} size={10} />);
    const runs = page.querySelector<HTMLDivElement>(".runs");
    if (runs === null) return;
    measure(runs, { scrollHeight: 400, clientHeight: 200 });
    runs.scrollTop = 0;
    await rerender(<Harness count={1} size={200} />);
    // Followed: the view went to the bottom without a new entry arriving.
    expect(runs.scrollTop).toBe(400);
    // And nothing is counted as "new": no entry arrived.
    expect(page.querySelector(".state")?.textContent).toBe("following");
  });

  it("does not take its own scroll for the reader leaving, when the view grew before the event came", async () => {
    // A sent message's turn is drawn after the write that followed it: the event of that write reads a view far from
    // the end, and QA's transcript never followed again.
    const page = await mount(<Harness count={1} />);
    const runs = page.querySelector<HTMLDivElement>(".runs");
    if (runs === null) return;
    measure(runs, { scrollHeight: 500, clientHeight: 400 });
    await rerender(<Harness count={2} />);
    expect(runs.scrollTop).toBe(500);
    measure(runs, { scrollHeight: 1100, clientHeight: 400 });
    await act(async () => runs.dispatchEvent(new Event("scroll")));
    expect(page.querySelector(".state")?.textContent).toBe("following");
    await rerender(<Harness count={3} />);
    expect(runs.scrollTop).toBe(1100);
  });

  it("follows what grew the view without a new entry: a card's body, read after it was posted", async () => {
    function Growing({ tall }: { readonly tall: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useAutoscroll(ref, 1, 1);
      return (
        <div className="runs" ref={ref}>
          {tall ? <p>Keep</p> : null}
        </div>
      );
    }
    const page = await mount(<Growing tall={false} />);
    const runs = page.querySelector<HTMLDivElement>(".runs");
    if (runs === null) return;
    measure(runs, { scrollHeight: 900, clientHeight: 400 });
    await rerender(<Growing tall />);
    await act(async () => undefined);
    expect(runs.scrollTop).toBe(900);
  });

  describe("a sent turn", () => {
    /** A chat of one message at `top` in the scroller, with what `useAutoscroll` hands back written out. */
    function Turn(props: { readonly size: number; readonly turn?: string; readonly asks?: readonly string[]; readonly of?: string }) {
      const ref = useRef<HTMLDivElement>(null);
      const { following, missed, behind, jump } = useAutoscroll(ref, props.size, 1, props.of ?? "chat", {
        ...(props.turn === undefined ? {} : { turn: props.turn }),
        ...(props.asks === undefined ? {} : { asks: props.asks }),
      });
      return (
        <div>
          <div className="runs" ref={ref}>
            <div className="user-message" data-run="turn-2" />
            <div className="card" data-waiting="" />
          </div>
          <span className="state">{following ? "following" : `missed ${missed}`}</span>
          <span className="behind">{behind ? "behind" : "caught up"}</span>
          <button type="button" onClick={jump}>
            Jump
          </button>
        </div>
      );
    }
    /** Puts the message `top` px down the scroller's view, wherever it is scrolled to. */
    function messageAt(runs: HTMLElement, top: number): void {
      const message = runs.querySelector(".user-message");
      if (message === null) throw new Error("no message");
      message.getBoundingClientRect = () => ({ top: top - runs.scrollTop }) as DOMRect;
    }

    it("brings its message to the top of the view, and stops there with the jump on offer as the answer runs on", async () => {
      const page = await mount(<Turn size={10} />);
      const runs = page.querySelector<HTMLDivElement>(".runs");
      if (runs === null) return;
      measure(runs, { scrollHeight: 2000, clientHeight: 400 });
      messageAt(runs, 1000);
      await rerender(<Turn size={10} turn="turn-2" />);
      expect(runs.scrollTop).toBe(1000 - TURN_GAP);
      measure(runs, { scrollHeight: 3000, clientHeight: 400 });
      await rerender(<Turn size={500} turn="turn-2" />);
      expect(runs.scrollTop).toBe(1000 - TURN_GAP);
      expect(page.querySelector(".state")?.textContent).toBe("following");
      expect(page.querySelector(".behind")?.textContent).toBe("behind");
      // The jump goes to the end, and follows from there.
      await click(page.querySelector("button"));
      expect(runs.scrollTop).toBe(3000);
      expect(page.querySelector(".behind")?.textContent).toBe("caught up");
      measure(runs, { scrollHeight: 3500, clientHeight: 400 });
      await rerender(<Turn size={900} turn="turn-2" />);
      expect(runs.scrollTop).toBe(3500);
    });

    it("keeps a short answer at the end, as a reader following it would", async () => {
      const page = await mount(<Turn size={10} />);
      const runs = page.querySelector<HTMLDivElement>(".runs");
      if (runs === null) return;
      measure(runs, { scrollHeight: 2000, clientHeight: 400 });
      messageAt(runs, 1800);
      await rerender(<Turn size={10} turn="turn-2" />);
      expect(runs.scrollTop).toBe(1800 - TURN_GAP);
      expect(page.querySelector(".behind")?.textContent).toBe("caught up");
    });

    it("takes a reader who had scrolled away to the message they just sent", async () => {
      const page = await mount(<Turn size={10} />);
      const runs = page.querySelector<HTMLDivElement>(".runs");
      if (runs === null) return;
      measure(runs, { scrollHeight: 2000, clientHeight: 400 });
      runs.scrollTop = 100;
      await act(async () => runs.dispatchEvent(new Event("scroll")));
      expect(page.querySelector(".state")?.textContent).toBe("missed 0");
      messageAt(runs, 1500);
      await rerender(<Turn size={10} turn="turn-2" />);
      expect(runs.scrollTop).toBe(1500 - TURN_GAP);
      expect(page.querySelector(".state")?.textContent).toBe("following");
    });

    it("lets go of the message once the reader scrolls: the view is theirs", async () => {
      const page = await mount(<Turn size={10} />);
      const runs = page.querySelector<HTMLDivElement>(".runs");
      if (runs === null) return;
      measure(runs, { scrollHeight: 2000, clientHeight: 400 });
      messageAt(runs, 1000);
      await rerender(<Turn size={10} turn="turn-2" />);
      runs.scrollTop = 1200;
      await act(async () => runs.dispatchEvent(new Event("scroll")));
      await rerender(<Turn size={400} turn="turn-2" />);
      expect(runs.scrollTop).toBe(1200);
      expect(page.querySelector(".behind")?.textContent).toBe("behind");
    });

    it("does not count a chat opened with a turn going as one sent", async () => {
      const page = await mount(<Turn size={10} of="chat-1" />);
      const runs = page.querySelector<HTMLDivElement>(".runs");
      if (runs === null) return;
      measure(runs, { scrollHeight: 2000, clientHeight: 400 });
      messageAt(runs, 1000);
      await rerender(<Turn size={10} of="chat-2" turn="turn-2" />);
      expect(runs.scrollTop).toBe(2000);
    });

    it("brings a new card into view, and not one that was there when the chat opened", async () => {
      const scrolled = vi.fn();
      const page = await mount(<Turn size={10} asks={["old"]} />);
      const card = page.querySelector<HTMLElement>(".card");
      if (card === null) return;
      card.scrollIntoView = scrolled;
      await rerender(<Turn size={10} asks={["old"]} />);
      expect(scrolled).not.toHaveBeenCalled();
      await rerender(<Turn size={10} asks={["old", "new"]} />);
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
      // One answered and gone is not a new card.
      await rerender(<Turn size={10} asks={["new"]} />);
      expect(scrolled).toHaveBeenCalledTimes(1);
      // Another chat's, as it opens, is that chat's to show.
      await rerender(<Turn size={10} of="other" asks={["theirs"]} />);
      expect(scrolled).toHaveBeenCalledTimes(1);
    });
  });

  it("gives a newly selected session its own scroll state, not the last one's", async () => {
    const page = await mount(<Harness count={40} of="task-1" />);
    const runs = page.querySelector<HTMLDivElement>(".runs");
    if (runs === null) return;
    measure(runs, { scrollHeight: 1000, clientHeight: 200 });
    runs.scrollTop = 0;
    await act(async () => runs.dispatchEvent(new Event("scroll")));
    await rerender(<Harness count={137} of="task-1" />);
    expect(page.querySelector(".state")?.textContent).toBe("missed 97");
    // Another session: at its newest, following, and counting nothing of the last.
    await rerender(<Harness count={3} of="task-2" />);
    expect(page.querySelector(".state")?.textContent).toBe("following");
    expect(runs.scrollTop).toBe(1000);
  });

  it("counts being within the threshold as following, and going back catches up", async () => {
    const page = await mount(<Harness count={1} />);
    const runs = page.querySelector<HTMLDivElement>(".runs");
    if (runs === null) return;
    measure(runs, { scrollHeight: 1000, clientHeight: 200 });
    // A little off the bottom, but inside the threshold: still following.
    runs.scrollTop = 1000 - 200 - (FOLLOW_THRESHOLD - 1);
    await act(async () => runs.dispatchEvent(new Event("scroll")));
    expect(page.querySelector(".state")?.textContent).toBe("following");
    // Just outside it: not.
    runs.scrollTop = 1000 - 200 - (FOLLOW_THRESHOLD + 1);
    await act(async () => runs.dispatchEvent(new Event("scroll")));
    expect(page.querySelector(".state")?.textContent).toBe("missed 0");
    // Jump: back to the bottom, following again.
    await act(async () => page.querySelector<HTMLButtonElement>("button")?.click());
    expect(page.querySelector(".state")?.textContent).toBe("following");
    expect(runs.scrollTop).toBe(1000);
  });
});

describe("an ask is always brought into view", () => {
  function Asked({ round }: { readonly round: string | undefined }) {
    const ref = useRef<HTMLElement>(null);
    useScrollIntoView(ref, round);
    return <section ref={ref}>{round ?? "nothing"}</section>;
  }

  it("scrolls to a round when it appears and when it changes, and not otherwise", async () => {
    const into = vi.fn();
    // jsdom lays nothing out and has no `scrollIntoView`: the test supplies it.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: into, configurable: true, writable: true });
    await mount(<Asked round={undefined} />);
    expect(into).not.toHaveBeenCalled();
    await rerender(<Asked round="ui-1:1" />);
    expect(into).toHaveBeenCalledTimes(1);
    // The same ask, re-rendered: not scrolled to again, so a delta cannot drag
    // the reader back to a card they scrolled away from.
    await rerender(<Asked round="ui-1:1" />);
    expect(into).toHaveBeenCalledTimes(1);
    // The next round is a new ask.
    await rerender(<Asked round="ui-1:2" />);
    expect(into).toHaveBeenCalledTimes(2);
    // Decided: nothing to scroll to.
    await rerender(<Asked round={undefined} />);
    expect(into).toHaveBeenCalledTimes(2);
    // It scrolls, and never focuses: focus on an approval is how one is given by accident.
    expect(document.activeElement).toBe(document.body);
  });

  it("does not fail where the environment has no scrollIntoView", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: undefined, configurable: true, writable: true });
    const page = await mount(<Asked round="ui-1:1" />);
    expect(page.textContent).toContain("ui-1:1");
  });
});

describe("an answer of a turn that read untrusted content", () => {
  const answer = [
    text("t1", "From [the page](https://docs.example/guide), [here](https://drop.example/?q=secret) and [mail](mailto:drop@drop.example)."),
  ];

  it("names the host of a novel link in its text, as a turn read back from history draws it", async () => {
    await markdownReady;
    const page = await mount(<Transcript entries={answer} tainted knownUrls={["https://docs.example/guide"]} />);
    expect([...page.querySelectorAll(".markdown-link-host")].map((note) => note.textContent)).toEqual([
      " (drop.example)",
      " (mailto:drop@drop.example)",
    ]);
  });

  it("draws every link as written when the turn is clean", async () => {
    await markdownReady;
    const page = await mount(<Transcript entries={answer} />);
    expect(page.querySelector(".markdown-link-host")).toBeNull();
  });
});
