import { expect } from "vitest";

import { writeKeyFile, writeWalkFile } from "../support/maintain.js";
import { walkGuide } from "../support/walk.js";

/** The settings file of step 3, as the guide prints it. */
const SETTINGS = {
  settings: {
    enabled: true,
    modes: { tools: "shadow" },
    egress: { taskText: true, toolDescriptions: true, skillMetadata: false, memoryExcerpts: false },
    providerSettings: { "tavi.router": { credentialRef: "jev.key" } },
  },
};

interface Status {
  readonly configuration: { readonly revision: number; readonly settings: { readonly enabled: boolean } };
  readonly provider: { readonly id: string; readonly state: string };
  readonly credentialPresence: string;
  readonly effectiveModes: Readonly<Record<string, string>>;
}

const status = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Status>("router", "status");
const OFF = { model: "off", memory: "off", tools: "off", skills: "off" };

walkGuide("run-and-maintain/model-routing", {
  // No model and no chat: nothing in the walk could ask the provider, whose endpoint is a real service.
  configured: false,
  steps: {
    "see-where-routing-stands": async (walk) => {
      const screen = await walk.terminal({ title: "tavi router status --format text", args: ["router", "status", "--format", "text"] });
      expect(screen.join("\n")).toMatch(/revision: 0/);
      expect(status(walk)).toMatchObject({ configuration: { revision: 0, settings: { enabled: false } }, effectiveModes: OFF });
    },
    "store-its-key": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi credentials set jev.key --file jev.key",
        args: ["credentials", "set", "jev.key", "--file", writeKeyFile("jev.key", "jev-test-0001-not-a-real-key")],
      });
      expect(screen.join("\n")).toContain("stored credential jev.key");
    },
    "turn-it-on-in-shadow": async (walk) => {
      const file = writeWalkFile("router.json", JSON.stringify(SETTINGS, null, 2));
      const screen = await walk.terminal({
        title: "tavi router configure --file router.json --revision 0",
        args: ["router", "configure", "--file", file, "--revision", "0"],
        lines: 36,
      });
      expect(screen.join("\n")).toMatch(/"revision": 1/);
      expect(screen.join("\n")).toMatch(/"tools": "shadow"/);
    },
    "check-what-it-will-do": async (walk) => {
      walk.unwalked("a chat routed in shadow: the Jev provider's endpoint is a real third-party service, and the walk's key is made up");
      const screen = await walk.terminal({ title: "tavi router status --format text", args: ["router", "status", "--format", "text"] });
      expect(screen.join("\n")).toMatch(/credentialPresence: present/);
      expect(status(walk)).toMatchObject({
        configuration: { revision: 1, settings: { enabled: true } },
        provider: { id: "tavi.router", state: "running" },
        credentialPresence: "present",
        effectiveModes: { ...OFF, tools: "shadow" },
      });
    },
    "turn-it-off-again": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi router set-mode tools off --revision 1",
        args: ["router", "set-mode", "tools", "off", "--revision", "1"],
        lines: 14,
      });
      expect(screen.join("\n")).toMatch(/"revision": 2/);
      expect(status(walk)).toMatchObject({ configuration: { revision: 2 }, effectiveModes: OFF });
    },
  },
});
