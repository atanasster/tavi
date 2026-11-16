import type { ChannelDescriptor } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { setupLinksOf } from "../../../src/features/welcome/channel-setup.js";

const base: ChannelDescriptor = {
  providerId: "chat",
  label: "Chat",
  kind: "chat",
  description: "A chat app.",
  settings: [],
  auth: { kind: "secrets", fields: [{ key: "token", label: "Bot token" }] },
  sender: { label: "User", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
  target: { label: "Chat", placeholder: "", pattern: ".+", normalize: "none" },
  hosts: ["api.chat.example", "*.cdn.example"],
  setupLinks: [
    { label: "API", url: "https://api.chat.example/new" },
    { label: "CDN", url: "https://files.cdn.example/" },
    { label: "Pairing host", url: "https://chat.example/maker" },
    { label: "Elsewhere", url: "https://elsewhere.example/" },
  ],
  pairing: { deepLinkTemplate: "https://chat.example/{account}?start={code}", openLabel: "Open in Chat" },
};

describe("setupLinksOf", () => {
  it("keeps a link on a declared host, a wildcard's or the pairing link's, and drops one elsewhere", () => {
    expect(setupLinksOf(base).map((link) => link.label)).toEqual(["API", "CDN", "Pairing host"]);
  });

  it("leaves the pairing host out when its template does not parse, without throwing", () => {
    const odd: ChannelDescriptor = { ...base, pairing: { deepLinkTemplate: "https://chat.example:{account}/{code}", openLabel: "Open" } };
    expect(setupLinksOf(odd).map((link) => link.label)).toEqual(["API", "CDN"]);
  });
});
