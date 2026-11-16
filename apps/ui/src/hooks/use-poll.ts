/** The canvas's beats: a time that moves on a clock (`useNow`) and a callback run every so often while enabled (`usePoll`). */
import { useEffect, useRef, useState, type DependencyList } from "react";

/** How often a clock that says minutes moves: a countdown, a live duration. */
export const MINUTE_TICK_MS = 60_000;

/** The fewest milliseconds between two reads of a list that follows live work. */
export const LIVE_POLL_MS = 5_000;

/**
 * The time, moved every `ms` while `enabled`: a deadline's countdown, a live
 * duration. Turned on again after a pause, it is read at once rather than at
 * the next beat. `clock` is a test's fake time.
 */
export function useNow(ms: number, enabled = true, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock);
  const read = useRef(clock);
  read.current = clock;
  const started = useRef(false);
  useEffect(() => {
    const resume = started.current;
    started.current = true;
    if (!enabled) return;
    if (resume) setNow(read.current());
    const timer = setInterval(() => setNow(read.current()), ms);
    return () => clearInterval(timer);
  }, [enabled, ms]);
  return now;
}

/**
 * `tick`, called every `ms` while `enabled` (no `ms`: never on a beat), at
 * once as it starts with `immediate`, and on each visibility change of the
 * page with `visibility`. The latest `tick` is the one called; a change of
 * `deps` starts it over. `alive` says whether the run that called it still
 * stands, so an answer that arrives after it stopped is dropped.
 */
export function usePoll(
  tick: (alive: () => boolean) => void,
  ms: number | undefined,
  {
    enabled = true,
    immediate = false,
    visibility = false,
  }: { readonly enabled?: boolean; readonly immediate?: boolean; readonly visibility?: boolean } = {},
  deps: DependencyList = [],
): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    const alive = (): boolean => current;
    const beat = (): void => latest.current(alive);
    if (immediate) beat();
    const timer = ms === undefined || ms <= 0 ? undefined : setInterval(beat, ms);
    if (visibility) document.addEventListener("visibilitychange", beat);
    return () => {
      current = false;
      clearInterval(timer);
      if (visibility) document.removeEventListener("visibilitychange", beat);
    };
    // `tick` is read through `latest`; `deps` are what start it over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ms, immediate, visibility, ...deps]);
}
