// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { AppAccountViewSchema } from "@tavi/contracts";

import { AccountRow } from "../../../src/features/apps/AccountRow.js";
import { signInByWords } from "../../../src/features/apps/model.js";
import { localDayWithYear } from "../../../src/lib/time.js";
import { TimeZoneContext } from "../../../src/features/shell/Workspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 23:30 UTC on Monday is already Tuesday in Auckland and still Monday in Los Angeles.
const AT = "2026-10-19T23:30:00.000Z";

function rowText(timeZone: string): string {
  const account = AppAccountViewSchema.parse({
    accountId: "a",
    label: "Work",
    owner: { kind: "owner" },
    health: "ready",
    signedInAt: AT,
    nextSignInBy: AT,
    workspaces: [],
    people: false,
    sharing: "personal",
  });
  const host = document.createElement("ul");
  const root = createRoot(host);
  act(() => {
    root.render(
      <TimeZoneContext.Provider value={timeZone}>
        <AccountRow
          account={account}
          appName="Mail"
          busy={false}
          canDisconnect
          onReconnect={() => {}}
          onDisconnect={() => {}}
          onSharing={() => {}}
        />
      </TimeZoneContext.Provider>,
    );
  });
  const text = host.textContent ?? "";
  act(() => root.unmount());
  return text;
}

describe("apps dates", () => {
  it("say a sign-in deadline's day in the workspace's zone, not the browser's", () => {
    expect(signInByWords(AT, "Pacific/Auckland")).toBe("Sign in again by Tue 20 Oct");
    expect(signInByWords(AT, "America/Los_Angeles")).toBe("Sign in again by Mon 19 Oct");
  });

  it("show an account's dates in the zone the page provides", () => {
    expect(rowText("Pacific/Auckland")).toContain("Signed in Tue 20 Oct");
    expect(rowText("America/Los_Angeles")).toContain("Signed in Mon 19 Oct");
  });

  it("add the year to a day from another year", () => {
    expect(localDayWithYear(AT, "UTC", Date.parse("2026-12-01T00:00:00Z"))).toBe("Mon 19 Oct");
    expect(localDayWithYear(AT, "UTC", Date.parse("2027-01-05T00:00:00Z"))).toBe("Mon 19 Oct 2026");
  });
});
