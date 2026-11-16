import { describe, expect, it } from "vitest";

import type { ConnectableApp } from "@tavi/contracts";

import { gmailChannel } from "@tavi/plugin-gmail/channel";

import { keptBy, keptByAccount, projectOf } from "../../src/features/apps/shared-grants.js";

// What Gmail's channel declares of Google's client ids.
const GOOGLE = gmailChannel.descriptor.auth.kind === "oauth2" ? gmailChannel.descriptor.auth.oauth.clientProjectPattern : undefined;

/** Coordinated revocation. */

describe("which apps a Google revoke would end too", () => {
  it("reads a client id's project by the provider's declared pattern, and an id of another shape as unknown", () => {
    expect(projectOf("123456789012-abc123def.apps.googleusercontent.com", GOOGLE)).toBe("123456789012");
    expect(projectOf("own-client", GOOGLE)).toBeUndefined();
    expect(projectOf(undefined, GOOGLE)).toBeUndefined();
    // A provider that declares no pattern names no project: every id is the same one.
    expect(projectOf("123456789012-abc123def.apps.googleusercontent.com", undefined)).toBeUndefined();
  });

  it("keeps the grant for another app of the same project and account, and for one it cannot tell apart", () => {
    const calendar = {
      appName: "Google Calendar",
      accountId: "mcp.gcal",
      identity: "me@gmail.com",
      clientId: "111-a.apps.googleusercontent.com",
    };
    const gmail = { appName: "Gmail", accountId: "gmail-1", identity: "Me@Gmail.com", clientId: "111-b.apps.googleusercontent.com" };
    expect(keptBy(calendar, [calendar, gmail], GOOGLE)).toEqual(["Gmail"]);
    // Another project, or another account: revoked upstream.
    expect(keptBy(calendar, [calendar, { ...gmail, clientId: "222-b.apps.googleusercontent.com" }], GOOGLE)).toEqual([]);
    expect(keptBy(calendar, [calendar, { ...gmail, identity: "work@acme.com" }], GOOGLE)).toEqual([]);
    // Unknown is the safe side: taken as the same project or account.
    expect(keptBy(calendar, [calendar, { appName: "Gmail", accountId: "gmail-1", clientId: "legacy-id" }], GOOGLE)).toEqual(["Gmail"]);
  });

  it("hands Settings → Channels each account's keeping apps, by account id, and none for an account no other app shares", () => {
    const app = (name: string, accounts: readonly { readonly accountId: string; readonly keptBy?: readonly string[] }[]) =>
      ({ name, accounts }) as unknown as ConnectableApp;
    const kept = keptByAccount([
      app("Gmail", [{ accountId: "gmail-1", keptBy: ["Google Calendar"] }, { accountId: "gmail-2" }]),
      app("Google Calendar", [
        { accountId: "mcp.gcal", keptBy: ["Gmail"] },
        { accountId: "mcp.gcal-2", keptBy: [] },
      ]),
    ]);
    expect([...kept]).toEqual([
      ["gmail-1", ["Google Calendar"]],
      ["mcp.gcal", ["Gmail"]],
    ]);
  });
});
