import { describe, expect, it } from "vitest";
import { localityWrite, SettledMemo } from "../../src/features/models/locality-memo.js";

/** The memo `runtime/models.ts` keeps of a chat's locality, and the writes that drop it. */

describe("SettledMemo", () => {
  it("answers a read it has kept without loading again", async () => {
    const memo = new SettledMemo<string, number>();
    let loads = 0;
    const load = async () => ++loads;
    expect(await memo.read("a", load)).toBe(1);
    expect(await memo.read("a", load)).toBe(1);
    expect(loads).toBe(1);
    memo.delete("a");
    expect(await memo.read("a", load)).toBe(2);
    memo.clear();
    expect(await memo.read("a", load)).toBe(3);
  });

  it("never keeps a read that rejected: the caller's fail-closed answer is not remembered", async () => {
    const memo = new SettledMemo<string, boolean>();
    await expect(memo.read("chat", async () => Promise.reject(new Error("database is locked")))).rejects.toThrow("database is locked");
    expect(await memo.read("chat", async () => false)).toBe(false);
  });

  it("does not keep a read a write overtook, nor one `keep` refuses", async () => {
    const memo = new SettledMemo<string, string>();
    let release: () => void = () => {};
    const slow = memo.read("chat", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "before the write";
    });
    memo.delete("chat");
    release();
    expect(await slow).toBe("before the write");
    expect(await memo.read("chat", async () => "after the write")).toBe("after the write");
    const refused = new SettledMemo<string, string>();
    expect(
      await refused.read(
        "x",
        async () => "degraded",
        () => false,
      ),
    ).toBe("degraded");
    expect(await refused.read("x", async () => "settled")).toBe("settled");
  });
});

describe("SettledMemo.readMany", () => {
  it("loads only the keys it does not hold, in one load, and keeps what that load answered", async () => {
    const memo = new SettledMemo<string, number>();
    await memo.read("a", async () => 1);
    const asked: (readonly string[])[] = [];
    const load = async (missing: readonly string[]) => {
      asked.push(missing);
      return new Map(missing.map((key) => [key, key.length]));
    };
    expect(await memo.readMany(["a", "bb", "ccc", "bb"], load)).toEqual(
      new Map([
        ["a", 1],
        ["bb", 2],
        ["ccc", 3],
      ]),
    );
    expect(asked).toEqual([["bb", "ccc"]]);
    expect(await memo.read("ccc", async () => 0)).toBe(3);
    expect(await memo.readMany(["a", "bb"], load)).toEqual(
      new Map([
        ["a", 1],
        ["bb", 2],
      ]),
    );
    expect(asked).toHaveLength(1);
  });

  it("keeps nothing from a load that rejected or that a write overtook", async () => {
    const memo = new SettledMemo<string, string>();
    await expect(memo.readMany(["chat"], async () => Promise.reject(new Error("database is locked")))).rejects.toThrow(
      "database is locked",
    );
    expect(await memo.read("chat", async () => "read again")).toBe("read again");
    let release: () => void = () => {};
    const slow = memo.readMany(["other"], async (missing) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Map(missing.map((key) => [key, "before the write"]));
    });
    memo.delete("unrelated");
    release();
    expect(await slow).toEqual(new Map([["other", "before the write"]]));
    expect(await memo.read("other", async () => "after the write")).toBe("after the write");
  });
});

describe("localityWrite", () => {
  it("names the writes that may change a chat's locality, and no read", () => {
    expect(localityWrite("service.modelConfig.setWorkspaceDefault", [])).toEqual({ kind: "config" });
    expect(localityWrite("repository.modelConfig.upsertConnection", [])).toEqual({ kind: "config" });
    expect(localityWrite("service.modelConfig.resolveRole", [])).toBeUndefined();
    expect(localityWrite("repository.modelConfig.getConnection", [])).toBeUndefined();
    expect(localityWrite("service.router.chooseRoute", [])).toEqual({ kind: "routes" });
    expect(localityWrite("service.router.saveRoute", [])).toEqual({ kind: "routes" });
    expect(localityWrite("service.router.route", [])).toBeUndefined();
    expect(localityWrite("service.accounting.begin", [{ runId: "task-1" }])).toEqual({ kind: "attempts", runId: "task-1" });
    expect(localityWrite("service.accounting.beginPriced", [{ runId: "task-1" }])).toEqual({ kind: "attempts", runId: "task-1" });
    expect(localityWrite("service.accounting.deleteRun", ["task-1"])).toEqual({ kind: "attempts", runId: "task-1" });
    expect(localityWrite("service.accounting.usedConnections", ["task-1"])).toBeUndefined();
    expect(localityWrite("repository.tasks.get", ["task-1"])).toBeUndefined();
  });
});
