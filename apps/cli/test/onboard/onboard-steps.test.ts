import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";

import { ONBOARDING_ABI, type OnboardingStatus } from "@tavi/contracts";
import { temporaryDirectories, partialFake, delay } from "@tavi/test-support";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli/parse.js";
import { ChatApp } from "../../src/tui/app.js";
import { chatInkOptions } from "../../src/tui/index.js";
import { ChatStore } from "../../src/tui/store.js";
import { main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { runOnboard } from "../../src/features/onboard/flow.js";
import { createLinePrompter } from "../../src/features/onboard/prompter.js";
import {
  channelsStep,
  ideasStep,
  serviceStep,
  tasksStep,
  TODOIST_CONNECT_COMMANDS,
  unitPlace,
  userScopeRunner,
  type StepContext,
  type StepSystem,
} from "../../src/features/onboard/steps.js";
import type { OnboardTransport } from "../../src/features/onboard/transport.js";
import { renderServiceUnit } from "../../src/features/service/unit.js";
import { fakeTty } from "../support/fake-tty.js";

/**
 * The terminal's steps after the model:
 * about you, Telegram pairing, keeping Tavi running, first prompts, the
 * headless flags and `tavi chat --draft`. Steps are driven through a scripted
 * transport (the owner's answers) and the line renderer; the service step
 * writes under a temporary HOME and runs nothing but its injected runner.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const STATUS: OnboardingStatus = {
  workspaceId: "default",
  providerId: "tavi.onboarding",
  steps: [
    { kind: "model", state: "done", detail: "OpenRouter · m · verified" },
    { kind: "service", state: "todo", detail: "" },
  ],
  complete: true,
  firstRun: false,
  open: ["service"],
};

/** A transport answering from `answers` by `command:action`, recording every request. */
function scripted(answers: Record<string, unknown | ((payload: Record<string, unknown>) => unknown)>, attached = true) {
  const sent: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  const transport = partialFake<OnboardTransport>({
    attached,
    request: async (command: string, payload: Record<string, unknown>) => {
      sent.push({ command, payload });
      const answer = answers[`${command}:${String(payload["action"])}`];
      if (answer === undefined) return {};
      return typeof answer === "function" ? (answer as (payload: Record<string, unknown>) => unknown)(payload) : answer;
    },
  });
  return { transport, sent, actions: () => sent.map((entry) => `${entry.command}:${String(entry.payload["action"])}`) };
}

function prompter(lines: readonly string[]) {
  const input = new PassThrough();
  input.end(lines.map((line) => `${line}\n`).join(""));
  let written = "";
  return { prompter: createLinePrompter({ input, write: (text) => void (written += text) }), written: () => written };
}

function system(overrides: Partial<StepSystem> = {}): StepSystem & { readonly runs: string[] } {
  const runs: string[] = [];
  const files = new Map<string, string>();
  return {
    platform: "darwin",
    home: "/home/test",
    dataDirectory: "/data/mine",
    nodePath: "/usr/local/bin/node",
    entryPath: "/usr/local/lib/tavi/executable.mjs",
    run: async (command, args) => {
      runs.push([command, ...args].join(" "));
      return { code: 0, output: "" };
    },
    sleep: async () => undefined,
    readText: async (path) => files.get(path),
    writeText: async (path, text) => void files.set(path, text),
    remove: async (path) => void files.delete(path),
    runs,
    ...overrides,
  } as StepSystem & { readonly runs: string[] };
}

const context = (transport: OnboardTransport, prompterLines: readonly string[], sys: StepSystem, extra: Partial<StepContext> = {}) => {
  const { prompter: lines, written } = prompter(prompterLines);
  return {
    context: { transport, prompter: lines, system: sys, workspaceId: "default", mode: "onboard" as const, status: STATUS, ...extra },
    written,
  };
};

describe("the model step by Sign in with ChatGPT", () => {
  const flow = {
    providerId: "tavi.onboarding",
    flow: {
      abi: ONBOARDING_ABI,
      version: 1,
      title: "Welcome",
      steps: [{ id: "model", kind: "model", title: "Model", body: "Pick one.", optional: false }],
      done: { title: "Done", body: "Done." },
    },
  };
  // The owner offers the sign-in (its preview is on); the terminal offers it only then.
  const open = {
    workspaceId: "default",
    providerId: "tavi.onboarding",
    steps: [{ kind: "model", state: "todo", detail: "" }],
    complete: false,
    firstRun: true,
    open: ["model"],
    chatGptSignIn: true,
  };

  it("signs in, hands the token record to the owner, and makes the chosen model the default once it verifies", async () => {
    let verified = false;
    const owner = scripted({
      "onboarding:flow": flow,
      "onboarding:status": () =>
        verified
          ? { ...open, steps: [{ kind: "model", state: "done", detail: "ChatGPT · gpt-6.1-sol · verified" }], complete: true, open: [] }
          : open,
      "models:list": [],
      "onboarding:connect-signed-in": { connectionId: "chatgpt", models: ["gpt-6.1-sol", "gpt-6.1-mini"] },
      "onboarding:verify": () => {
        verified = true;
        return { results: [{ role: "main", connectionId: "chatgpt", model: "gpt-6.1-sol", ok: true, toolsOk: true }] };
      },
    });
    const { prompter: lines, written } = prompter(["6", "", "n"]);
    const outcome = await runOnboard(
      {
        transport: owner.transport,
        prompter: lines,
        env: {},
        fetch: async () => {
          throw new TypeError("offline");
        },
        readFile: async () => "",
        readStdin: async () => "",
        system: system(),
        signInWithChatGpt: async () => '{"kind":"chatgpt-sign-in"}',
      },
      { mode: "onboard", workspaceId: "default", only: ["model"] },
    );
    expect(outcome.exit).toBe(0);
    expect(written()).toContain("ChatGPT (preview)");
    expect(written()).toContain("uses your ChatGPT plan's allowance");
    expect(owner.sent.find((entry) => entry.payload["action"] === "connect-signed-in")?.payload).toMatchObject({
      preset: "chatgpt",
      credential: '{"kind":"chatgpt-sign-in"}',
    });
    // The default is the model it verified, on the ChatGPT connection.
    const checked = (owner.sent.find((entry) => entry.payload["action"] === "verify")?.payload["target"] as { model: string }).model;
    expect(owner.sent.find((entry) => entry.payload["action"] === "set-default")?.payload).toMatchObject({
      connectionId: "chatgpt",
      model: checked,
    });
    // The record went to the owner once and was never said.
    expect(written()).not.toContain("chatgpt-sign-in");
  });

  it("is not offered when the owner does not offer it (its preview is off)", async () => {
    const { chatGptSignIn: _offered, ...notOffered } = open;
    const owner = scripted({ "onboarding:flow": flow, "onboarding:status": notOffered, "models:list": [] });
    // The first option picked, then the walk stops at the key prompt with no input left.
    const { prompter: lines, written } = prompter(["1"]);
    await runOnboard(
      {
        transport: owner.transport,
        prompter: lines,
        env: {},
        fetch: async () => {
          throw new TypeError("offline");
        },
        readFile: async () => "",
        readStdin: async () => "",
        system: system(),
        signInWithChatGpt: async () => '{"kind":"chatgpt-sign-in"}',
      },
      { mode: "onboard", workspaceId: "default", only: ["model"] },
    );
    expect(written()).toContain("Which model provider?");
    expect(written()).not.toContain("ChatGPT (preview)");
  });

  it("says why when the sign-in fails, and leaves the model step open", async () => {
    const owner = scripted({ "onboarding:flow": flow, "onboarding:status": open, "models:list": [] });
    const { prompter: lines, written } = prompter(["6"]);
    await runOnboard(
      {
        transport: owner.transport,
        prompter: lines,
        env: {},
        fetch: async () => {
          throw new TypeError("offline");
        },
        readFile: async () => "",
        readStdin: async () => "",
        system: system(),
        signInWithChatGpt: async () => {
          throw new Error("A ChatGPT sign-in is kept only in an encrypted credential store");
        },
      },
      { mode: "onboard", workspaceId: "default", only: ["model"] },
    );
    expect(written()).toContain("✗ A ChatGPT sign-in is kept only in an encrypted credential store");
    expect(owner.actions()).not.toContain("onboarding:connect-signed-in");
    expect(owner.actions()).not.toContain("models:set-default");
  });
});

describe("the walk's edges", () => {
  const flow = {
    providerId: "tavi.onboarding",
    flow: {
      abi: ONBOARDING_ABI,
      version: 1,
      title: "Welcome",
      steps: [
        { id: "model", kind: "model", title: "Model", body: "Pick one.", optional: false },
        { id: "about", kind: "about", title: "About you", body: "Name.", optional: true },
        { id: "apps", kind: "apps", title: "Connect an app", body: "Mail.", optional: true, surfaces: ["web"] },
        { id: "channels", kind: "channels", title: "Message Tavi", body: "Telegram.", optional: true },
      ],
      done: { title: "Done", body: "Done." },
    },
  };
  const done = {
    workspaceId: "default",
    providerId: "tavi.onboarding",
    steps: [
      { kind: "model", state: "done", detail: "" },
      { kind: "about", state: "todo", detail: "" },
      { kind: "channels", state: "todo", detail: "" },
    ],
    complete: true,
    firstRun: false,
    open: ["about", "channels"],
  };
  const deps = (transport: OnboardTransport, lines: ReturnType<typeof prompter>["prompter"]) => ({
    transport,
    prompter: lines,
    env: {},
    fetch: async () => {
      throw new TypeError("offline");
    },
    readFile: async () => "",
    readStdin: async () => "",
    system: system(),
  });

  it("names the command for a canvas-only step, in tavi setup apps and at the end of tavi onboard", async () => {
    const owner = scripted({ "onboarding:flow": flow, "onboarding:status": done });
    const setup = prompter([]);
    await runOnboard(deps(owner.transport, setup.prompter), { mode: "setup", workspaceId: "default", step: "apps" });
    expect(setup.written()).toContain("○ Connect an app — this one is done in tavi ui, or now with: tavi apps connect <app>");
    const walk = prompter(["n", "n"]);
    await runOnboard(deps(owner.transport, walk.prompter), { mode: "onboard", workspaceId: "default" });
    expect(walk.written()).toContain("○ Connect an app — this one is done in tavi ui, or now with: tavi apps connect <app>");
    // A step this run already said is not said again at the end.
    expect(setup.written().split("Connect an app").length - 1).toBe(1);
  });

  it("titles a run by what it walks: one step, what is left of onboarding, or all of setup", async () => {
    const owner = scripted({ "onboarding:flow": flow, "onboarding:status": done });
    const one = prompter([]);
    await runOnboard(deps(owner.transport, one.prompter), { mode: "setup", workspaceId: "default", step: "apps" });
    expect(one.written().split("\n")[0]).toBe("Setup");
    const left = prompter(["n", "n"]);
    await runOnboard(deps(owner.transport, left.prompter), { mode: "onboard", workspaceId: "default" });
    expect(left.written()).toContain("Setup — what is left");
    const all = prompter(["n", "n", "n", "n", "n", "n", "n", "n"]);
    await runOnboard(deps(owner.transport, all.prompter), { mode: "setup", workspaceId: "default" });
    expect(all.written()).not.toContain("what is left");
  });

  it("with no flow at all, prints the checklist with each open step's command and asks nothing", async () => {
    const owner = scripted({ "onboarding:flow": { ...flow, providerId: "host" }, "onboarding:status": { ...done, providerId: null } });
    const run = prompter([]);
    const outcome = await runOnboard(deps(owner.transport, run.prompter), { mode: "onboard", workspaceId: "default" });
    expect(outcome.exit).toBe(0);
    expect(run.written()).toContain("guided flow is turned off");
    expect(run.written()).toContain("tavi channels add <kind>");
    expect(run.written()).not.toContain("[Y/n]");
  });

  it("ends with Fix the fast model when the fast model failed, and only then", async () => {
    const failed = {
      ...done,
      steps: [
        { kind: "model", state: "done", detail: "OpenRouter · verified · Fast model failed: The model is not available" },
        ...done.steps.slice(1),
      ],
    };
    const run = prompter(["n", "n"]);
    await runOnboard(deps(scripted({ "onboarding:flow": flow, "onboarding:status": failed }).transport, run.prompter), {
      mode: "onboard",
      workspaceId: "default",
    });
    expect(run.written()).toContain("○ Fix the fast model — The model is not available\n  tavi models set-role fast <connection> <model>");
    const healthy = prompter(["n", "n"]);
    await runOnboard(deps(scripted({ "onboarding:flow": flow, "onboarding:status": done }).transport, healthy.prompter), {
      mode: "onboard",
      workspaceId: "default",
    });
    expect(healthy.written()).not.toContain("Fix the fast model");
  });

  it("exits 4 when tavi setup channels needs an owner and none runs", async () => {
    const owner = scripted({ "onboarding:flow": flow, "onboarding:status": done }, false);
    const run = prompter([]);
    const outcome = await runOnboard(deps(owner.transport, run.prompter), { mode: "setup", workspaceId: "default", step: "channels" });
    expect(outcome.exit).toBe(4);
    expect(run.written()).toContain("pairing needs a running owner");
  });

  it("headless --channel-secret on a running owner adds and tests the channel, leaves pairing open, names it next, and exits 0", async () => {
    const owner = scripted(
      {
        "onboarding:flow": flow,
        "onboarding:status": done,
        "channels:catalog": {
          channels: [
            {
              providerId: "telegram",
              label: "Telegram",
              settings: [],
              auth: { kind: "secrets", fields: [{ key: "token", label: "Bot token" }] },
            },
          ],
        },
        "channels:list": { connections: [] },
        "channels:save": { connectionId: "telegram" },
        "channels:probe": { ok: true, detail: "Bot @tavi_bot." },
      },
      true,
    );
    const outcome = await runOnboard(
      { ...deps(owner.transport, prompter([]).prompter), readFile: async () => "123:token\n" },
      {
        mode: "setup",
        workspaceId: "default",
        headless: { preset: "openrouter", channelSecrets: [{ channel: "telegram", field: "token", file: "/run/bot.token" }] },
      },
    );
    expect(outcome).toMatchObject({ exit: 0, next: "tavi channels pair telegram" });
    expect(owner.sent.find((entry) => entry.payload["action"] === "save")?.payload).toMatchObject({
      providerId: "telegram",
      secrets: { token: "123:token" },
    });
    expect(owner.actions()).not.toContain("channels:pair");
  });

  it("headless --channel-secret refuses a channel or field the catalog does not list, before reading or saving anything", async () => {
    const owner = scripted(
      {
        "onboarding:flow": flow,
        "onboarding:status": done,
        "channels:catalog": {
          channels: [
            {
              providerId: "telegram",
              label: "Telegram",
              settings: [],
              auth: { kind: "secrets", fields: [{ key: "token", label: "Bot token" }] },
            },
          ],
        },
      },
      true,
    );
    const read: string[] = [];
    const run = (channel: string, field: string) =>
      runOnboard(
        { ...deps(owner.transport, prompter([]).prompter), readFile: async (path: string) => (read.push(path), "x") },
        { mode: "setup", workspaceId: "default", headless: { preset: "openrouter", channelSecrets: [{ channel, field, file: "/run/s" }] } },
      );
    await expect(run("signal", "token")).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("signal") });
    await expect(run("telegram", "apiKey")).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("token") });
    expect(read).toEqual([]);
    expect(owner.actions()).not.toContain("channels:save");
  });

  it("parses --channel-secret as repeatable <channel>:<field>=<file> for one channel, and refuses another shape, a repeat or a second channel", () => {
    expect(
      parseArgs(["setup", "--non-interactive", "--channel-secret", "sms-x:token=/run/bot", "--channel-secret", "sms-x:sid=a=b"]).onboard,
    ).toMatchObject({
      channelSecrets: [
        { channel: "sms-x", field: "token", file: "/run/bot" },
        { channel: "sms-x", field: "sid", file: "a=b" },
      ],
    });
    // Setup records one channel as its own: a second is `tavi channels add`'s.
    expect(() =>
      parseArgs(["setup", "--non-interactive", "--channel-secret", "telegram:token=a", "--channel-secret", "sms-x:sid=b"]),
    ).toThrow(/names one channel/u);
    expect(() => parseArgs(["setup", "--non-interactive", "--channel-secret", "/run/bot"])).toThrow(/<channel>:<field>=<file>/u);
    expect(() =>
      parseArgs(["setup", "--non-interactive", "--channel-secret", "telegram:token=a", "--channel-secret", "telegram:token=b"]),
    ).toThrow(/given only once/u);
    expect(() => parseArgs(["setup", "--channel-secret", "telegram:token=a"])).toThrow(/goes with --non-interactive/u);
    expect(() => parseArgs(["setup", "--non-interactive", "--telegram-token-file", "a"])).toThrow();
  });

  it("headless: names the missing flag when the model is open and none was given, and leaves a flagless step as it is", async () => {
    const open = {
      ...done,
      steps: [{ kind: "model", state: "todo", detail: "" }, ...done.steps.slice(1)],
      complete: false,
      open: ["model", "about", "channels"],
    };
    const fresh = scripted({ "onboarding:flow": flow, "onboarding:status": open });
    const bare = await runOnboard(deps(fresh.transport, prompter([]).prompter), {
      mode: "setup",
      workspaceId: "default",
      headless: { preset: "openrouter" },
    });
    expect(bare).toMatchObject({ exit: 3, missing: "--preset" });
    const owner = scripted({ "onboarding:flow": flow, "onboarding:status": done });
    const about = await runOnboard(deps(owner.transport, prompter([]).prompter), {
      mode: "setup",
      workspaceId: "default",
      step: "about",
      headless: { preset: "openrouter" },
    });
    expect(about.exit).toBe(0);
    expect(owner.actions()).not.toContain("onboarding:complete-step");
    expect(owner.actions()).not.toContain("workspace-settings:set");
  });
});

describe("the channel step", () => {
  const catalog = {
    channels: [
      {
        providerId: "telegram",
        label: "Telegram",
        setupHelp: "Open @BotFather and send /newbot.",
        settings: [],
        auth: { kind: "secrets", fields: [{ key: "token", label: "Bot token" }] },
      },
    ],
  };

  it("leaves Telegram out when the flow features other channels, naming their own command", async () => {
    const owner = scripted({ "channels:catalog": catalog });
    const flowStep = { id: "slack", kind: "channels" as const, title: "Message Tavi from Slack", body: "Pair in #tavi.", optional: true };
    const { context: step, written } = context(owner.transport, [], system(), { flowStep: { ...flowStep, featured: ["slack"] } });
    await channelsStep(step);
    expect(written()).toContain("○ Message Tavi from Slack — `tavi channels add slack`");
    expect(written()).not.toContain("Telegram");
    expect(owner.actions()).toEqual(["channels:catalog"]);
    const none = context(owner.transport, [], system(), { flowStep: { ...flowStep, featured: [] } });
    await channelsStep(none.context);
    expect(none.written()).toContain("none of the channels this setup offers is installed here");
  });

  it("adds Telegram, shows the bot's link and code, and binds only when the person says it is them", async () => {
    let polls = 0;
    const owner = scripted({
      "channels:catalog": catalog,
      "channels:save": { connectionId: "telegram" },
      "channels:probe": {
        ok: true,
        detail: "Bot @tavi_test_bot.",
        setup: { lines: ["Bot @tavi_test_bot."], link: { label: "Open the chat", url: "https://t.me/tavi_test_bot" } },
      },
      "channels:people": { people: [], operator: "alice" },
      "workspace-settings:get": { settings: { operatorName: "Alice" }, effective: { timezone: "UTC" } },
      "channels:pair": {
        pairingId: "11111111-1111-4111-8111-111111111111",
        code: "4KX9QM2P",
        expiresAt: "2026-10-20T10:10:00.000Z",
        account: "tavi_test_bot",
        openLabel: "Open in Telegram",
        linkUrl: "https://t.me/tavi_test_bot?start=4KX9-QM2P",
      },
      "channels:pairing": () =>
        (polls += 1) < 2 ? { state: "waiting" } : { state: "claimed", sender: "99887766", senderName: "Alice (@alice)" },
    });
    const { context: step, written } = context(owner.transport, ["y", "123:secret-token", "y"], system());
    await channelsStep(step);
    expect(written()).toContain("Message Tavi from Telegram?");
    expect(written()).toContain("Open @BotFather");
    expect(written()).toContain("Bot token (hidden)");
    expect(written()).toContain("Telegram connected: Bot @tavi_test_bot.");
    expect(written()).toContain("Send 4KX9-QM2P to @tavi_test_bot (https://t.me/tavi_test_bot) within 10 minutes");
    expect(written()).toContain("`/link 4KX9-QM2P`; Open in Telegram: https://t.me/tavi_test_bot?start=4KX9-QM2P");
    expect(written()).toContain("A message from Alice (@alice) (99887766) carried the code. Is this you?");
    expect(owner.actions()).toContain("channels:confirm-pair");
    expect(owner.sent.find((entry) => entry.payload["action"] === "pair")?.payload).toMatchObject({
      principalId: "alice",
      name: "Alice",
      connectionId: "telegram",
    });
    expect(owner.sent.find((entry) => entry.payload["action"] === "save")?.payload).toMatchObject({
      secrets: { token: "123:secret-token" },
    });
    expect(written()).not.toContain("secret-token");
  });

  it("does not bind when the person says no, and starts a new code once the old one is gone", async () => {
    const pairings: string[] = [];
    let state = 0;
    const owner = scripted({
      "channels:catalog": catalog,
      "channels:save": { connectionId: "telegram" },
      "channels:probe": { ok: true, detail: "Bot @b0t." },
      "channels:people": { people: [] },
      "workspace-settings:get": { settings: {}, effective: { timezone: "UTC" } },
      "channels:pair": () => {
        pairings.push("code");
        return { pairingId: "22222222-2222-4222-8222-222222222222", code: "AAAA-BBBB", expiresAt: "x" };
      },
      // A restarted owner forgot the first code; the second is claimed by someone else.
      "channels:pairing": () => ((state += 1) === 1 ? { state: "gone" } : { state: "claimed", sender: "Mallory" }),
    });
    const { context: step } = context(owner.transport, ["y", "tok", "y", "n"], system());
    await channelsStep(step);
    expect(pairings).toHaveLength(2);
    expect(owner.actions()).toContain("channels:cancel-pair");
    expect(owner.actions()).not.toContain("channels:confirm-pair");
  });

  it("ends the wait for an expired code and offers a new one", async () => {
    let pairs = 0;
    const owner = scripted({
      "channels:catalog": catalog,
      "channels:save": { connectionId: "telegram" },
      "channels:probe": { ok: true, detail: "Bot @b0t." },
      "channels:people": { people: [] },
      "workspace-settings:get": { settings: {}, effective: { timezone: "UTC" } },
      "channels:pair": () => {
        pairs += 1;
        return { pairingId: "33333333-3333-4333-8333-333333333333", code: "CCCC-DDDD", expiresAt: "x" };
      },
      "channels:pairing": { state: "expired" },
    });
    const { context: step, written } = context(owner.transport, ["y", "tok", "n"], system());
    await channelsStep(step);
    expect(pairs).toBe(1);
    expect(written()).toContain("The code is no longer valid. Get a new one?");
  });

  it("saves a retried token on the connection it made, and removes one a wrong token left", async () => {
    let probes = 0;
    const owner = scripted({
      "channels:catalog": catalog,
      "channels:list": { connections: [{ connectionId: "telegram-1", providerId: "telegram" }] },
      "channels:save": (payload: Record<string, unknown>) => ({
        connectionId: (payload["connectionId"] as string | undefined) ?? "telegram-new",
      }),
      "channels:probe": () => ((probes += 1) === 1 ? { ok: false, detail: "Unauthorized" } : { ok: true, detail: "Bot @b0t." }),
      "channels:people": { people: [] },
      "workspace-settings:get": { settings: {}, effective: { timezone: "UTC" } },
      "channels:pair": { pairingId: "44444444-4444-4444-8444-444444444444", code: "EEEE-FFFF", expiresAt: "x" },
      "channels:pairing": { state: "claimed", sender: "me" },
    });
    // A rerun: this flow made telegram-1 before; the first token is refused, the second works, both on telegram-1.
    const ours = {
      ...STATUS,
      steps: [...STATUS.steps, { kind: "channels" as const, state: "todo" as const, detail: "", createdRef: "telegram-1" }],
    };
    const { context: step } = context(owner.transport, ["y", "bad", "y", "good", "y"], system(), { status: ours });
    await channelsStep(step);
    expect(owner.sent.filter((entry) => entry.payload["action"] === "save").map((entry) => entry.payload["connectionId"])).toEqual([
      "telegram-1",
      "telegram-1",
    ]);
    expect(owner.actions()).not.toContain("channels:delete");
    // A fresh run whose token is refused removes the connection it just made.
    const fresh = scripted({
      "channels:catalog": catalog,
      "channels:list": { connections: [] },
      "channels:save": { connectionId: "telegram-9" },
      "channels:probe": { ok: false, detail: "Unauthorized" },
    });
    const { context: once } = context(fresh.transport, ["y", "bad", "n"], system());
    await channelsStep(once);
    expect(fresh.sent.find((entry) => entry.payload["action"] === "delete")?.payload).toMatchObject({ connectionId: "telegram-9" });
  });

  it("offers the channel a plugin installed in Telegram's place, in its own words", async () => {
    const owner = scripted({
      "channels:catalog": {
        channels: [
          {
            providerId: "mail",
            label: "Mail",
            settings: [{ key: "domain", label: "Domain", type: "string", required: true }],
            auth: { kind: "secrets", fields: [{ key: "apiKey", label: "API key" }] },
          },
          {
            providerId: "signal-bridge",
            label: "Signal",
            settings: [],
            auth: {
              kind: "secrets",
              fields: [
                { key: "number", label: "Phone number", help: "The bridge's number." },
                { key: "secret", label: "Bridge secret" },
              ],
            },
          },
        ],
      },
      "channels:list": { connections: [] },
      "channels:save": { connectionId: "signal-1" },
      "channels:probe": { ok: true },
      "channels:people": { people: [] },
      "workspace-settings:get": { settings: {}, effective: { timezone: "UTC" } },
      "channels:pair": { pairingId: "55555555-5555-4555-8555-555555555555", code: "GGGGHHHH", expiresAt: "x" },
      "channels:pairing": { state: "claimed", sender: "+15550100" },
    });
    const { context: step, written } = context(owner.transport, ["y", "+15550199", "s3cret", "y"], system());
    await channelsStep(step);
    expect(written()).toContain("Message Tavi from Signal?");
    expect(written()).toContain("Phone number: The bridge's number.");
    expect(written()).toContain("Bridge secret (hidden)");
    expect(written()).toContain("Signal connected");
    expect(written()).toContain("Send GGGG-HHHH to Tavi on Signal within 10 minutes");
    expect(written()).not.toContain("Telegram");
    expect(written()).not.toContain("t.me");
    expect(owner.sent.find((entry) => entry.payload["action"] === "save")?.payload).toMatchObject({
      providerId: "signal-bridge",
      secrets: { number: "+15550199", secret: "s3cret" },
    });
  });

  it("says pairing needs the owner when none runs, and writes nothing", async () => {
    const offline = scripted({}, false);
    const { context: step, written } = context(offline.transport, [], system());
    await channelsStep(step);
    expect(written()).toContain("pairing needs a running owner");
    expect(offline.sent).toEqual([]);
  });
});

describe("the service step", () => {
  it("says when a unit for another data folder is there already, rather than offering to write it as new", async () => {
    const owner = scripted({}, false);
    const sys = system();
    await sys.writeText("/home/test/Library/LaunchAgents/dev.tavi.serve.plist", "<plist>/data/another</plist>");
    const { context: step, written } = context(owner.transport, ["3"], sys);
    await serviceStep(step);
    expect(written()).toContain("a unit not written by this setup is at /home/test/Library/LaunchAgents/dev.tavi.serve.plist; it is kept");
  });

  it("on Windows sends the owner to WSL2 for now, and elsewhere says where units are for", async () => {
    for (const [platform, said] of [
      ["win32", "tavi serve does not run on Windows yet: keep the owner running under WSL2"],
      ["freebsd", "a service unit is for macOS, Linux and Windows"],
    ] as const) {
      const { context: step, written } = context(scripted({}, false).transport, [], system({ platform }));
      await serviceStep(step);
      expect(written()).toContain(said);
    }
  });

  it("writes a user-scope unit for this data directory and starts it on a second yes, with only the user-scope runner", async () => {
    const owner = scripted({}, false);
    const sys = system();
    const { context: step, written } = context(owner.transport, ["1", "y"], sys);
    await serviceStep(step);
    const place = unitPlace(sys, "dev.tavi.serve", 501);
    expect(place?.path).toBe("/home/test/Library/LaunchAgents/dev.tavi.serve.plist");
    expect(await sys.readText("/home/test/Library/LaunchAgents/dev.tavi.serve.plist")).toContain("/data/mine");
    expect(owner.sent.find((entry) => entry.payload["action"] === "created")?.payload).toMatchObject({
      step: "service",
      ref: "dev.tavi.serve",
    });
    expect(sys.runs).toHaveLength(1);
    expect(sys.runs[0]).toMatch(/^launchctl bootstrap gui\/\d+ \/home\/test\/Library\/LaunchAgents\/dev\.tavi\.serve\.plist$/u);
    expect(written()).toContain("✓ Started");
  });

  it("waits for the started service to answer, and says when it does not, or when another owner holds the directory", async () => {
    for (const [answers, said] of [
      [[undefined, undefined, true], "✓ Running as a service"],
      // A read that fails is no answer yet, never "another owner".
      [["throw", true], "✓ Running as a service"],
      [[false], "An owner answers, but not as the service"],
      [[], "no owner answered within 10 seconds"],
    ] as const) {
      const queue: (boolean | undefined | "throw")[] = [...answers];
      const sys = system({
        ownerIsService: async () => {
          const next = queue.shift();
          if (next === "throw") throw new Error("timed out");
          return next;
        },
      });
      const { context: step, written } = context(scripted({}, false).transport, ["1", "y"], sys);
      await serviceStep(step);
      expect(written()).toContain(said);
    }
  });

  it("never overwrites a unit it did not write, and never starts one beside a running owner", async () => {
    const sys = system({ platform: "linux" });
    await sys.writeText(
      "/home/test/.config/systemd/user/dev.tavi.serve.service",
      renderServiceUnit({
        kind: "systemd",
        nodePath: "/n",
        executablePath: "/e",
        dataDirectory: "/data/other",
        label: "dev.tavi.serve",
        systemd: { scope: "user" },
      }),
    );
    const { context: offline, written } = context(scripted({}, false).transport, ["1"], sys);
    await serviceStep(offline);
    expect(written()).toContain("already exists and is not one this setup wrote");
    expect(await sys.readText("/home/test/.config/systemd/user/dev.tavi.serve.service")).toContain("/data/other");

    const fresh = system({ platform: "linux" });
    const { context: attached, written: said } = context(scripted({}, true).transport, ["1"], fresh);
    await serviceStep(attached);
    expect(said()).toContain("Stop this tavi serve first");
    expect(said()).toContain("systemctl --user daemon-reload && systemctl --user enable --now dev.tavi.serve");
    expect(said()).toContain("loginctl enable-linger $USER");
    expect(fresh.runs).toEqual([]);
  });

  it("on WSL2 says what keeps the distribution running; on WSL1 writes no unit", async () => {
    // Said whichever way serve is kept running: here, "I run it myself".
    const wsl2 = system({ platform: "linux", wsl: 2 });
    const { context: step, written } = context(scripted({}, true).transport, ["2"], wsl2);
    await serviceStep(step);
    expect(written()).toContain("vmIdleTimeout=-1");
    expect(written()).toContain("instanceIdleTimeout=-1");

    const wsl1 = system({ platform: "linux", wsl: 1 });
    const { context: old, written: said } = context(scripted({}, true).transport, ["1"], wsl1);
    await serviceStep(old);
    expect(said()).toContain("WSL1 is not supported");
    expect(await wsl1.readText("/home/test/.config/systemd/user/dev.tavi.serve.service")).toBeUndefined();
  });

  it("removes only the unit this flow wrote, in tavi setup, after a yes", async () => {
    const sys = system();
    await sys.writeText(
      "/home/test/Library/LaunchAgents/dev.tavi.serve.plist",
      renderServiceUnit({ kind: "launchd", nodePath: "/n", executablePath: "/e", dataDirectory: "/data/mine", label: "dev.tavi.serve" }),
    );
    const ours = {
      ...STATUS,
      steps: [{ kind: "service" as const, state: "done" as const, detail: "Service installed", createdRef: "dev.tavi.serve" }],
    };
    const { context: step } = context(scripted({}, false).transport, ["2", "y"], sys, { mode: "setup", status: ours });
    await serviceStep(step);
    expect(await sys.readText("/home/test/Library/LaunchAgents/dev.tavi.serve.plist")).toBeUndefined();
    expect(sys.runs[0]).toMatch(/^launchctl bootout gui\/\d+\/dev\.tavi\.serve$/u);
  });

  it("marks the step self-managed for 'I run it myself'", async () => {
    const owner = scripted({}, false);
    const { context: step } = context(owner.transport, ["2"], system());
    await serviceStep(step);
    expect(owner.sent.find((entry) => entry.payload["action"] === "confirm-service")?.payload).toMatchObject({ mode: "self-managed" });
  });
});

describe("where tasks live", () => {
  const settingsWith = (tasksHome?: string) => ({
    workspaceId: "default",
    revision: 3,
    settings: tasksHome === undefined ? {} : { tasksHome },
    effective: { timezone: "UTC", tasksHome: tasksHome ?? "tavi" },
    hostTimezone: "UTC",
  });
  const withTasks = (items: NonNullable<OnboardingStatus["steps"][number]["items"]> = []): OnboardingStatus => ({
    ...STATUS,
    steps: [...STATUS.steps, { kind: "tasks", state: "todo", detail: "", ...(items.length === 0 ? {} : { items }) }],
    open: ["service", "tasks"],
  });
  const writes = (sent: readonly { readonly command: string; readonly payload: Record<string, unknown> }[]) =>
    sent.filter((entry) => entry.command === "workspace-settings" && entry.payload["action"] !== "get").map((entry) => entry.payload);

  it("keeps Tavi's own list with nothing saved, and marks the step done", async () => {
    const owner = scripted({ "workspace-settings:get": settingsWith() });
    const { context: step, written } = context(owner.transport, ["1"], system(), { status: withTasks() });
    await tasksStep(step);
    expect(writes(owner.sent)).toEqual([]);
    expect(owner.sent.find((entry) => entry.payload["action"] === "complete-step")?.payload).toMatchObject({ step: "tasks" });
    expect(written()).toContain("To-dos: Tavi's own list");
  });

  it("clears a task app saved before when Tavi's own list is chosen", async () => {
    const owner = scripted({ "workspace-settings:get": settingsWith("mcp:todoist") });
    const { context: step } = context(owner.transport, ["1"], system(), { status: withTasks() });
    await tasksStep(step);
    expect(writes(owner.sent)).toEqual([{ action: "unset", workspaceId: "default", key: "tasksHome", expectedRevision: 3 }]);
  });

  it("saves a connected task app as the home, mcp:<server>, without offering Todoist again", async () => {
    const owner = scripted({ "workspace-settings:get": settingsWith() });
    const { context: step, written } = context(owner.transport, ["2"], system(), {
      status: withTasks([{ id: "mcp:todoist", label: "Todoist", state: "connected" }]),
    });
    await tasksStep(step);
    expect(written()).not.toContain("connect it first");
    expect(writes(owner.sent)).toEqual([
      { action: "set", workspaceId: "default", key: "tasksHome", value: "mcp:todoist", expectedRevision: 3 },
    ]);
    expect(owner.actions()).not.toContain("onboarding:complete-step");
    expect(written()).toContain("To-dos go to Todoist");
  });

  it("points at the commands that connect Todoist, which signs in in a browser, and leaves the step open", async () => {
    const owner = scripted({ "workspace-settings:get": settingsWith() });
    const { context: step, written } = context(owner.transport, ["2"], system(), { status: withTasks() });
    await tasksStep(step);
    for (const line of TODOIST_CONNECT_COMMANDS) expect(written()).toContain(line);
    expect(written()).toContain("tavi mcp add todoist --preset todoist");
    expect(writes(owner.sent)).toEqual([]);
    expect(owner.actions()).not.toContain("onboarding:complete-step");
    expect(owner.actions()).not.toContain("onboarding:skip");
  });

  it("marks the step skipped on Not now", async () => {
    const owner = scripted({ "workspace-settings:get": settingsWith() });
    const { context: step } = context(owner.transport, ["3"], system(), { status: withTasks() });
    await tasksStep(step);
    expect(owner.sent.find((entry) => entry.payload["action"] === "skip")?.payload).toMatchObject({ step: "tasks" });
  });

  it("tavi setup tasks keeps Tavi's own list offline, and the checklist shows it done", async () => {
    const directory = directories.create("tavi-tasks-");
    const ran = await tavi(["setup", "tasks", "--data-dir", directory], ["1"]);
    expect(ran.out, ran.out + ran.err).toContain("To-dos: Tavi's own list");
    const status = JSON.parse((await tavi(["onboard", "status", "--json", "--data-dir", directory])).out) as OnboardingStatus;
    expect(status.steps.find((step) => step.kind === "tasks")).toMatchObject({ state: "done", detail: "Tavi's own list" });
    expect((await tavi(["config", "get", "tasks.home", "--data-dir", directory])).out).toContain("tavi");
  });
});

describe("the user-scope runner", () => {
  it("runs nothing but launchctl and systemctl --user", async () => {
    await expect(userScopeRunner("sudo", ["launchctl", "bootstrap"])).rejects.toThrow(/only launchctl or systemctl --user/u);
    await expect(userScopeRunner("sh", ["-c", "true"])).rejects.toThrow(/only launchctl or systemctl --user/u);
    await expect(userScopeRunner("systemctl", ["enable", "--now", "dev.tavi.serve"])).rejects.toThrow(/systemctl --user only/u);
  });
});

describe("first prompts", () => {
  it("offers the census's chips at once, refreshes Ideas only when they are on, and hands back the chosen prompt", async () => {
    const chips = { chips: [{ label: "Emails to answer", prompt: "Which emails need an answer from me today?" }] };
    const on = scripted({ "ideas:chips": chips, "ideas:settings": { settings: { enabled: true } } });
    const { context: step } = context(on.transport, ["1"], system());
    expect(await ideasStep(step)).toBe("Which emails need an answer from me today?");
    expect(on.actions()).toContain("ideas:refresh");

    const off = scripted({ "ideas:chips": { chips: [] }, "ideas:settings": { settings: { enabled: false } } });
    const { context: fallback } = context(off.transport, ["2"], system(), {
      flowStep: {
        id: "ideas",
        kind: "ideas",
        title: "Try",
        body: "Try.",
        optional: true,
        prompts: [
          { label: "Plan my week", prompt: "Plan it." },
          { label: "Research", prompt: "Research it." },
        ],
      },
    });
    expect(await ideasStep(fallback)).toBe("Research it.");
    expect(off.actions()).not.toContain("ideas:refresh");
    // None of it is a chat turn: the only ideas requests are reads and the refresh.
    expect(
      [...on.actions(), ...off.actions()].filter((action) => !["ideas:chips", "ideas:settings", "ideas:refresh"].includes(action)),
    ).toEqual([]);
  });

  it("offline starts no run and says personal ideas come once tavi serve runs", async () => {
    const offline = scripted({ "ideas:chips": { chips: [] }, "ideas:settings": { settings: { enabled: true } } }, false);
    const { context: step, written } = context(offline.transport, ["2"], system(), {
      flowStep: {
        id: "ideas",
        kind: "ideas",
        title: "Try",
        body: "Try.",
        optional: true,
        prompts: [{ label: "Plan my week", prompt: "Plan it." }],
      },
    });
    await ideasStep(step);
    expect(offline.actions()).not.toContain("ideas:refresh");
    expect(written()).toContain("Personal ideas start once `tavi serve` runs");
  });
});

// ------------------------------------------------------------------ through main

async function tavi(
  argv: readonly string[],
  lines: readonly string[] = [],
): Promise<{ readonly exit: number; readonly out: string; readonly err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), isTty: false };
  const input = new PassThrough();
  input.end(lines.map((line) => `${line}\n`).join(""));
  const exit = await main(argv, {
    io,
    onboard: {
      input,
      env: {},
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      sleep: async () => undefined,
    },
  });
  return { exit, out, err };
}

describe("about you", () => {
  it("saves the name in settings and as a preference, and a rerun corrects it with no conflict", async () => {
    const directory = directories.create("tavi-about-");
    const first = await tavi(["setup", "about", "--data-dir", directory], ["y", "Robin", "Europe/Lisbon"]);
    expect(first.out, first.out + first.err).toContain("✓ About you saved");
    expect(first.out).toContain("Tavi will remember: your name is Robin · you're in Europe/Lisbon");
    expect((await tavi(["config", "get", "operator.name", "--data-dir", directory])).out).toBe("operator.name = Robin (set)\n");
    expect((await tavi(["config", "get", "workspace.timezone", "--data-dir", directory])).out).toContain("Europe/Lisbon (set)");
    // `setup` asks "Change it?" of the done step; a yes goes straight to the fields.
    const again = await tavi(["setup", "about", "--data-dir", directory], ["y", "Robin Ellis", ""]);
    expect(again.out + again.err).not.toContain("MEMORY_CONFLICT");
    expect(again.out).toContain("✓ About you saved");
    const memory = await tavi(["memory", "list", "--data-dir", directory, "--format", "json"]);
    const records =
      (JSON.parse(memory.out) as { records?: { preferenceKey?: string; status: string }[] }).records ??
      (JSON.parse(memory.out) as { preferenceKey?: string; status: string }[]);
    expect(records.filter((record) => record.preferenceKey === "user.name" && record.status === "approved")).toHaveLength(1);
    const status = JSON.parse((await tavi(["onboard", "status", "--json", "--data-dir", directory])).out) as OnboardingStatus;
    expect(status.steps.find((step) => step.kind === "about")).toMatchObject({ state: "done", detail: "Robin Ellis" });
  });

  it("writes only the settings while memory is paused", async () => {
    const directory = directories.create("tavi-about-paused-");
    await tavi(["config", "set", "memory", '{"enabled":false}', "--data-dir", directory]);
    const saved = await tavi(["setup", "about", "--data-dir", directory], ["y", "Robin", ""]);
    expect(saved.out).not.toContain("Tavi will remember");
    const memory = await tavi(["memory", "list", "--data-dir", directory, "--format", "json"]);
    expect(memory.out).not.toContain("user.name");
  });
});

describe("headless setup", () => {
  it("sets about you from flags, reports what it ignored, and leaves the model required", async () => {
    const directory = directories.create("tavi-headless-");
    const run = await tavi([
      "setup",
      "--non-interactive",
      "--name",
      "Robin",
      "--timezone",
      "Europe/Lisbon",
      "--active-hours",
      "08:00-21:00",
      "--json",
      "--data-dir",
      directory,
    ]);
    const answer = JSON.parse(run.out) as { exit: number; missing?: string; ignored?: string[]; status: OnboardingStatus };
    expect(answer.exit).toBe(3);
    expect(answer.missing).toBe("--preset");
    expect(answer.ignored).toEqual(["--active-hours (the heartbeat is off)"]);
    expect(answer.status.steps.find((step) => step.kind === "about")?.state).toBe("done");
  });

  it("refuses a search kind that needs a key without --search-key-file, naming it", async () => {
    const directory = directories.create("tavi-headless-search-");
    const run = await tavi(["setup", "--non-interactive", "--search", "brave", "--json", "--data-dir", directory]);
    expect(JSON.parse(run.out)).toMatchObject({ exit: 3, missing: "--search-key-file" });
  });

  it("names the owner for a channel secret offline: a channel lives in the owner", async () => {
    const directory = directories.create("tavi-headless-telegram-");
    const token = join(directory, "token");
    writeFileSync(token, "123:abc", { mode: 0o600 });
    const run = await tavi([
      "setup",
      "--non-interactive",
      "--channel-secret",
      `telegram:token=${token}`,
      "--json",
      "--data-dir",
      directory,
    ]);
    expect(JSON.parse(run.out)).toMatchObject({
      next: "tavi serve",
      ignored: [expect.stringContaining("--channel-secret telegram:token")],
    });
  });
});

describe("tavi chat --draft", () => {
  it("parses a draft for a new chat, and refuses it with --attach", () => {
    expect(parseArgs(["chat", "--draft", "Plan my week"]).chat).toMatchObject({ draft: "Plan my week" });
    expect(() => parseArgs(["chat", "--draft", "x", "--attach", "t1"])).toThrow(/--draft starts a new chat/u);
  });

  it("puts the draft in the composer, sent only on Enter", async () => {
    const tty = fakeTty({ rows: 20, columns: 80 });
    const store = new ChatStore({ columns: () => 80, rows: () => 20, reservedRows: 2, prompting: true });
    const submitted: string[] = [];
    const instance = render(
      createElement(ChatApp, { store, draft: "Plan my week", onSubmit: (prompt: string) => void submitted.push(prompt) }),
      chatInkOptions(tty, () => undefined),
    );
    try {
      await delay(80);
      expect(stripVTControlCharacters(tty.output())).toContain("Plan my week");
      expect(submitted).toEqual([]);
      tty.type("\r");
      await delay(80);
      expect(submitted).toEqual(["Plan my week"]);
    } finally {
      const exited = instance.waitUntilExit();
      instance.unmount();
      await exited;
    }
  });
});
