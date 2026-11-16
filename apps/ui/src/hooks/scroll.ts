import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Scroll discipline.
 *
 * A transcript that always jumps to the bottom takes the page away from a
 * reader who scrolled up to read something; one that never does makes them
 * chase a stream. So the rule is threshold-based: while the reader is near the
 * bottom the view follows the stream, and the moment they scroll away it stops
 * and offers to catch up, counting what arrived meanwhile.
 *
 * Focus is never moved by any of this: scrolling is not focusing.
 */

/** How close to the bottom counts as "following the stream", in pixels. */
export const FOLLOW_THRESHOLD = 96;
/** The room left above a sent message brought to the top of the view, in pixels. */
export const TURN_GAP = 12;
/** What a reader must act on, in a transcript: a card a turn or a worker waits on, or a memory card. */
const ASK_SELECTOR = '[data-waiting], [data-notice-kind="memory"]';

export interface Autoscroll {
  /** Whether the view is following the stream, and so whether new entries scroll into view. */
  readonly following: boolean;
  /** How many entries arrived since the reader scrolled away; `0` while following. */
  readonly missed: number;
  /** Whether something the reader has not seen arrived below the fold: what offers `jump`. */
  readonly behind: boolean;
  /** Go to the newest entry and follow again. */
  readonly jump: () => void;
}

/** The moments that move the view whatever the reader was doing. */
interface AutoscrollMoments {
  /** The turn just sent (`data-run` on its message): its message and the start of its answer come into view. */
  readonly turn?: string | undefined;
  /** What waits on the reader, by id: each new one is brought into view (`ASK_SELECTOR`). */
  readonly asks?: readonly string[] | undefined;
}

/**
 * Keep `ref`'s scroll container at the bottom while the reader is there, and
 * count what they miss when they are not.
 *
 * `size` is how much there is to read, not how many entries there are: a
 * streamed answer folds into **one** transcript block (`reduceRun` appends
 * each `text.delta` to the block of the same id), so a count of entries does
 * not move while an answer is being written — and the view would sit at the
 * top of an answer streaming below the fold, which is the thing this exists to
 * prevent. `missed` is therefore only offered when whole entries arrived.
 *
 * `of` names what is being read: selecting another session resets the state,
 * rather than opening it scrolled away with the last one's count.
 *
 * A sent turn (`moments.turn`) takes the view whatever it was doing, and is
 * followed only until its message reaches the top of the view: a long answer
 * is read from its start, with `behind` saying there is more. The reader
 * scrolling, or `jump`, lets go of the message.
 */
export function useAutoscroll(
  ref: RefObject<HTMLElement | null>,
  size: number,
  entries: number,
  of?: string,
  { turn, asks = [] }: AutoscrollMoments = {},
): Autoscroll {
  const [following, setFollowing] = useState(true);
  const [missed, setMissed] = useState(0);
  const [behind, setBehind] = useState(false);
  /** What there was when the reader last saw the bottom. */
  const seen = useRef({ entries, size });
  /** What the listener reads without being rebound on every delta. */
  const latest = useRef({ entries, size, of });
  /** The sent turn whose message the view stops at. */
  const held = useRef<string | undefined>(undefined);
  /** Where this hook last moved the view: the scroll event that comes of it is not the reader's. */
  const moved = useRef<number | undefined>(undefined);

  const atBottom = useCallback(
    (element: HTMLElement): boolean => element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD,
    [],
  );

  /** The end of what there is to read, or the message of the turn held, should that come first. */
  const place = useCallback((element: HTMLElement): void => {
    const message = [...element.querySelectorAll<HTMLElement>("[data-run]")].find((each) => each.dataset["run"] === held.current);
    const top =
      message === undefined
        ? element.scrollHeight
        : Math.max(0, element.scrollTop + message.getBoundingClientRect().top - element.getBoundingClientRect().top - TURN_GAP);
    const before = element.scrollTop;
    element.scrollTop = top;
    if (element.scrollTop !== before) moved.current = element.scrollTop;
  }, []);

  // Another session: its own scroll state, not the last one's.
  useLayoutEffect(() => {
    seen.current = { entries, size };
    latest.current = { entries, size, of };
    setFollowing(true);
    setMissed(0);
    setBehind(false);
    // A new chat's first turn is keyed by its operation until the task is named: the same chat, the same turn.
    if (held.current !== turn) held.current = undefined;
    const element = ref.current;
    if (element !== null) place(element);
    // Deliberately keyed on `of` alone: this is a reset, not a per-entry effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [of]);

  // A turn was sent: the reader asked for this, wherever they were. A chat opened with a turn going is opened, not sent to.
  const lastTurn = useRef({ turn, of });
  useLayoutEffect(() => {
    const before = lastTurn.current;
    lastTurn.current = { turn, of };
    if (turn === undefined || turn === before.turn || (before.of !== undefined && before.of !== of)) return;
    held.current = turn;
    setFollowing(true);
    if (ref.current !== null) place(ref.current);
  }, [ref, place, turn, of]);

  // Whether the reader is following is theirs to decide, by scrolling. Bound
  // once: what the handler needs is read from a ref, not from its closure.
  useEffect(() => {
    latest.current = { entries, size, of };
  });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const onScroll = (): void => {
      // This hook's own move says nothing of the reader: the view may have grown since, and be far from the end by now.
      const own = moved.current === element.scrollTop;
      moved.current = undefined;
      if (own) return;
      held.current = undefined;
      const bottom = atBottom(element);
      setFollowing(bottom);
      if (bottom) {
        seen.current = { entries: latest.current.entries, size: latest.current.size };
        setMissed(0);
        setBehind(false);
      }
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [ref, atBottom]);

  // The scroller itself resized (the composer grew with attachments or a long draft, the window shrank): a reader
  // following the end keeps it, rather than its last lines slipping under the composer. Read from a ref, so the
  // observer is bound once.
  const followingNow = useRef(following);
  followingNow.current = following;
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      if (followingNow.current) place(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, place]);

  // What grew the transcript beyond `size`: a sent message, a card's body read after it was posted, a chip under an answer.
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new MutationObserver(() => {
      if (followingNow.current) place(element);
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [ref, place]);

  // Something arrived: followed to, or counted. A layout effect, so the view
  // never paints one frame at the old position before catching up.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (following) {
      place(element);
      if (atBottom(element)) {
        seen.current = { entries, size };
        setMissed(0);
        setBehind(false);
        return;
      }
    }
    setMissed(Math.max(0, entries - seen.current.entries));
    setBehind(size > seen.current.size);
  }, [ref, place, atBottom, size, entries, following]);

  // A new card waits on the reader: an ask they cannot see is an ask they cannot answer. Keyed by its words, so
  // a new array of the same asks is nothing new; what a chat holds as it opens is not new either.
  const known = useRef({ asks: new Set(asks), of });
  const asked = asks.join("\0");
  useEffect(() => {
    const now = asked === "" ? [] : asked.split("\0");
    const before = known.current;
    const fresh = before.of === of && now.some((id) => !before.asks.has(id));
    known.current = { asks: new Set(before.of === of ? [...before.asks, ...now] : now), of };
    if (!fresh) return;
    held.current = undefined;
    const cards = ref.current?.querySelectorAll<HTMLElement>(ASK_SELECTOR);
    // Not every environment has it (jsdom does not), as in `useScrollIntoView`.
    cards?.[cards.length - 1]?.scrollIntoView?.({ block: "nearest" });
  }, [ref, asked, of]);

  const jump = useCallback(() => {
    const element = ref.current;
    if (element === null) return;
    held.current = undefined;
    place(element);
    seen.current = { entries: latest.current.entries, size: latest.current.size };
    setFollowing(true);
    setMissed(0);
    setBehind(false);
  }, [ref, place]);

  return { following, missed, behind, jump };
}

/**
 * Bring the element `ref` points at into view when `key` changes to something
 * defined — the approval cards, which are always scrolled into view
 * whether or not the reader is following the stream. An ask the reader cannot
 * see is an ask they cannot answer.
 *
 * It scrolls, and does not focus: focus on an approval is exactly how an
 * accidental approval happens.
 */
export function useScrollIntoView(ref: RefObject<HTMLElement | null>, key: string | undefined): void {
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (key === undefined || key === last.current) {
      last.current = key;
      return;
    }
    last.current = key;
    // Not every environment has it (jsdom does not): a page that cannot scroll
    // still shows the ask, it just does not move to it.
    const element = ref.current;
    if (typeof element?.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
  }, [ref, key]);
}
