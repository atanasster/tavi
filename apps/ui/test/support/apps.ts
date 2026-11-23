import type { ConnectableApp } from "@tavi/contracts";

/** The calendar app the Connected apps tests show, in the parts every one of them shares. */

/** Its one account: the owner's, signed in and ready, used in the default workspace only. */
export const calendarAccount: ConnectableApp["accounts"][number] = {
  accountId: "mcp.cal",
  label: "you@example.com",
  identity: "you@example.com",
  owner: { kind: "owner" },
  health: "ready",
  grantedScopes: [],
  missingScopes: [],
  signedInAt: "2026-10-16T09:00:00.000Z",
  expiresWeekly: false,
  workspaces: ["default"],
  people: false,
  sharing: "personal",
  readOnly: false,
};

/** Where it reaches and what it keeps: its one host, a sign-in, no settings, and output read as untrusted. */
export const calendarReach: Pick<ConnectableApp, "egress" | "credentials" | "settings" | "trust"> = {
  egress: { hosts: ["calendar.example.com"], lan: false, anyNetwork: false },
  credentials: [{ name: "sign-in", raw: false }],
  settings: [],
  trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
};
