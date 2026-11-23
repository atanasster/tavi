// @vitest-environment jsdom
import {
  defaultHeartbeatConfig,
  effectiveMemorySettings,
  HEARTBEAT_PRODUCTION_OPTIONS,
  type OnboardingFlowAnswer,
  type OnboardingStatus,
} from "@tavi/contracts";
import axe from "axe-core";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { parseRoute, routePath } from "../../../src/features/shell/route.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { Welcome } from "../../../src/features/welcome/Welcome.js";
import { addSearchProvider, redirectedThisSession, WELCOME_REDIRECT_KEY } from "../../../src/features/welcome/onboarding-api.js";
import { pick, selected } from "../../pick.js";
import { flush, settledBy, unmountAll } from "../../support/dom.js";
import { WELCOME_FLOW } from "../../support/onboarding.js";

/**
 * Setup's Welcome: the stepper and its
 * focus, the model step from a typed key to a verified default (set only on
 * a pass), a failed verify's advice and its retry, the about step's writes
 * with and without memory (paused, not offered, refused, or a held preference
 * corrected), Do this later and Don't show again, the redirect kept to once a
 * session, the routes, and no violation axe can find; the whole walk by
 * keyboard alone, a refused key typed again for the same connection, which
 * steps `all` shows, why a flow plugin was not used, and "New with <app>" only
 * for an app connected during setup.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What was asked answered: microtasks only, as tests here fake the clock. */
const { settle, mount, click } = settledBy(() => flush(6));
async function type(input: Element | null, value: string): Promise<void> {
  if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) throw new Error("no field");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await settle();
}
const button = (container: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text)) as HTMLButtonElement | undefined;

/** Welcome with its address kept, as the shell keeps it: `onStep` moves it, and `seen` records each. */
function Routed(props: {
  readonly client: SettingsClient;
  readonly seen: (stepId: string | undefined, replace: boolean) => void;
  readonly origin?: string;
  readonly openUrl?: (url: string) => void;
}) {
  const [stepId, setStepId] = useState<string>();
  return (
    <Welcome
      client={props.client}
      workspaceId="default"
      stepId={stepId}
      {...(props.origin === undefined ? {} : { origin: props.origin })}
      {...(props.openUrl === undefined ? {} : { openUrl: props.openUrl })}
      onStep={(next, options) => {
        props.seen(next, options?.replace === true);
        setStepId(next);
      }}
      onLeave={() => {}}
      onSettings={() => {}}
    />
  );
}

const FLOW = WELCOME_FLOW;

function status(model: "todo" | "done"): OnboardingStatus {
  return {
    workspaceId: "default",
    providerId: "tavi.onboarding",
    steps: [
      { kind: "model", state: model, detail: model === "done" ? "OpenAI · gpt-5 · verified" : "No model is set up" },
      { kind: "about", state: "todo", detail: "" },
    ],
    complete: model === "done",
    firstRun: model === "todo",
    open: model === "done" ? ["about"] : ["model", "about"],
  };
}

/** A scripted owner: answers by `command:action`, recording each request. */
function owner(answers: Record<string, unknown | ((payload: Record<string, unknown>) => unknown)>) {
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: (async (command: string, payload: Record<string, unknown>) => {
      sent.push({ command, payload });
      const answer = answers[`${command}:${String(payload["action"])}`];
      const value = typeof answer === "function" ? (answer as (payload: Record<string, unknown>) => unknown)(payload) : answer;
      if (value instanceof Error) return { ok: false, error: { code: "INVALID_INPUT", message: value.message } };
      return { ok: true, result: value ?? {} };
    }) as SettingsClient["request"],
  };
  return { client, sent, actions: () => sent.map((entry) => `${entry.command}:${String(entry.payload["action"])}`) };
}

const base = (model: "todo" | "done" = "todo") => ({
  "onboarding:flow": FLOW,
  "onboarding:status": status(model),
  "onboarding:detect": { env: [], local: [], existing: [] },
});

describe("Welcome", () => {
  it("with no flow installed, walks no step and says to run tavi onboard", async () => {
    const { client } = owner({ ...base(), "onboarding:status": { ...status("todo"), providerId: null } });
    const onLeave = vi.fn();
    const page = await mount(<Welcome client={client} workspaceId="default" onStep={() => {}} onLeave={onLeave} onSettings={() => {}} />);
    expect(page.querySelector("h1")?.textContent).toBe("Guided setup is turned off");
    expect(page.textContent).toContain("tavi onboard");
    expect(page.querySelector("ol[aria-label='Setup steps']")).toBeNull();
    await click(button(page, "Go to Home"));
    expect(onLeave).toHaveBeenCalled();
  });

  it("shows the stepper as an ordered list, the model first and current, with focus on its heading", async () => {
    const { client } = owner(base());
    const page = await mount(<Welcome client={client} workspaceId="default" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />);
    const stepper = page.querySelector("ol[aria-label='Setup steps']");
    expect([...(stepper?.querySelectorAll("li") ?? [])].map((item) => item.textContent?.trim())).toEqual([
      "1 Choose the model Tavi thinks with",
      "2 About you",
    ]);
    expect(stepper?.querySelector("[aria-current='step']")?.textContent).toContain("Choose the model");
    expect(document.activeElement?.textContent).toBe("Choose the model Tavi thinks with");
    // While the model is open, nothing else can be reached, and it cannot be skipped.
    expect(button(page, "About you")?.disabled).toBe(true);
    expect(button(page, "Skip")).toBeUndefined();
    expect(page.textContent).toContain("Recommended");
    // Nothing to go back to, skip or continue with: no empty footer under the step.
    expect(page.querySelector(".welcome-nav")).toBeNull();
    expect(page.querySelector(".welcome-progress")?.textContent).toBe("0 of 2 done");
    expect(page.querySelector(".welcome-panel .eyebrow")?.textContent).toBe("Step 1 of 2");
    const results = await axe.run(page, { rules: { region: { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("counts the steps done in the rail and marks an optional step on its card", async () => {
    const { client } = owner(base("done"));
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="about" all onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    expect(page.querySelector(".welcome-progress")?.textContent).toBe("1 of 2 done");
    expect(page.querySelector(".welcome-panel .eyebrow")?.textContent).toBe("Step 2 of 2 · optional");
    expect(page.querySelector(".welcome-nav")).not.toBeNull();
  });

  it("tells the owner each step it shows, once a step", async () => {
    const { client, sent } = owner({ ...base("done"), "onboarding:reached": { recorded: true } });
    await mount(
      <Welcome client={client} workspaceId="default" stepId="about" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    expect(sent.filter((entry) => entry.payload["action"] === "reached").map((entry) => entry.payload["step"])).toEqual(["about"]);
  });

  it("connects a typed key, verifies the chosen model, and makes it the default only once it passes", async () => {
    let verified = 0;
    const { client, sent, actions } = owner({
      ...base(),
      "onboarding:connect-key": {
        connectionId: "openai",
        models: ["gpt-5", "gpt-5-mini"],
        suggested: { main: "gpt-5", fast: "gpt-5-mini" },
      },
      "onboarding:verify": (payload: Record<string, unknown>) => {
        verified += 1;
        const target = payload["target"] as { model: string };
        // The first verify fails: the key was refused; the retry passes.
        return verified === 1
          ? {
              results: [
                {
                  role: "main",
                  connectionId: "openai",
                  model: target.model,
                  ok: false,
                  errorCode: "auth",
                  advice: "The key was refused. Check it, or create a new one at https://platform.openai.com.",
                },
              ],
              status: status("todo"),
            }
          : {
              results: [{ role: payload["role"], connectionId: "openai", model: target.model, ok: true, toolsOk: true }],
              status: status("done"),
            };
      },
      // Done once the main model passed: the step must stay on screen with its results.
      "onboarding:status": () => status(verified >= 2 ? "done" : "todo"),
      "models:set-default": {},
      "models:set-role": {},
    });
    const onDone = vi.fn();
    const page = await mount(<Routed client={client} seen={onDone} />);
    expect(onDone).toHaveBeenCalledWith("model", true);
    await click(button(page, "OpenAI"));
    // Where the key is kept is said once, on the step; the field's hint adds only what is new, in plain words.
    const hint = page.querySelector("input[type='password']")?.closest("p")?.querySelector(".hint")?.textContent ?? "";
    expect(hint).toMatch(/never shown again/i);
    expect(hint).not.toContain("credentials file");
    expect(hint).not.toContain("0600");
    await type(page.querySelector("input[type='password']"), "sk-test-welcome");
    await click(button(page, "Connect"));
    expect(sent.find((entry) => entry.payload["action"] === "connect-key")?.payload).toMatchObject({
      preset: "openai",
      key: "sk-test-welcome",
    });
    await click(button(page, "Verify"));
    expect(page.textContent).toContain("Failed: gpt-5: The key was refused.");
    expect(actions()).not.toContain("models:set-default");
    await click(button(page, "Retry"));
    expect(page.textContent).toContain("Inference ready: gpt-5");
    expect(page.textContent).toContain("Fast model ready: gpt-5-mini");
    expect(sent.find((entry) => entry.payload["action"] === "set-default")?.payload).toMatchObject({
      connectionId: "openai",
      model: "gpt-5",
    });
    expect(sent.find((entry) => entry.payload["action"] === "set-role")?.payload).toMatchObject({ role: "fast", model: "gpt-5-mini" });
    // The key went once, in connect-key, and is on the page nowhere.
    expect(page.innerHTML).not.toContain("sk-test-welcome");
    expect(page.querySelector("h1")?.textContent).toBe("Choose the model Tavi thinks with");
    await click(button(page, "Continue"));
    expect(onDone).toHaveBeenLastCalledWith("about", false);
  });

  it("offers the owner's found key and a running Ollama as one-click choices, and says a service sees no shell keys", async () => {
    const { client, sent } = owner({
      ...base(),
      "onboarding:detect": { env: ["OPENROUTER_API_KEY"], local: [{ preset: "ollama", models: 3, toolCapableModels: 2 }], existing: [] },
      "onboarding:connect-detected": { connectionId: "openrouter", models: ["m"] },
    });
    const page = await mount(<Welcome client={client} workspaceId="default" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />);
    expect(page.textContent).toContain("Ollama is running with 3 models");
    // A provider picked by hand has the step to itself; Back offers the shortcuts again.
    await click(page.querySelector(".provider-tile"));
    expect(page.querySelector(".welcome-detected")).toBeNull();
    await click(button(page, "Back"));
    expect(page.textContent).toContain("Ollama is running with 3 models");
    await click(button(page, "Use the OPENROUTER_API_KEY found in the owner's environment"));
    expect(sent.find((entry) => entry.payload["action"] === "connect-detected")?.payload).toMatchObject({
      preset: "openrouter",
      variable: "OPENROUTER_API_KEY",
    });
    const service = owner({ ...base(), "onboarding:detect": { env: [], local: [], existing: [], service: true } });
    const servicePage = await mount(
      <Welcome client={service.client} workspaceId="default" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    expect(servicePage.textContent).toContain("Keys in your shell aren't visible to the service");
  });

  it("signs in with OpenRouter in a new tab, back to this page's origin", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const opened: string[] = [];
      const { client, sent } = owner({
        ...base(),
        "onboarding:sign-in": { url: "https://openrouter.ai/auth?callback_url=x", state: "s".repeat(32) },
        "onboarding:sign-in-status": () =>
          (polls += 1) < 2
            ? { state: "waiting" }
            : {
                state: "done",
                connectionId: "openrouter",
                connection: {
                  connectionId: "openrouter",
                  models: ["anthropic/claude-sonnet-4.5"],
                  suggested: { main: "anthropic/claude-sonnet-4.5" },
                },
              },
      });
      const page = await mount(
        <Welcome
          client={client}
          workspaceId="default"
          origin="http://127.0.0.1:4173"
          openUrl={(url) => void opened.push(url)}
          onStep={() => {}}
          onLeave={() => {}}
          onSettings={() => {}}
        />,
      );
      await click(button(page, "OpenRouter"));
      await click(button(page, "Sign in with OpenRouter"));
      expect(sent.find((entry) => entry.payload["action"] === "sign-in")?.payload).toMatchObject({
        callbackOrigin: "http://127.0.0.1:4173",
      });
      expect(opened).toEqual(["https://openrouter.ai/auth?callback_url=x"]);
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        await settle();
      }
      expect(selected(page.querySelector(".welcome-roles .select-trigger"))).toBe("anthropic/claude-sonnet-4.5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no ChatGPT sign-in when the owner does not (its preview is off)", async () => {
    const { client } = owner(base());
    const page = await mount(<Welcome client={client} workspaceId="default" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />);
    expect(page.textContent).toContain("OpenRouter");
    expect(page.textContent).not.toContain("ChatGPT");
  });

  it("signs in with ChatGPT through the owner's own loopback, labelled a preview, then picks its models", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const opened: string[] = [];
      const { client, sent } = owner({
        ...base(),
        // The owner offers it: TAVI_PREVIEW_CHATGPT=1.
        "onboarding:status": { ...status("todo"), chatGptSignIn: true },
        "onboarding:sign-in": { url: "https://auth.openai.com/api/accounts/authorize?state=x", state: "c".repeat(32) },
        "onboarding:sign-in-status": () =>
          (polls += 1) < 2
            ? { state: "waiting" }
            : {
                state: "done",
                connectionId: "chatgpt",
                connection: { connectionId: "chatgpt", models: ["gpt-6.1-sol"], suggested: { main: "gpt-6.1-sol" } },
              },
      });
      const page = await mount(
        <Welcome
          client={client}
          workspaceId="default"
          openUrl={(url) => void opened.push(url)}
          onStep={() => {}}
          onLeave={() => {}}
          onSettings={() => {}}
        />,
      );
      expect(page.textContent).toContain("uses your ChatGPT plan's allowance");
      await click(button(page, "ChatGPTPreview"));
      await click(button(page, "Continue with ChatGPT"));
      expect(sent.find((entry) => entry.payload["action"] === "sign-in")?.payload).toEqual({
        action: "sign-in",
        workspaceId: "default",
        preset: "chatgpt",
      });
      expect(opened).toEqual(["https://auth.openai.com/api/accounts/authorize?state=x"]);
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        await settle();
      }
      expect(selected(page.querySelector(".welcome-roles .select-trigger"))).toBe("gpt-6.1-sol");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves for Home on Do this later, and dismisses only on Don't show again", async () => {
    const later = owner({ ...base(), "onboarding:dismiss": status("todo") });
    const onLeave = vi.fn();
    const page = await mount(
      <Welcome client={later.client} workspaceId="default" onStep={() => {}} onLeave={onLeave} onSettings={() => {}} />,
    );
    await click(button(page, "Do this later"));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(later.actions()).not.toContain("onboarding:dismiss");
    await click(button(page, "Don't show again"));
    expect(later.actions()).toContain("onboarding:dismiss");
    expect(onLeave).toHaveBeenCalledTimes(2);
  });

  it("saves the name and zone in settings and memory, or in settings alone when unticked", async () => {
    for (const remember of [true, false]) {
      const { client, sent, actions } = owner({
        ...base("done"),
        "workspace-settings:get": {
          workspaceId: "default",
          revision: 1,
          settings: {},
          effective: { timezone: "UTC", activitySummaries: true, homeChat: true },
          hostTimezone: "UTC",
        },
        "heartbeat:get": new Error("off"),
        "memory:list": { records: [], otherPeople: [] },
        "onboarding:complete-step": status("done"),
      });
      const onStep = vi.fn();
      const page = await mount(
        <Welcome
          client={client}
          workspaceId="default"
          stepId="about"
          browserTimeZone="Europe/Lisbon"
          onStep={onStep}
          onLeave={() => {}}
          onSettings={() => {}}
        />,
      );
      await type(page.querySelector("input[autocomplete='name']"), "Robin");
      expect(page.textContent).toContain("Tavi will remember: your name is Robin · you're in Europe/Lisbon");
      if (!remember) await click(page.querySelector("input[type='checkbox']"));
      await click(button(page, "Save"));
      expect(sent.filter((entry) => entry.payload["action"] === "set").map((entry) => entry.payload["key"])).toEqual([
        "operatorName",
        "timezone",
      ]);
      expect(actions().includes("memory:remember")).toBe(remember);
      expect(actions()).toContain("onboarding:complete-step");
      expect(onStep).toHaveBeenCalledWith("done");
      unmountAll();
    }
  });
});

describe("Welcome when the owner refuses", () => {
  it("does not offer Continue when the passing model could not be made the default", async () => {
    const { client } = owner({
      ...base(),
      "onboarding:connect-key": { connectionId: "openai", models: ["gpt-5"], suggested: { main: "gpt-5" } },
      "onboarding:verify": {
        results: [{ role: "main", connectionId: "openai", model: "gpt-5", ok: true, toolsOk: true }],
        status: status("done"),
      },
      "models:set-default": new Error("the config is read-only"),
    });
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="model" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    await click(button(page, "OpenAI"));
    await type(page.querySelector("input[type='password']"), "sk-x");
    await click(button(page, "Connect"));
    await click(button(page, "Verify"));
    expect(page.querySelector("[role='alert']")?.textContent).toContain(
      "gpt-5 answered, but it was not made the default: the config is read-only",
    );
    expect(page.textContent).not.toContain("Inference ready");
    expect(button(page, "Continue")).toBeUndefined();
  });

  it("stays, saying why, when Skip or Don't show again is refused", async () => {
    const { client } = owner({ ...base("done"), "onboarding:skip": new Error("busy"), "onboarding:dismiss": new Error("busy") });
    const onStep = vi.fn();
    const onLeave = vi.fn();
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="about" onStep={onStep} onLeave={onLeave} onSettings={() => {}} />,
    );
    await click(button(page, "Skip"));
    expect(page.querySelector("[role='alert']")?.textContent).toContain("The step was not skipped: busy");
    expect(onStep).not.toHaveBeenCalledWith("done");
    await click(button(page, "Don't show again"));
    expect(page.querySelector("[role='alert']")?.textContent).toContain("Setup was not turned off: busy");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("shows OpenRouter's address as a link while waiting, in case the tab was blocked, and stops waiting once left", async () => {
    vi.useFakeTimers();
    try {
      const { client, actions } = owner({
        ...base(),
        "onboarding:sign-in": { url: "https://openrouter.ai/auth?callback_url=x", state: "s".repeat(32) },
        "onboarding:sign-in-status": { state: "waiting" },
      });
      const page = await mount(
        <Welcome
          client={client}
          workspaceId="default"
          origin="http://127.0.0.1:4173"
          openUrl={() => {}}
          onStep={() => {}}
          onLeave={() => {}}
          onSettings={() => {}}
        />,
      );
      await click(button(page, "OpenRouter"));
      await click(button(page, "Sign in with OpenRouter"));
      expect(page.querySelector("a[href='https://openrouter.ai/auth?callback_url=x']")?.textContent).toBe("open OpenRouter");
      unmountAll();
      const before = actions().filter((action) => action === "onboarding:sign-in-status").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      // Leaving aborts the wait itself: no poll runs after it.
      expect(actions().filter((action) => action === "onboarding:sign-in-status").length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for ChatGPT's sign-in once left", async () => {
    vi.useFakeTimers();
    try {
      const { client, actions } = owner({
        ...base(),
        "onboarding:status": { ...status("todo"), chatGptSignIn: true },
        "onboarding:sign-in": { url: "https://auth.openai.com/api/accounts/authorize?state=x", state: "c".repeat(32) },
        "onboarding:sign-in-status": { state: "waiting" },
      });
      const page = await mount(
        <Welcome client={client} workspaceId="default" openUrl={() => {}} onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
      );
      await click(button(page, "ChatGPTPreview"));
      await click(button(page, "Continue with ChatGPT"));
      unmountAll();
      const before = actions().filter((action) => action === "onboarding:sign-in-status").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(actions().filter((action) => action === "onboarding:sign-in-status").length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses active hours it cannot read rather than dropping them", async () => {
    const flow = {
      ...FLOW,
      flow: {
        ...FLOW.flow,
        steps: [FLOW.flow.steps[0], { ...FLOW.flow.steps[1], about: { fields: ["name", "timezone", "activeHours"] } }],
      },
    } as OnboardingFlowAnswer;
    const heartbeat = {
      workspaceId: "default",
      principalId: "operator",
      config: { ...defaultHeartbeatConfig(), enabled: true },
      revision: 1,
      options: HEARTBEAT_PRODUCTION_OPTIONS,
      timezone: "UTC",
      hostRunning: true,
      providers: ["tavi.heartbeatagent"],
    };
    const { client, actions } = owner({
      ...base("done"),
      "onboarding:flow": flow,
      "workspace-settings:get": { workspaceId: "default", revision: 1, settings: {}, effective: { timezone: "UTC" }, hostTimezone: "UTC" },
      "heartbeat:get": heartbeat,
    });
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="about" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    const hours = [...page.querySelectorAll("input")].find((input) => input.placeholder === "08:00-22:00") ?? null;
    expect(hours?.value).toBe("08:00-22:00");
    await type(hours, "8 to 10");
    expect(page.textContent).toContain("Use HH:MM-HH:MM");
    expect(hours?.getAttribute("aria-invalid")).toBe("true");
    expect(button(page, "Save")?.disabled).toBe(true);
    expect(actions()).not.toContain("onboarding:complete-step");
  });
});

describe("adding a search provider", () => {
  it("adds before storing the key, retries on the one it added, and leaves another's provider and key alone", async () => {
    let listed: { providerId: string }[] = [];
    const { client, actions } = owner({
      "search:list": () => ({ providers: listed }),
      "credentials:list": { credentials: [] },
      "search:add": () => {
        listed = [{ providerId: "brave" }];
        return {};
      },
      "search:test": new Error("401 from Brave"),
    });
    const made = { added: false };
    expect(await addSearchProvider(client, "brave", "wrong", undefined, made)).toMatchObject({ ok: false });
    expect(actions()).toEqual(["search:list", "credentials:list", "search:add", "credentials:set", "search:enable", "search:test"]);
    expect(made.added).toBe(true);
    await addSearchProvider(client, "brave", "right", undefined, made);
    expect(actions().slice(6)).toEqual(["search:list", "credentials:set", "search:enable", "search:test"]);

    const theirs = owner({ "search:list": { providers: [{ providerId: "brave" }] } });
    expect(await addSearchProvider(theirs.client, "brave", "k", undefined, { added: false })).toMatchObject({
      ok: false,
      message: expect.stringContaining("set up already"),
    });
    expect(theirs.actions()).toEqual(["search:list"]);
    const keyed = owner({ "search:list": { providers: [] }, "credentials:list": { credentials: ["search.brave"] } });
    expect(await addSearchProvider(keyed.client, "brave", "k", undefined, { added: false })).toMatchObject({
      ok: false,
      message: expect.stringContaining("already in use"),
    });
    expect(keyed.actions()).not.toContain("credentials:set");
  });

  it("adds a Tavily added keyless again, with its key, once a key is typed on a retry", async () => {
    let listed: { providerId: string }[] = [];
    const { client, sent, actions } = owner({
      "search:list": () => ({ providers: listed }),
      "credentials:list": { credentials: [] },
      "search:add": () => {
        listed = [{ providerId: "tavily" }];
        return {};
      },
      "search:remove": () => {
        listed = [];
        return {};
      },
      "search:test": new Error("429 from Tavily"),
    });
    const made = { added: false };
    await addSearchProvider(client, "tavily", undefined, undefined, made);
    expect(actions()).toEqual(["search:list", "search:add", "search:enable", "search:test"]);
    await addSearchProvider(client, "tavily", "tvly-key", undefined, made);
    expect(actions().slice(4)).toEqual([
      "search:list",
      "search:remove",
      "credentials:list",
      "search:add",
      "credentials:set",
      "search:enable",
      "search:test",
    ]);
    expect(sent.filter((entry) => entry.payload["action"] === "add").at(-1)?.payload).toMatchObject({ credentialRef: "search.tavily" });
    // The same key again keeps the provider; dropping it adds one keyless, and keying it again does not take its own key for another's.
    await addSearchProvider(client, "tavily", "tvly-key", undefined, made);
    expect(actions().slice(11)).toEqual(["search:list", "credentials:set", "search:enable", "search:test"]);
    await addSearchProvider(client, "tavily", undefined, undefined, made);
    expect(sent.filter((entry) => entry.payload["action"] === "add").at(-1)?.payload).not.toHaveProperty("credentialRef");
    expect(await addSearchProvider(client, "tavily", "tvly-key", undefined, made)).toMatchObject({ message: "429 from Tavily" });
    expect(sent.filter((entry) => entry.payload["action"] === "add").at(-1)?.payload).toMatchObject({ credentialRef: "search.tavily" });
  });
});

describe("the search step", () => {
  const searchFlow: OnboardingFlowAnswer = {
    ...FLOW,
    flow: {
      ...FLOW.flow,
      steps: [...FLOW.flow.steps, { id: "search", kind: "search", title: "Web search", body: "A step.", optional: true }],
    },
  };
  const searchStatus: OnboardingStatus = {
    ...status("done"),
    steps: [...status("done").steps, { kind: "search", state: "todo", detail: "Web search is not set up" }],
    open: ["about", "search"],
  };
  async function searchStep() {
    const scripted = owner({
      ...base("done"),
      "onboarding:flow": searchFlow,
      "onboarding:status": searchStatus,
      "search:list": { providers: [] },
      "credentials:list": { credentials: [] },
    });
    const page = await mount(
      <Welcome client={scripted.client} workspaceId="default" stepId="search" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    const label = [...page.querySelectorAll("label")].find((candidate) => candidate.textContent === "Search provider");
    const trigger = label === undefined ? null : document.getElementById(label.htmlFor);
    return { ...scripted, page, trigger };
  }
  const field = (page: HTMLElement, placeholder: string): HTMLInputElement | null =>
    [...page.querySelectorAll("input")].find((input) => input.placeholder.startsWith(placeholder)) ?? null;

  it.each([
    { kind: "tavily", key: "", baseUrl: undefined, credentialRef: undefined },
    { kind: "tavily", key: "tvly-key", baseUrl: undefined, credentialRef: "search.tavily" },
    { kind: "brave", key: " brave-key ", baseUrl: undefined, credentialRef: "search.brave" },
    { kind: "serper", key: "serper-key", baseUrl: undefined, credentialRef: "search.serper" },
    { kind: "searxng", key: undefined, baseUrl: "http://127.0.0.1:8888", credentialRef: undefined },
  ])("sends $kind with key $key as the owner takes it", async ({ kind, key, baseUrl, credentialRef }) => {
    const { page, trigger, sent, actions } = await searchStep();
    await pick(trigger, kind);
    expect(selected(trigger)).toBe(kind);
    if (key === undefined) expect(field(page, "Paste the key")).toBeNull();
    else await type(field(page, "Paste the key"), key);
    if (baseUrl === undefined) expect(field(page, "e.g. http://")).toBeNull();
    else await type(field(page, "e.g. http://"), baseUrl);
    await click(button(page, "Add and test"));
    const added = sent.find((entry) => entry.command === "search" && entry.payload["action"] === "add")?.payload;
    expect(added).toMatchObject({ providerId: kind, kind });
    expect(added?.["credentialRef"]).toBe(credentialRef);
    expect(added?.["baseUrl"]).toBe(baseUrl);
    const set = sent.find((entry) => entry.command === "credentials" && entry.payload["action"] === "set")?.payload;
    expect(set).toEqual(credentialRef === undefined ? undefined : { action: "set", reference: credentialRef, value: key?.trim() });
    expect(actions()).toContain("search:test");
  });

  it("asks for a required key before sending anything, and forgets the ask once one is typed", async () => {
    const { page, trigger, actions } = await searchStep();
    await pick(trigger, "brave");
    await click(button(page, "Add and test"));
    expect(page.textContent).toContain("Brave Search needs an API key");
    expect(field(page, "Paste the key")?.getAttribute("aria-invalid")).toBe("true");
    expect(actions().filter((action) => action.startsWith("search:") || action.startsWith("credentials:"))).toEqual([]);
    await type(field(page, "Paste the key"), "k");
    expect(page.textContent).not.toContain("needs an API key");
  });
});

describe("the first-run redirect and the routes", () => {
  it("redirects once a browser session, and keeps working when storage is refused", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(redirectedThisSession(storage)).toBe(false);
    expect(store.get(WELCOME_REDIRECT_KEY)).toBe("1");
    expect(redirectedThisSession(storage)).toBe(true);
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(redirectedThisSession(refusing)).toBe(false);
  });

  it("parses and spells /welcome and /welcome/<step>", () => {
    expect(parseRoute("/welcome")).toMatchObject({ route: "welcome" });
    expect(parseRoute("/welcome/about")).toMatchObject({ route: "welcome", stepId: "about" });
    expect(routePath(parseRoute("/welcome/about"))).toBe("/welcome/about");
    expect(routePath(parseRoute("/welcome/"))).toBe("/welcome");
    // `?all=1` is the route's, so it stays on every step of the walk.
    expect(parseRoute("/welcome/about", "?all=1")).toMatchObject({ route: "welcome", stepId: "about", welcomeAll: true });
    expect(routePath({ ...parseRoute("/welcome", "?all=1"), stepId: "search" })).toBe("/welcome/search?all=1");
  });
});

describe("a flow plugin's info step", () => {
  const FRAMED: OnboardingFlowAnswer = {
    providerId: "acme.onboarding",
    flow: {
      ...FLOW.flow,
      steps: [
        FLOW.flow.steps[0]!,
        { id: "welcome-acme", kind: "info", title: "How ACME uses Tavi", body: "Read this first.", optional: true, frame: "intro" },
      ],
    },
  };
  const contribution = (pluginId: string) => ({
    pluginId,
    contentHash: "a".repeat(64),
    builtin: false,
    placement: { slot: "onboarding.step" as const },
    contribution: { id: "intro", title: "Intro", document: "intro.html", channels: [], placements: [{ slot: "onboarding.step" as const }] },
    placements: [{ slot: "onboarding.step" as const }],
  });
  const infoStatus = (state: "todo" | "done"): OnboardingStatus => ({
    ...status("done"),
    steps: [
      { kind: "model", state: "done", detail: "" },
      { kind: "info", state, detail: "" },
    ],
    open: state === "done" ? [] : ["info"],
  });
  const frames = (pluginId: string) => ({
    items: [contribution(pluginId)],
    client: { liveWatch: () => ({ close: () => undefined }) } as never,
  });

  it("shows the flow plugin's own frame, sandboxed, and marks the step seen on Got it", async () => {
    const { client, sent } = owner({
      "onboarding:flow": FRAMED,
      "onboarding:status": infoStatus("todo"),
      "onboarding:detect": { env: [], local: [], existing: [] },
      "onboarding:complete-step": infoStatus("done"),
    });
    const onStep = vi.fn();
    const page = await mount(
      <Welcome
        client={client}
        workspaceId="default"
        stepId="welcome-acme"
        frames={frames("acme.onboarding")}
        onStep={onStep}
        onLeave={() => {}}
        onSettings={() => {}}
      />,
    );
    const frame = page.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(page.textContent).toContain("Read this first.");
    await click(button(page, "Got it"));
    expect(sent.find((entry) => entry.payload["action"] === "complete-step")?.payload).toMatchObject({ step: "info" });
    expect(onStep).toHaveBeenCalledWith("done");
  });

  it("never shows another plugin's contribution in its place", async () => {
    const { client } = owner({
      "onboarding:flow": FRAMED,
      "onboarding:status": infoStatus("todo"),
      "onboarding:detect": { env: [], local: [], existing: [] },
    });
    const page = await mount(
      <Welcome
        client={client}
        workspaceId="default"
        stepId="welcome-acme"
        frames={frames("evil.plugin")}
        onStep={() => {}}
        onLeave={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.textContent).toContain("Read this first.");
    // Its own, but one that receives a channel (a placement moved it there): not shown either.
    const live = frames("acme.onboarding");
    const withChannel = {
      ...live,
      items: live.items.map((item) => ({
        ...item,
        contribution: { ...item.contribution, channels: ["mod.state" as const], disclosure: "State." },
      })),
    };
    const again = await mount(
      <Welcome
        client={client}
        workspaceId="default"
        stepId="welcome-acme"
        frames={withChannel}
        onStep={() => {}}
        onLeave={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(again.querySelector("iframe")).toBeNull();
  });
});

// ------------------------------------------------------------------ the keyboard alone

/**
 * What a browser treats as reachable by Tab on the page under test: enabled
 * controls and links, in document order, none with a negative tabindex.
 */
function tabbable(page: ParentNode): HTMLElement[] {
  return [...page.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")].filter(
    (element) =>
      element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled && !element.hidden && element.getAttribute("type") !== "hidden",
  );
}

/**
 * Tab until `wanted` has focus, as sequential focus navigation does: from the
 * focused element, or from the top of the page when focus fell to the body (a
 * control that went away took it). jsdom moves no focus on Tab, so the move
 * is the browser's default action modelled here; nothing is clicked.
 */
async function tabTo(page: ParentNode, wanted: (element: HTMLElement) => boolean): Promise<HTMLElement> {
  for (let presses = 0; presses < 40; presses += 1) {
    const order = tabbable(page);
    const from = document.activeElement;
    const after =
      from === null || from === document.body
        ? order
        : order.filter((element) => (from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    const next = after[0];
    if (next === undefined) break;
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
      next.focus();
    });
    if (wanted(next)) return next;
  }
  throw new Error("no such control within reach of Tab");
}
const named =
  (text: string) =>
  (element: HTMLElement): boolean =>
    element.tagName === "BUTTON" && element.textContent?.trim() === text;

/**
 * A key on the focused element, with the browser's activation behaviour:
 * Enter on a button clicks it on keydown and Space on keyup; Enter in a text
 * field submits its form (implicit submission). Each default action is
 * skipped when a handler prevented it.
 */
async function press(key: "Enter" | " "): Promise<void> {
  const target = document.activeElement as HTMLElement | null;
  if (target === null || target === document.body) throw new Error("nothing has focus");
  await act(async () => {
    const down = target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    if (down && key === "Enter" && target instanceof HTMLButtonElement)
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    if (down && key === "Enter" && target instanceof HTMLInputElement && target.form !== null) {
      const submitter = target.form.querySelector<HTMLButtonElement>("button[type='submit']");
      if (submitter !== null && !submitter.disabled) target.form.requestSubmit(submitter);
    }
    const up = target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    if (up && key === " " && target instanceof HTMLButtonElement)
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  });
  await settle();
}

/** Characters typed into the focused field, a key event each. */
async function typeKeys(text: string): Promise<void> {
  const field = document.activeElement;
  if (!(field instanceof HTMLInputElement)) throw new Error("no field has focus");
  for (const character of text) {
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true, cancelable: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, field.value + character);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keyup", { key: character, bubbles: true, cancelable: true }));
    });
  }
  await settle();
}

describe("where focus lands in the model step", () => {
  it("on the stage's field, else its primary button, never Back, including when OpenRouter's form switches to pasting", async () => {
    const { client } = owner({ ...base(), "onboarding:status": { ...status("todo"), chatGptSignIn: true } });
    const page = await mount(<Welcome client={client} workspaceId="default" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />);
    await click(
      [...page.querySelectorAll<HTMLButtonElement>(".provider-tile")].find((tile) => tile.textContent?.startsWith("ChatGPT") === true),
    );
    expect(document.activeElement?.textContent).toBe("Continue with ChatGPT");
    await click(button(page, "Back"));
    await click(
      [...page.querySelectorAll<HTMLButtonElement>(".provider-tile")].find((tile) => tile.textContent?.startsWith("OpenRouter") === true),
    );
    expect(document.activeElement?.textContent).toBe("Sign in with OpenRouter");
    await click(button(page, "Paste a key instead"));
    expect((document.activeElement as HTMLInputElement | null)?.type).toBe("password");
    // Create a key goes to the provider's keys page, not its API reference.
    const create = [...page.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent === "Create a key");
    expect(create?.href).toBe("https://openrouter.ai/settings/keys");
  });
});

describe("Welcome by keyboard alone", () => {
  it("goes from the model to a verified default, Continue, about you and Save with Tab, Enter and Space only", async () => {
    let verified = false;
    const { client, sent, actions } = owner({
      ...base(),
      "onboarding:connect-key": { connectionId: "openai", models: ["gpt-5"], suggested: { main: "gpt-5" } },
      "onboarding:verify": (payload: Record<string, unknown>) => {
        verified = true;
        return {
          results: [{ role: payload["role"], connectionId: "openai", model: "gpt-5", ok: true, toolsOk: true }],
          status: status("done"),
        };
      },
      "onboarding:status": () => status(verified ? "done" : "todo"),
      "models:set-default": {},
      "workspace-settings:get": { workspaceId: "default", revision: 1, settings: {}, effective: { timezone: "UTC" }, hostTimezone: "UTC" },
      "heartbeat:get": new Error("off"),
      "memory:list": { records: [], otherPeople: [] },
      "onboarding:complete-step": status("done"),
      "onboarding:complete": status("done"),
    });
    const seen: (string | undefined)[] = [];
    const page = await mount(<Routed client={client} seen={(stepId) => void seen.push(stepId)} />);
    expect(document.activeElement?.textContent).toBe("Choose the model Tavi thinks with");
    await tabTo(page, (element) => element.classList.contains("provider-tile") && element.textContent?.startsWith("OpenAI") === true);
    await press("Enter");
    // Choosing a provider moves focus to its key, not back to the page.
    expect((document.activeElement as HTMLInputElement | null)?.type).toBe("password");
    await typeKeys("sk-test-keyboard");
    await press("Enter");
    expect(sent.find((entry) => entry.payload["action"] === "connect-key")?.payload).toMatchObject({
      preset: "openai",
      key: "sk-test-keyboard",
    });
    // Connected, focus is on the first control of the model picker.
    expect(document.activeElement?.closest(".welcome-roles")).not.toBeNull();
    await tabTo(page, named("Verify"));
    await press(" ");
    expect(page.textContent).toContain("Inference ready: gpt-5");
    expect(actions()).toContain("models:set-default");
    await tabTo(page, named("Continue"));
    await press("Enter");
    expect(seen.at(-1)).toBe("about");
    // Focus moved to the new step's heading, so Tab starts from there.
    expect(document.activeElement?.textContent).toBe("About you");
    await tabTo(page, (element) => element.getAttribute("autocomplete") === "name");
    await typeKeys("Robin");
    await tabTo(page, named("Save"));
    await press(" ");
    expect(sent.find((entry) => entry.payload["key"] === "operatorName")?.payload).toMatchObject({ action: "set", value: "Robin" });
    expect(actions()).toContain("onboarding:complete-step");
    expect(seen.at(-1)).toBe("done");
    expect(document.activeElement?.textContent).toBe("You're set up");
    await tabTo(page, named("Go to Home"));
    await press("Enter");
    expect(actions()).toContain("onboarding:complete");
  });
});

// ------------------------------------------------------------------ a refused key, typed again

describe("a key the provider refused", () => {
  it("offers Change the key beside Retry, connects the same preset again, and verifies the same connection", async () => {
    let keys = 0;
    const { client, sent, actions } = owner({
      ...base(),
      // The owner reuses the connection setup created for the preset: the same id both times.
      "onboarding:connect-key": () => {
        keys += 1;
        return { connectionId: "openai", models: ["gpt-5"], suggested: { main: "gpt-5" } };
      },
      "onboarding:verify": () =>
        keys === 1
          ? {
              results: [
                {
                  role: "main",
                  connectionId: "openai",
                  model: "gpt-5",
                  ok: false,
                  errorCode: "auth",
                  advice: "The key was refused. Check it, or create a new one.",
                },
              ],
              status: status("todo"),
            }
          : { results: [{ role: "main", connectionId: "openai", model: "gpt-5", ok: true, toolsOk: true }], status: status("done") },
      "models:set-default": {},
    });
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="model" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    await click(button(page, "OpenAI"));
    await type(page.querySelector("input[type='password']"), "sk-test-wrong");
    await click(button(page, "Connect"));
    await click(button(page, "Verify"));
    expect(page.textContent).toContain("Failed: gpt-5: The key was refused.");
    expect(button(page, "Retry")).toBeDefined();
    await click(button(page, "Change the key"));
    // The same provider's key field, not the provider grid.
    expect(page.querySelector("label")?.textContent).toBe("OpenAI key");
    expect(page.querySelector("ul[aria-label='Model providers']")).toBeNull();
    await type(page.querySelector("input[type='password']"), "sk-test-right");
    await click(button(page, "Connect"));
    await click(button(page, "Verify"));
    expect(page.textContent).toContain("Inference ready: gpt-5");
    expect(sent.filter((entry) => entry.payload["action"] === "connect-key").map((entry) => entry.payload)).toEqual([
      { action: "connect-key", workspaceId: "default", preset: "openai", key: "sk-test-wrong" },
      { action: "connect-key", workspaceId: "default", preset: "openai", key: "sk-test-right" },
    ]);
    expect(sent.filter((entry) => entry.payload["action"] === "verify").map((entry) => entry.payload["target"])).toEqual([
      { connectionId: "openai", model: "gpt-5" },
      { connectionId: "openai", model: "gpt-5" },
    ]);
    expect(sent.filter((entry) => entry.payload["action"] === "set-default").map((entry) => entry.payload)).toEqual([
      { action: "set-default", workspaceId: "default", connectionId: "openai", model: "gpt-5" },
    ]);
    expect(actions()).not.toContain("models:add");
    expect(page.innerHTML).not.toContain("sk-test-");
  });

  it("does not offer Change the key for a failure that is not the key's", async () => {
    const { client } = owner({
      ...base(),
      "onboarding:connect-key": { connectionId: "openai", models: ["gpt-5"], suggested: { main: "gpt-5" } },
      "onboarding:verify": {
        results: [{ role: "main", connectionId: "openai", model: "gpt-5", ok: false, errorCode: "rate_limited", advice: "Wait a minute." }],
        status: status("todo"),
      },
    });
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="model" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    await click(button(page, "OpenAI"));
    await type(page.querySelector("input[type='password']"), "sk-x");
    await click(button(page, "Connect"));
    await click(button(page, "Verify"));
    expect(button(page, "Retry")).toBeDefined();
    expect(button(page, "Change the key")).toBeUndefined();
  });
});

// ------------------------------------------------------------------ memory paused, off, or corrected

describe("the about step and memory", () => {
  const settings = (memory?: { enabled: boolean }) => ({
    workspaceId: "default",
    revision: 1,
    settings: {},
    effective: {
      timezone: "UTC",
      ...(memory === undefined ? {} : { memory: { ...effectiveMemorySettings(undefined), enabled: memory.enabled } }),
    },
    hostTimezone: "UTC",
  });
  const about = (answers: Record<string, unknown>) =>
    owner({ ...base("done"), "heartbeat:get": new Error("off"), "onboarding:complete-step": status("done"), ...answers });
  const memoryActions = (actions: readonly string[]) => actions.filter((action) => action.startsWith("memory:"));

  it.each([
    ["paused in the workspace's settings", { "workspace-settings:get": settings({ enabled: false }) }, true, []],
    ["not offered by the owner", { "workspace-settings:get": settings() }, false, []],
    // A disabled `tavi.memory` refuses the one read; nothing more asks it.
    [
      "refused by the memory host",
      { "workspace-settings:get": settings(), "memory:list": new Error("memory is off") },
      true,
      ["memory:list"],
    ],
  ])("says memory is paused up front when it is %s, and saves the settings alone", async (_name, answers, offered, asked) => {
    const { client, sent, actions } = about(answers);
    const onStep = vi.fn();
    const page = await mount(
      <Welcome
        client={client}
        workspaceId="default"
        stepId="about"
        browserTimeZone="Europe/Lisbon"
        memory={offered}
        onStep={onStep}
        onLeave={() => {}}
        onSettings={() => {}}
      />,
    );
    expect(page.textContent).toContain("Memory is paused: these are kept in this workspace's settings only.");
    expect(page.querySelector("input[type='checkbox']")).toBeNull();
    await type(page.querySelector("input[autocomplete='name']"), "Robin");
    await click(button(page, "Save"));
    expect(
      sent
        .filter((entry) => entry.command === "workspace-settings" && entry.payload["action"] === "set")
        .map((entry) => [entry.payload["key"], entry.payload["value"]]),
    ).toEqual([
      ["operatorName", "Robin"],
      ["timezone", "Europe/Lisbon"],
    ]);
    expect(memoryActions(actions())).toEqual(asked);
    expect(onStep).toHaveBeenCalledWith("done");
  });

  it("corrects an approved preference that holds another value on a rerun, and adds the one not held", async () => {
    const AT = "2026-10-01T00:00:00.000Z";
    const held = {
      recordId: "pref-name",
      kind: "preference",
      scope: { kind: "personal", principalId: "operator" },
      scopeKey: "personal|p=operator",
      preferenceKey: "user.name",
      currentRevisionId: "rev-1",
      status: "approved",
      sensitivity: "normal",
      revocationGeneration: 0,
      recordedAt: AT,
      updatedAt: AT,
      target: "personal",
      title: "Name",
      body: "Name: Rob",
      redacted: false,
      truncated: false,
      sourceCount: 0,
    };
    const { client, sent, actions } = about({
      "workspace-settings:get": { ...settings({ enabled: true }), settings: { operatorName: "Rob" } },
      "memory:list": { records: [held], otherPeople: [] },
      "memory:correct": {},
      "memory:remember": {},
    });
    const page = await mount(
      <Welcome
        client={client}
        workspaceId="default"
        stepId="about"
        browserTimeZone="Europe/Lisbon"
        memory
        onStep={() => {}}
        onLeave={() => {}}
        onSettings={() => {}}
      />,
    );
    expect((page.querySelector("input[autocomplete='name']") as HTMLInputElement).value).toBe("Rob");
    await type(page.querySelector("input[autocomplete='name']"), "Robin");
    expect(page.textContent).toContain("Tavi will remember: your name is Robin · you're in Europe/Lisbon");
    await click(button(page, "Save"));
    expect(sent.find((entry) => entry.payload["action"] === "correct")?.payload).toEqual({
      action: "correct",
      workspaceId: "default",
      recordId: "pref-name",
      preferenceValue: "Robin",
      body: "Name: Robin",
    });
    expect(sent.find((entry) => entry.payload["action"] === "remember")?.payload).toMatchObject({
      preferenceKey: "user.timezone",
      preferenceValue: "Europe/Lisbon",
    });
    expect(actions().filter((action) => action === "memory:correct")).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ which steps, and why this flow

describe("which steps Welcome walks", () => {
  it("keeps done steps in the rail, checked, counts the whole flow, and opens on the first still to do", async () => {
    const { client } = owner(base("done"));
    const stepper = (page: HTMLElement) =>
      [...page.querySelectorAll("ol[aria-label='Setup steps'] li")].map((item) => item.textContent?.trim());
    const buttons = (page: HTMLElement) => [...page.querySelectorAll(".welcome-panel button")].map((button) => button.textContent?.trim());
    const onStep = vi.fn();
    const plain = await mount(<Welcome client={client} workspaceId="default" onStep={onStep} onLeave={() => {}} onSettings={() => {}} />);
    expect(stepper(plain)).toEqual(["Choose the model Tavi thinks with (done)", "2 About you"]);
    expect(onStep).toHaveBeenCalledWith("about", { replace: true });
    expect(plain.querySelector(".welcome-progress")?.textContent).toBe("1 of 2 done");
    expect(plain.querySelector(".welcome-panel .eyebrow")?.textContent).toContain("Step 2 of 2");
    // An optional step with nothing done offers Skip, never Continue beside it.
    expect(buttons(plain)).toContain("Skip");
    expect(buttons(plain)).not.toContain("Continue");
    unmountAll();
    // ?all=1 starts at the first step; a done step offers Continue, never Skip.
    const all = await mount(
      <Welcome client={client} workspaceId="default" all onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    expect(stepper(all)).toEqual(["Choose the model Tavi thinks with (done)", "2 About you"]);
    expect(all.querySelector("[aria-current='step']")?.textContent).toContain("Choose the model");
    expect(buttons(all)).toContain("Continue");
    expect(buttons(all)).not.toContain("Skip");
  });

  it("lists a step only a terminal can do, counted, with the command that does it", async () => {
    const withService = {
      ...FLOW,
      flow: {
        ...FLOW.flow,
        steps: [
          ...FLOW.flow.steps,
          {
            id: "service",
            kind: "service" as const,
            title: "Keep Tavi running",
            body: "Start it with your computer.",
            optional: true,
            surfaces: ["cli" as const],
          },
        ],
      },
    };
    const done = status("done");
    const { client } = owner({
      ...base("done"),
      "onboarding:flow": withService,
      "onboarding:status": {
        ...done,
        steps: [...done.steps, { kind: "service", state: "todo", detail: "", elsewhere: "cli" }],
        open: ["about", "service"],
      },
    });
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="service" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    expect(page.querySelector(".welcome-progress")?.textContent).toBe("1 of 3 done");
    expect(page.querySelector(".welcome-panel")?.textContent).toContain("Do this in a terminal: tavi setup service");
  });

  it("moves on to the next step still to do, past a done one, and walks every step with all", async () => {
    const { client } = owner(base("done"));
    const onStep = vi.fn();
    // On the model step (done), the next step still to do is About you.
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="model" onStep={onStep} onLeave={() => {}} onSettings={() => {}} />,
    );
    const next = () =>
      [...page.querySelectorAll<HTMLButtonElement>(".welcome-panel button")].find((button) => button.textContent === "Continue");
    await act(async () => next()?.click());
    expect(onStep).toHaveBeenLastCalledWith("about");
    unmountAll();
    // Walking every step, Continue goes to the next one, done or not.
    const walked = vi.fn();
    const all = await mount(
      <Welcome client={client} workspaceId="default" all stepId="model" onStep={walked} onLeave={() => {}} onSettings={() => {}} />,
    );
    const onward = [...all.querySelectorAll<HTMLButtonElement>(".welcome-panel button")].find(
      (button) => button.textContent === "Continue",
    );
    await act(async () => onward?.click());
    expect(walked).toHaveBeenLastCalledWith("about");
  });

  it("says politely why the selected flow plugin's steps are not the ones shown", async () => {
    const reason = "acme.onboarding's flow was not used: it did not answer within 5 s";
    const { client } = owner({ ...base(), "onboarding:flow": { ...FLOW, fallback: reason } });
    const page = await mount(<Welcome client={client} workspaceId="default" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />);
    const notice = page.querySelector(".welcome-fallback");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toBe(`Setup is showing Tavi's own steps: ${reason}`);
    // The status's own word serves when the flow's answer has none.
    const fromStatus = owner({ ...base(), "onboarding:status": { ...status("todo"), flowFallback: reason } });
    expect(
      (
        await mount(<Welcome client={fromStatus.client} workspaceId="default" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />)
      ).querySelector(".welcome-fallback")?.textContent,
    ).toContain(reason);
    const plain = owner(base());
    expect(
      (
        await mount(<Welcome client={plain.client} workspaceId="default" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />)
      ).querySelector(".welcome-fallback"),
    ).toBeNull();
  });
});

// ------------------------------------------------------------------ "New with <app>"

describe("the ideas step's New with <app>", () => {
  const IDEAS_ON = {
    settings: {
      enabled: true,
      provider: "tavi.ideasagent",
      chips: true,
      sources: { memory: true, tasks: true, brief: true },
      dailyTokens: 20_000,
      hours: { start: "08:00", end: "22:00" },
    },
  };
  const IDEAS_FLOW: OnboardingFlowAnswer = {
    ...FLOW,
    flow: {
      ...FLOW.flow,
      steps: [FLOW.flow.steps[0]!, { id: "ideas", kind: "ideas", title: "First ideas", body: "Try one.", optional: true }],
    },
  };
  const withApps = (home: "connected" | "available"): OnboardingStatus => ({
    ...status("done"),
    steps: [
      { kind: "model", state: "done", detail: "" },
      {
        kind: "apps",
        state: "done",
        detail: "",
        items: [
          { id: "gmail", label: "Gmail", state: "connected" },
          { id: "homeassistant", label: "Home Assistant", state: home },
        ],
      },
      { kind: "ideas", state: "todo", detail: "" },
    ],
    open: ["ideas"],
  });

  it("marks only an app connected since Welcome opened, not one connected before it", async () => {
    let home: "connected" | "available" = "available";
    const { client } = owner({
      ...base("done"),
      "onboarding:flow": IDEAS_FLOW,
      "onboarding:status": () => withApps(home),
      "ideas:settings": IDEAS_ON,
      "ideas:chips": {
        chips: [
          { label: "Triage my inbox", prompt: "Sort my inbox.", uses: [{ capability: "mailbox", approval: true }] },
          { label: "Dim the lights", prompt: "Dim the lights at ten.", uses: [{ capability: "home", approval: false }] },
        ],
      },
      "ideas:refresh": new Error("not now"),
    });
    const page = await mount(
      <Welcome client={client} workspaceId="default" stepId="ideas" onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />,
    );
    expect(page.textContent).toContain("Triage my inbox");
    // Gmail was connected before setup opened: nothing about it is new.
    expect(page.querySelectorAll(".badge")).toHaveLength(0);
    // Home Assistant connected meanwhile (another tab): the status read on focus brings it.
    home = "connected";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect([...page.querySelectorAll(".welcome-card h2")].map((heading) => heading.textContent)).toEqual([
      "Triage my inbox",
      "Dim the lightsNew with Home Assistant",
    ]);
  });
});
