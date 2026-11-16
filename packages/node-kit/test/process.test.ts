import { EventEmitter, getEventListeners } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openerFor, openersFor, openerShowsUrl, openUrl, prefixedId, securityHeaders, sleep, type OpenerSpawn } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("sleep", () => {
  it("resolves after the time", async () => {
    vi.useFakeTimers();
    let done = false;
    const waiting = sleep(1_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });

  it("removes its abort listener once the time has passed", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = sleep(1_000, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("rejects with the signal's reason on abort, and clears its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal);
    const reason = new Error("stopped");
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("before"));
    await expect(sleep(60_000, controller.signal)).rejects.toThrow("before");
  });

  it("resolves early on abort when asked to", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = sleep(60_000, controller.signal, { onAbort: "resolve" });
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await expect(sleep(60_000, controller.signal, { onAbort: "resolve" })).resolves.toBeUndefined();
  });
});

describe("prefixedId", () => {
  it("is the prefix, a dash and a fresh UUID", () => {
    const id = prefixedId("art");
    expect(id).toMatch(/^art-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(prefixedId("art")).not.toBe(id);
  });
});

describe("openUrl", () => {
  /** `exitCode`: what an opener reading stdin exits with once it has read it; `"never"` keeps it running. */
  const fakeSpawn = (outcome: "spawn" | "error" | "throw", exitCode: number | "never" = 0) => {
    const calls: { command: string; args: readonly string[]; detached: boolean | undefined; stdio: unknown }[] = [];
    const stdin: string[] = [];
    let unrefs = 0;
    const spawn: OpenerSpawn = (command, args, options) => {
      calls.push({ command, args, detached: options.detached, stdio: options.stdio });
      if (outcome === "throw") throw new Error("spawn failed");
      const child = Object.assign(new EventEmitter(), {
        unref: () => {
          unrefs += 1;
        },
        stdin: Object.assign(new EventEmitter(), {
          end: (chunk: string) => {
            stdin.push(chunk);
            if (exitCode !== "never") setImmediate(() => child.emit("exit", exitCode));
          },
        }),
      });
      setImmediate(() => (outcome === "spawn" ? child.emit("spawn") : child.emit("error", new Error("ENOENT"))));
      return child;
    };
    return { spawn, calls, stdin, unrefs: () => unrefs };
  };

  it("runs the platform's opener detached, the URL as its one argument off macOS", async () => {
    for (const [platform, command, args] of [
      ["linux", "xdg-open", ["https://example.test/a?b=c&d"]],
      ["win32", "rundll32", ["url.dll,FileProtocolHandler", "https://example.test/a?b=c&d"]],
    ] as const) {
      const fake = fakeSpawn("spawn");
      expect(await openUrl("https://example.test/a?b=c&d", { platform, spawn: fake.spawn })).toBe(true);
      expect(fake.calls).toEqual([{ command, args, detached: true, stdio: ["ignore", "ignore", "ignore"] }]);
      expect(fake.stdin).toEqual([]);
      expect(fake.unrefs()).toBe(1);
      expect(openerShowsUrl(platform)).toBe(true);
    }
    expect(openerFor("http://127.0.0.1:4000/", "freebsd")).toEqual({ command: "xdg-open", args: ["http://127.0.0.1:4000/"] });
  });

  it("on Windows hands the URL to ShellExecuteW, and falls back to rundll32 only when that cannot be called", async () => {
    const url = "https://example.test/a?b=c&d";
    const handed: string[] = [];
    const unused = fakeSpawn("spawn");
    const shellOpen = (target: string): boolean => {
      handed.push(target);
      return true;
    };
    expect(await openUrl(url, { platform: "win32", spawn: unused.spawn, shellOpen })).toBe(true);
    expect(handed).toEqual([url]);
    expect(unused.calls).toEqual([]);
    // Windows refused it: no second try through another opener.
    expect(await openUrl(url, { platform: "win32", spawn: unused.spawn, shellOpen: () => false })).toBe(false);
    expect(unused.calls).toEqual([]);
    const fallback = fakeSpawn("spawn");
    const unavailable = (): boolean => {
      throw new Error("koffi did not load");
    };
    expect(await openUrl(url, { platform: "win32", spawn: fallback.spawn, shellOpen: unavailable })).toBe(true);
    expect(fallback.calls.map((call) => call.command)).toEqual(["rundll32"]);
  });

  it("on macOS hands the URL to osascript on stdin, never on its command line", async () => {
    const fake = fakeSpawn("spawn");
    const url = "http://127.0.0.1:4000/#a-one-time-token";
    expect(await openUrl(url, { platform: "darwin", spawn: fake.spawn })).toBe(true);
    expect(fake.calls).toEqual([{ command: "osascript", args: [], detached: true, stdio: ["pipe", "ignore", "ignore"] }]);
    expect(JSON.stringify(fake.calls)).not.toContain("a-one-time-token");
    expect(fake.stdin).toEqual([`open location "${url}"\n`]);
    expect(openerShowsUrl("darwin")).toBe(false);
    // A quote or backslash left in the parsed URL cannot end the AppleScript string.
    expect(openerFor('https://a.test/?x=\\"y', "darwin").stdin).toBe('open location "https://a.test/?x=\\\\\\"y"\n');
    // Nothing outside printable ASCII is put into the script.
    for (const bad of ["https://a.test/\nx", "https://a.test/ x", "https://a.test/\u2028", "https://a.test/\u0000"])
      expect(() => openerFor(bad, "darwin"), JSON.stringify(bad)).toThrow(TypeError);
  });

  it("on macOS answers false when osascript fails or does not finish, so the caller prints the URL", async () => {
    expect(await openUrl("https://example.test/", { platform: "darwin", spawn: fakeSpawn("spawn", 1).spawn })).toBe(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hung = fakeSpawn("spawn", "never");
    const opened = openUrl("https://example.test/", { platform: "darwin", spawn: hung.spawn });
    while (hung.stdin.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await opened).toBe(false);
    expect(hung.unrefs()).toBe(1);
  });

  it("answers false when the opener is missing or cannot be spawned", async () => {
    expect(await openUrl("https://example.test", { platform: "linux", env: {}, spawn: fakeSpawn("error").spawn })).toBe(false);
    expect(await openUrl("https://example.test", { platform: "linux", env: {}, spawn: fakeSpawn("throw").spawn })).toBe(false);
  });

  it("on WSL falls back to wslview, then Windows' URL handler, while an opener is missing", async () => {
    const wsl = { WSL_DISTRO_NAME: "Ubuntu" };
    const url = "https://example.test/";
    expect(openersFor(url, "linux", wsl).map((opener) => opener.command)).toEqual(["xdg-open", "wslview", "rundll32.exe"]);
    expect(openersFor(url, "linux", { WSL_INTEROP: "/run/WSL/1_interop" })).toHaveLength(3);
    expect(openersFor(url, "linux", {})).toEqual([{ command: "xdg-open", args: [url] }]);
    expect(openersFor(url, "darwin", wsl)).toHaveLength(1);

    const missing = fakeSpawn("error");
    expect(await openUrl(url, { platform: "linux", env: wsl, spawn: missing.spawn })).toBe(false);
    expect(missing.calls.map((call) => call.command)).toEqual(["xdg-open", "wslview", "rundll32.exe"]);
    expect(missing.calls[2]?.args).toEqual(["url.dll,FileProtocolHandler", url]);

    // xdg-open missing, wslview found: Windows' handler is never tried.
    const spawnCalls: string[] = [];
    const missingThenFound: OpenerSpawn = (command, args, options) => {
      spawnCalls.push(command);
      return (command === "xdg-open" ? fakeSpawn("error") : fakeSpawn("spawn")).spawn(command, args, options);
    };
    expect(await openUrl(url, { platform: "linux", env: wsl, spawn: missingThenFound })).toBe(true);
    expect(spawnCalls).toEqual(["xdg-open", "wslview"]);

    const found = fakeSpawn("spawn");
    expect(await openUrl(url, { platform: "linux", env: wsl, spawn: found.spawn })).toBe(true);
    expect(found.calls.map((call) => call.command)).toEqual(["xdg-open"]);
  });

  it("hands the opener the parsed URL, whitespace and quotes encoded", async () => {
    const fake = fakeSpawn("spawn");
    expect(await openUrl('https://a.test/x\ty "q"', { platform: "linux", spawn: fake.spawn })).toBe(true);
    expect(fake.calls[0]?.args).toEqual([new URL('https://a.test/x\ty "q"').href]);
    expect(fake.calls[0]?.args[0]).toBe("https://a.test/xy%20%22q%22");
  });

  it("opens only http and https URLs", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url", "-a Calculator"]) {
      const fake = fakeSpawn("spawn");
      expect(await openUrl(url, { platform: "darwin", spawn: fake.spawn }), url).toBe(false);
      expect(await openUrl(url, { platform: "linux", spawn: fake.spawn }), url).toBe(false);
      expect(fake.calls).toEqual([]);
    }
  });
});

describe("securityHeaders", () => {
  it("carries the policy and the fixed set, and the same-origin pair when asked", () => {
    const base = {
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
    };
    expect(securityHeaders("default-src 'none'")).toEqual(base);
    expect(securityHeaders("default-src 'none'", { sameOrigin: true })).toEqual({
      ...base,
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
    });
  });
});
