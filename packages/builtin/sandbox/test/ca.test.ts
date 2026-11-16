import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { proxyCa } from "../src/ca.js";
import { createSrtConfinement } from "../src/srt-cli.js";

const directories = temporaryDirectories();
afterAll(() => directories.cleanup());

const DAY = 86_400_000;

describe("the credential proxy's CA", () => {
  it("lasts 30 days, is kept until a week before it runs out, and is minted again if its folder went", () => {
    const directory = join(directories.create("tavi-ca-"), "sandbox-ca");
    const now = Date.now();
    const first = proxyCa(directory, now);
    expect(first.expires - now).toBeGreaterThan(29 * DAY);
    expect(proxyCa(directory, now + 20 * DAY)).toEqual(first);
    // Another process removed it: minted again rather than handed out missing.
    rmSync(join(first.certPath, ".."), { recursive: true, force: true });
    const again = proxyCa(directory, now + 20 * DAY);
    expect(again.certPath).not.toBe(first.certPath);
    expect(existsSync(again.certPath)).toBe(true);
  });

  it("removes only folders that have run out, never one a running child or another owner may hold", () => {
    const directory = join(directories.create("tavi-ca-"), "sandbox-ca");
    const now = Date.now();
    mkdirSync(join(directory, `${String(now - 40 * DAY)}-aaaa`), { recursive: true });
    mkdirSync(join(directory, `${String(now - 2 * DAY)}-bbbb`), { recursive: true });
    proxyCa(directory, now);
    const left = readdirSync(directory);
    expect(left).not.toContain(`${String(now - 40 * DAY)}-aaaa`);
    expect(left).toContain(`${String(now - 2 * DAY)}-bbbb`);
  });

  it("has a child holding credentials started again a day before the CA it loaded runs out, and one without none", () => {
    const root = directories.create("tavi-ca-");
    const caDirectory = join(root, "sandbox-ca");
    const confinement = createSrtConfinement({ platform: "darwin", caDirectory, bwrapPath: () => undefined });
    const launch = (credentials: boolean) => ({
      argv: ["/usr/bin/true"],
      env: { TOKEN: "secret" },
      policyFile: join(root, `${String(credentials)}.json`),
      policy: {
        denyRead: [],
        allowRead: [],
        allowWrite: [],
        domains: ["api.example.com"],
        nested: false,
        ...(credentials ? { credentials: [{ env: "TOKEN", hosts: ["api.example.com"] }] } : {}),
      },
    });
    const held = confinement.wrap(launch(true));
    expect(held.renewBy).toBe(proxyCa(caDirectory).expires - DAY);
    expect(confinement.wrap(launch(false)).renewBy).toBeUndefined();
  });
});
