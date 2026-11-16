// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AppAccountViewSchema } from "@tavi/contracts";
import { AccountRow } from "../../../src/features/apps/AccountRow.js";

/** A channel account, as Connected apps lists it: set up in Settings → Channels, so shown read-only. */
const channel = AppAccountViewSchema.parse({
  accountId: "telegram-1",
  label: "Telegram",
  owner: { kind: "owner" },
  health: "ready",
  workspaces: ["default"],
  people: false,
  sharing: "personal",
  readOnly: true,
});
const row = (signsIn: boolean, health: "ready" | "not-set-up" | "needs-access" = "not-set-up") =>
  renderToStaticMarkup(
    <AccountRow
      account={{ ...channel, health }}
      appName="Telegram"
      busy={false}
      canDisconnect={false}
      onReconnect={() => {}}
      onDisconnect={() => {}}
      onSharing={() => {}}
      signsIn={signsIn}
    />,
  );

it("says an app that signs in has not yet, and says nothing of a sign-in for one set up with keys", () => {
  expect(row(true)).toContain("Not signed in yet.");
  expect(row(false)).not.toContain("Not signed in yet.");
});

it("never says a signed-in account that keeps no sign-in time (a Google account) has not signed in", () => {
  expect(row(true, "ready")).not.toContain("Not signed in yet.");
  expect(row(true, "needs-access")).not.toContain("Not signed in yet.");
});

it("offers an app set up with a key that is not set up to finish setting it up, not to sign in", () => {
  const keyed = renderToStaticMarkup(
    <AccountRow
      account={{ ...channel, readOnly: false, health: "not-set-up" }}
      appName="Google Maps"
      busy={false}
      canDisconnect={false}
      onReconnect={() => {}}
      onDisconnect={() => {}}
      onSharing={() => {}}
      signsIn={false}
    />,
  );
  expect(keyed).toContain(">Finish setting up<");
  expect(keyed).not.toContain(">Sign in<");
});
