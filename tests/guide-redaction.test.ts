import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { removeTemporaryDirectories, temporaryDirectory } from "@tavi/test-support";

afterAll(removeTemporaryDirectories);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The walks' account helpers, on a made-up accounts folder. */
async function withAccounts(accounts: Record<string, string>): Promise<typeof import("./guides/support/user.js")> {
  const folder = temporaryDirectory("tavi-guide-accounts-");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "accounts.json"), JSON.stringify(accounts));
  vi.stubEnv("TAVI_GUIDE_ACCOUNTS", folder);
  return import("./guides/support/user.js");
}

describe("what the guide pictures hide", () => {
  it("swaps every account value for its placeholder, and says so without printing the value", async () => {
    const { personalLeft, personalSwaps } = await withAccounts({
      googleEmail: "Jo.Doe@gmail.com",
      telegramBotUsername: "@jo_walks_bot",
      telegramYourName: "Jo Doe",
      discordGuildId: "987654321098765432",
      oauthPort: "48760",
    });
    const swaps = new Map(personalSwaps());
    expect(swaps.get("Jo.Doe@gmail.com")).toBe("you@gmail.com");
    expect(swaps.get("jo.doe@gmail.com")).toBe("you@gmail.com");
    expect(swaps.get("Jo.Doe+tavi@gmail.com")).toBe("you+tavi@gmail.com");
    expect(swaps.get("jo_walks_bot")).toBe("yourbot");
    expect(swaps.get("Jo")).toBe("Sam");
    expect(swaps.get("987654321098765432")).toHaveLength(18);
    expect(swaps.has("48760")).toBe(false);
    expect(personalLeft("sent to jo.doe@gmail.com")).toEqual(["you@gmail.com"]);
    expect(personalLeft("nothing of theirs")).toEqual([]);
  });

  it("swaps the longer value first, so a tagged address is not half swapped", async () => {
    const { personalSwaps } = await withAccounts({ googleEmail: "jo@gmail.com" });
    const order = personalSwaps().map(([value]) => value);
    expect(order.indexOf("jo+tavi@gmail.com")).toBeLessThan(order.indexOf("jo@gmail.com"));
  });

  it("keeps a one-word name's case, so it never eats an ordinary word", async () => {
    const { personalSwaps } = await withAccounts({ telegramYourName: "Mark" });
    expect(new Map(personalSwaps()).has("mark")).toBe(false);
  });

  it("drops a value its own placeholder holds, which could never leave the page", async () => {
    const { personalLeft } = await withAccounts({ discordBotName: "Tavi" });
    expect(personalLeft("Tavi answered")).toEqual([]);
  });

  it("gives an id found during a walk a made-up one of its length", async () => {
    const { hidePersonal, personalSwaps } = await withAccounts({});
    hidePersonal("555666777");
    expect(new Map(personalSwaps()).get("555666777")).toMatch(/^1\d{8}$/);
  });

  it("refuses a new account key with no placeholder", async () => {
    const { account } = await withAccounts({ somethingNew: "x" });
    expect(() => account("somethingNew")).toThrow(/no placeholder/);
  });
});

describe("what the guide pictures show for a private path", () => {
  it("keeps a quoted home path one a shell expands", async () => {
    const { redact } = await import("./guides/support/walk.js");
    const swaps = [["/Users/jo/tavi-demo", "~/tavi-demo"]] as const;
    expect(redact("mkdir -p '/Users/jo/tavi-demo/desktop'", swaps)).toBe("mkdir -p ~/'tavi-demo/desktop'");
    expect(redact("cd '/Users/jo/tavi-demo'", swaps)).toBe("cd ~/'tavi-demo'");
    expect(redact("data: /Users/jo/tavi-demo/x", swaps)).toBe("data: ~/tavi-demo/x");
  });
});
