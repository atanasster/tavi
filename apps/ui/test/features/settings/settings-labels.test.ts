import { describe, expect, it } from "vitest";

import { distinctParts } from "../../../src/features/settings/ChannelsSettings.js";
import { credentialLabel } from "../../../src/features/settings/CredentialsSettings.js";

describe("what a stored credential is for", () => {
  it("names a connection's API key, a channel's secret and a channel plugin's sign-in secret, and leaves a plain name as it is", () => {
    expect(credentialLabel("ollama.apiKey.881d8821-5be8-4d8d-8563-e5bdfccfeba3")).toBe("ollama API key");
    expect(credentialLabel("ollama-proxy.apiKey")).toBe("ollama-proxy API key");
    expect(credentialLabel("channels.655744806e58a3ffdbc11f1efc7bc72f.token")).toBe("Channel token");
    expect(credentialLabel("channels.plugin-client.acme-chat.secret")).toBe("acme-chat sign-in secret");
    expect(credentialLabel("openrouter")).toBeUndefined();
  });
});

describe("a channel connection's line under its name", () => {
  it("says each part once, and none that only repeats the name", () => {
    expect(distinctParts("Telegram", ["Telegram", "Telegram"])).toBe("");
    expect(distinctParts("Family", ["Telegram", "@tavi_bot", undefined, "telegram"])).toBe("Telegram · @tavi_bot");
    expect(distinctParts("Work", ["Slack", "", "polling paused"])).toBe("Slack · polling paused");
  });
});
