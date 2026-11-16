import { readFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { checklistState, connectModel } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Checklist {
  readonly steps: readonly { readonly kind: string; readonly state: string; readonly detail: string }[];
}

/** Where the walk writes its units: a temporary folder, never ~/Library/LaunchAgents or ~/.config/systemd. */
const directories = temporaryDirectories();
const units = directories.create("tavi-docs-units-");
afterAll(() => directories.cleanup());

const serviceStep = (checklist: Checklist) => checklist.steps.find((step) => step.kind === "service");

walkGuide("get-started/keep-tavi-running", {
  configured: false,
  model: true,
  steps: {
    "start-tavi-in-a-terminal": async (walk) => {
      // Before you start: a model, connected as its own guide does. The walk's owner (tavi serve) already runs.
      connectModel(walk.tavi);
      const screen = await walk.terminal({ title: "tavi onboard status", args: ["onboard", "status"] });
      expect(screen.join("\n")).toMatch(/○ Keep Tavi running/);
      expect(checklistState(walk.tavi, "service")).toBe("todo");
    },
    "let-setup-start-it-with-your-computer": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi setup service",
        args: ["setup", "service"],
        tty: true,
        input: [{ wait: 6 }],
        cols: 120,
      });
      const text = screen.join("\n");
      expect(text).toContain("Start Tavi with my computer");
      expect(text).toContain("I run it myself");
      walk.unwalked(
        "choosing Start Tavi with my computer: it writes ~/Library/LaunchAgents/dev.tavi.serve.plist on this machine and loads it with launchctl",
      );
    },
    "or-write-the-unit-yourself": async (walk) => {
      const screen = await walk.terminal({ title: "tavi service unit", args: ["service", "unit"], lines: 16, cols: 110 });
      expect(screen.join("\n")).toContain("launchctl bootstrap");
      // Saved with --out, as the step does, but to a temporary folder.
      const plist = join(units, "dev.tavi.serve.plist");
      walk.tavi("service", "unit", "--log-dir", join(units, "logs"), "--out", plist);
      const unit = readFileSync(plist, "utf8");
      expect(unit).toContain("<string>dev.tavi.serve</string>");
      expect(unit).toContain(walk.dataDir);
      // On Linux: the user-scope systemd unit.
      const service = join(units, "dev.tavi.serve.service");
      walk.tavi("service", "unit", "--kind", "systemd", "--scope", "user", "--out", service);
      expect(readFileSync(service, "utf8")).toMatch(/^ExecStart=.*"serve"/m);
      walk.unwalked("launchctl bootstrap (or systemctl --user enable): loading a unit would start a service on this machine");
    },
    "or-say-you-run-it-yourself": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi setup service",
        args: ["setup", "service"],
        tty: true,
        input: [{ wait: 6 }, { text: "2" }, { text: "\r", wait: 1 }, { wait: 4 }],
        cols: 120,
      });
      expect(screen.join("\n")).toContain("You run it yourself");
      const step = serviceStep(walk.taviJson<Checklist>("onboard", "status"));
      expect(step?.state).toBe("done");
      expect(step?.detail).toBe("You run it yourself");
    },
  },
});
