import { expect } from "vitest";

import { MODEL } from "../../../scripts/docs/session.mjs";
import { keyFile, walkGuide } from "../support/walk.js";

interface Checklist {
  readonly steps: readonly { readonly kind: string; readonly state: string; readonly detail: string }[];
}

interface Connection {
  readonly connectionId: string;
  readonly kind: string;
  readonly baseUrl: string;
  readonly credentialRef: string;
}

const modelStep = (checklist: Checklist) => checklist.steps.find((step) => step.kind === "model");

walkGuide("get-started/first-model", {
  configured: false,
  model: true,
  steps: {
    "start-setup": async (walk) => {
      const screen = await walk.terminal({ title: "tavi onboard", args: ["onboard"], tty: true, input: [{ wait: 6 }] });
      const text = screen.join("\n");
      for (const provider of ["OpenRouter (recommended)", "Ollama", "Anthropic", "OpenAI", "Another provider"])
        expect(text).toContain(provider);
    },
    "choose-openrouter": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi onboard",
        args: ["onboard"],
        tty: true,
        input: [{ wait: 6 }, { text: "\r" }, { wait: 4 }],
      });
      expect(screen.join("\n")).toContain("Sign in with OpenRouter");
      // The key the walk uses is real: it is never typed into a prompt, and no browser sign-in is made for it.
      walk.unwalked("signing in with OpenRouter or pasting the key: the walk connects with tavi setup --key-file instead (step 4)");
    },
    "or-choose-anthropic": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi onboard",
        args: ["onboard"],
        tty: true,
        input: [{ wait: 6 }, { text: "3" }, { text: "\r", wait: 1 }, { wait: 4 }],
        cols: 110,
      });
      expect(screen.join("\n")).toMatch(/Anthropic key \(hidden\)/);
      walk.unwalked("typing an Anthropic key: no key is ever typed into a prompt by a walk");
    },
    "or-connect-from-a-key-file": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi setup --non-interactive --preset openrouter",
        args: [
          "setup",
          "--non-interactive",
          "--preset",
          "openrouter",
          "--key-file",
          keyFile,
          "--model",
          MODEL.main,
          "--fast-model",
          MODEL.fast,
        ],
      });
      expect(screen.join("\n")).toContain("Inference ready");
      expect(screen.join("\n")).toContain("Fast model ready");
    },
    "check-that-it-is-set-up": async (walk) => {
      const screen = await walk.terminal({ title: "tavi onboard status", args: ["onboard", "status"] });
      expect(screen.join("\n")).toMatch(/✓ Choose the model/);
      const model = modelStep(walk.taviJson<Checklist>("onboard", "status"));
      expect(model?.state).toBe("done");
      expect(model?.detail).toContain("verified");
    },
    "see-the-connection": async (walk) => {
      const screen = await walk.terminal({ title: "tavi models list", args: ["models", "list"] });
      expect(screen.join("\n")).toContain("openai-compatible");
      const connections = JSON.parse(walk.tavi("models", "list")) as Connection[];
      expect(connections.map((connection) => [connection.connectionId, connection.kind])).toEqual([["openrouter", "openai-compatible"]]);
    },
  },
});
