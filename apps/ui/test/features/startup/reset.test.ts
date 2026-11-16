import type { ClientState } from "@tavi/client/browser";
import { describe, expect, it, vi } from "vitest";

import { reloadAfterReset } from "../../../src/features/startup/reset.js";
import { SESSION_SECRET_KEY } from "../../../src/features/startup/start.js";

/** A client whose state the test moves, as an owner restart would. */
function client(initial: ClientState) {
  let state = initial;
  const listeners = new Set<(state: ClientState) => void>();
  return {
    get state() {
      return state;
    },
    onState(listener: (next: ClientState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    move(next: ClientState) {
      state = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

function storage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    clear: () => map.clear(),
  };
}

describe("the page after a reset", () => {
  it("waits for the owner to go and come back, then forgets the old instance and reloads, keeping the session", () => {
    const owner = client("ready");
    const local = storage({ "tavi.sidebar": "320" });
    const session = storage({ [SESSION_SECRET_KEY]: "secret", "tavi.panel": "x" });
    const reload = vi.fn();
    reloadAfterReset(owner, { local, session, reload });

    owner.move("ready");
    expect(reload).not.toHaveBeenCalled();
    owner.move("reconnecting");
    expect(reload).not.toHaveBeenCalled();
    owner.move("ready");
    expect(reload).toHaveBeenCalledTimes(1);
    expect([...local.map]).toEqual([]);
    expect([...session.map]).toEqual([[SESSION_SECRET_KEY, "secret"]]);
    owner.move("reconnecting");
    owner.move("ready");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads on the timer alone for a client that reports no states", () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      reloadAfterReset({}, { reload });
      vi.advanceTimersByTime(59_999);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads anyway when the owner does not come back in time", () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      reloadAfterReset(client("ready"), { reload });
      vi.advanceTimersByTime(60_000);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
