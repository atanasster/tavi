import { describe, expect, it } from "vitest";

import { sandboxConfines } from "@tavi/contracts";

import { createOwnerSandboxHost } from "../../src/features/sandbox/host.js";

/** The owner's host detection: one port, built in `features/sandbox/host.ts`. */

describe("the owner's sandbox host", () => {
  it("answers checking until its first probe, then the tier", async () => {
    const host = createOwnerSandboxHost(
      { dataDirectory: "/data" },
      {
        facts: () => ({ platform: "darwin", inContainer: false, appArmorRestrictsUserNamespaces: false, userNamespacesDisabled: false }),
        probe: async () => ({ works: true, checks: [{ name: "live probe", ok: true }] }),
      },
    );
    expect(sandboxConfines(host.current())).toBe(false);
    expect(await host.check()).toEqual({ tier: "full", mechanism: "seatbelt", checks: [{ name: "live probe", ok: true }] });
    expect(sandboxConfines(host.current())).toBe(true);
  });
});
