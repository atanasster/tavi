import { useCallback, useEffect, useMemo, useRef, useState, type DependencyList } from "react";

import type { Outcome } from "../lib/ipc.js";

/**
 * A view's data, read from the owner on mount, again on `reload`, and again
 * whenever one of `deps` changes. A failed read keeps the last good `data`
 * beside its `error`, and an answer that arrives after the view is gone (or
 * after a newer read began) is dropped. `replace` puts a value the view
 * already holds — a write's answer — in place of the last read.
 *
 * Off (`enabled: false`), nothing is read, and the data held stays; turned on
 * again, it is read at once. `serial` keeps a slow read rather than dropping
 * it: a read asked for while one is out waits for that one's answer and then
 * runs once, however many were asked meanwhile — so a poll that beats faster
 * than the owner answers still shows each answer.
 */
export function useLoaded<T>(
  load: () => Promise<Outcome<T>>,
  deps: DependencyList = [],
  { enabled = true, serial = false }: { readonly enabled?: boolean; readonly serial?: boolean } = {},
): {
  readonly data: T | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly reload: () => void;
  readonly replace: (value: T) => void;
} {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(enabled);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const latest = useRef(load);
  latest.current = load;
  const mounted = useRef(true);
  const reading = useRef(false);
  const again = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    const settle = (outcome: Outcome<T>): void => {
      setLoading(false);
      if (outcome.ok) {
        setData(outcome.value);
        setError(undefined);
      } else {
        setError(outcome.message);
      }
    };
    if (serial) {
      const read = (): void => {
        if (reading.current) {
          again.current = true;
          return;
        }
        reading.current = true;
        setLoading(true);
        void latest.current().then((outcome) => {
          reading.current = false;
          if (!mounted.current) return;
          settle(outcome);
          if (!again.current) return;
          again.current = false;
          read();
        });
      };
      read();
      return undefined;
    }
    setLoading(true);
    void latest.current().then((outcome) => {
      if (current) settle(outcome);
    });
    return () => {
      current = false;
    };
    // `load` is read through `latest`; `generation`, `deps` and `enabled` are what ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, enabled, ...deps]);
  return { data, error, loading, reload, replace: setData };
}

/**
 * A disclosure's list, read from the owner only when first opened: `toggle`
 * opens or closes it (reading it on the first open), `load` reads it again
 * (a retry). When `key` changes (a live refresh moved its count) the held
 * answer is dropped, and read again at once if the list is open; a closed one
 * is read when next opened. An answer that arrives after the list is gone, or
 * after a newer read began, is dropped.
 */
export function useLazyLoad<T>(
  read: () => Promise<Outcome<T>>,
  key: unknown,
): {
  readonly open: boolean;
  readonly loaded: T | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly load: () => void;
  readonly toggle: () => void;
} {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /** The read whose answer counts; an older one's answer is dropped. */
  const generation = useRef(0);
  const load = (): void => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    void read().then((outcome) => {
      if (!alive.current || current !== generation.current) return;
      setLoading(false);
      if (outcome.ok) setLoaded(outcome.value);
      else setError(outcome.message);
    });
  };
  // Only a changed key reads again, so `open` and `load` are read through
  // refs as they are at that moment rather than re-running the effect.
  const latest = useRef({ open, load });
  latest.current = { open, load };
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    // An answer still in flight was read for the old key: drop it.
    generation.current += 1;
    setLoading(false);
    setLoaded(undefined);
    if (latest.current.open) latest.current.load();
  }, [key]);
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && loaded === undefined && !loading) load();
  };
  return { open, loaded, error, loading, load, toggle };
}

/**
 * One read in flight at a time: `begin` says whether a read may start now —
 * one asked for while another is out is remembered instead — and `end`, called
 * as the read in flight finishes, runs `next` once when one was asked for meanwhile.
 */
export function useSerialRead(): { readonly begin: () => boolean; readonly end: (next: () => void) => void } {
  const reading = useRef(false);
  const again = useRef(false);
  return useMemo(
    () => ({
      begin: () => {
        if (reading.current) {
          again.current = true;
          return false;
        }
        reading.current = true;
        return true;
      },
      end: (next: () => void) => {
        reading.current = false;
        if (!again.current) return;
        again.current = false;
        next();
      },
    }),
    [],
  );
}
