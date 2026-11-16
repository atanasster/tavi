import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { OnboardingStatus } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import type { OpenAiStubRequest } from "@tavi/test-support/openai-stub";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { offerFirstRun } from "../../src/features/onboard/first-run.js";
import type { CliIo } from "../../src/cli/io.js";
import type { OwnerModelTarget } from "../../src/features/run/owner.js";
import { serve } from "../../src/server/serve.js";
import { startOnboardingStub } from "../support/onboarding-stub.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `tavi onboard` and `tavi setup`, driven
 * in-process through `main` with scripted input on the plain line renderer:
 * no pseudo-terminal, nothing exec'd. The model is an OpenAI-compatible stub
 * on a free port that calls the probe tool for the key `good` and refuses any
 * other.
 */

const directories = temporaryDirectories();
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});

/** The key the stub accepts: distinctive, so a leak check finds it wherever it lands. */
const KEY = "sk-test-onboard-7f3a9c";

/** The onboarding stub, accepting only `KEY`; `chat.unknown` makes generation answer 404 for the model. */
async function stub(
  chat: { unknown: boolean } = { unknown: false },
): Promise<{ readonly baseUrl: string; readonly requests: readonly OpenAiStubRequest[] }> {
  const started = await startOnboardingStub(KEY, chat);
  cleanups.push(() => started.close());
  return started;
}

/** Nothing listens on the local presets' ports in a test: detection finds no server. */
const noLocalServer: typeof globalThis.fetch = async () => {
  throw new TypeError("fetch failed: connect ECONNREFUSED");
};

async function tavi(
  argv: readonly string[],
  lines: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): Promise<{ readonly exit: number; readonly out: string; readonly err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), isTty: false };
  const input = new PassThrough();
  input.end(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  const exit = await main(argv, { io, onboard: { input, env, fetch: noLocalServer, sleep: async () => undefined } });
  return { exit, out, err };
}

/** The answers that choose Custom at `baseUrl` (featured 4 + Another…, then Custom 7th), a key, then the first model. */
const custom = (baseUrl: string, key: string) => ["5", "7", baseUrl, key, "1"];
/** "Not now" to the steps after the model in `tavi onboard`: about you (n), where tasks live (3), keeping it running (3), a first idea (Enter). Channels need an owner offline. */
const REST = ["n", "3", "3", ""];

describe("end to end", () => {
  it("a fresh data directory, tavi setup --non-interactive against a stub, then a turn answered with no restart", async () => {
    const { baseUrl } = await stub();
    const directory = directories.create("tavi-onboard-");
    const keyFile = join(directory, "stub.key");
    writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    const setup = await tavi([
      "setup",
      "--non-interactive",
      "--preset",
      "custom",
      "--base-url",
      baseUrl,
      "--key-file",
      keyFile,
      "--model",
      "m1",
      "--json",
      "--data-dir",
      directory,
    ]);
    expect(setup.exit, setup.out + setup.err).toBe(0);
    expect(setup.out + setup.err).not.toContain(KEY);
    const status = JSON.parse((await tavi(["onboard", "status", "--json", "--data-dir", directory])).out) as OnboardingStatus;
    expect(status.steps.find((step) => step.kind === "model")?.state).toBe("done");
    const turn = await tavi(["run", "hello", "--data-dir", directory]);
    expect(turn.exit, turn.out + turn.err).toBe(0);
    expect(turn.out).toContain("Hello from the stub.");
  });

  it("refuses --base-url with a preset whose endpoint is fixed, and custom without one", async () => {
    const directory = directories.create("tavi-onboard-");
    const keyFile = join(directory, "stub.key");
    writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    const fixed = await tavi([
      "setup",
      "--non-interactive",
      "--preset",
      "openai",
      "--base-url",
      "https://example.test/v1",
      "--key-file",
      keyFile,
      "--json",
      "--data-dir",
      directory,
    ]);
    expect(fixed.exit).toBe(3);
    expect(fixed.out + fixed.err).toContain("--base-url goes with --preset custom");
    const bare = await tavi(["setup", "--non-interactive", "--preset", "custom", "--key-file", keyFile, "--json", "--data-dir", directory]);
    expect(bare.exit).toBe(3);
    expect(bare.out + bare.err).toContain("--base-url");
  });
});

describe("tavi onboard on a fresh store", () => {
  it("walks the model step end to end — custom endpoint, hidden key, discovery, verify — and exits 0", async () => {
    const { baseUrl, requests } = await stub();
    const directory = directories.create("tavi-onboard-");
    expect((await tavi(["onboard", "status", "--data-dir", directory])).exit).toBe(3);
    const run = await tavi(["onboard", "--data-dir", directory], [...custom(baseUrl, KEY), ...REST]);
    expect(run.exit, run.out + run.err).toBe(0);
    expect(run.out).toContain("✓ Inference ready: m1");
    expect(run.out).toContain("✓ Choose the model Tavi thinks with — Custom · m1 · verified");
    // The key reached the provider and was never written back.
    expect(requests.map((request) => request.key)).toContain(KEY);
    expect(run.out + run.err).not.toContain(KEY);
    const status = await tavi(["onboard", "status", "--json", "--data-dir", directory]);
    expect(status.exit).toBe(0);
    expect((JSON.parse(status.out) as OnboardingStatus).steps.find((step) => step.kind === "model")).toMatchObject({
      state: "done",
      createdRef: "custom",
    });
    // The funnel: each step asked about was reached once; "not now" to about you is its skip.
    const funnel = (JSON.parse(status.out) as OnboardingStatus).funnel;
    expect(funnel?.model?.reached).toBe(1);
    expect(funnel?.about).toMatchObject({ reached: 1, skipped: 1 });
  });

  it("never asks about the model again once it is done, only what is still open", async () => {
    const { baseUrl } = await stub();
    const directory = directories.create("tavi-onboard-");
    await tavi(["onboard", "--data-dir", directory], [...custom(baseUrl, KEY), ...REST]);
    const again = await tavi(["onboard", "--data-dir", directory], REST);
    expect(again.exit, again.out).toBe(0);
    expect(again.out).not.toContain("Which model provider?");
    expect(again.out).toContain("Tell Tavi your name and time zone?");
    // A done step `tavi onboard` passes over is not reached again; the second visit to about you is within the same five minutes.
    const funnel = (JSON.parse((await tavi(["onboard", "status", "--json", "--data-dir", directory])).out) as OnboardingStatus).funnel;
    expect(funnel?.model?.reached).toBe(1);
    expect(funnel?.about?.reached).toBe(1);
  });

  it("retries a refused key on the same connection: no second connection is made", async () => {
    const { baseUrl } = await stub();
    const directory = directories.create("tavi-onboard-");
    // A refused key fails discovery; another key is offered, and works.
    const run = await tavi(["onboard", "--data-dir", directory], ["5", "7", baseUrl, "wrong", "y", KEY, "1", ...REST]);
    expect(run.exit, run.out + run.err).toBe(0);
    expect(run.out).toContain("could not list its models");
    const models = await tavi(["models", "list", "--data-dir", directory]);
    expect(models.out).toContain("custom");
    expect(models.out).not.toContain("custom-2");
  });

  it("resumes on the same connection after a run stopped mid-step (Ctrl-C or the input ending)", async () => {
    const { baseUrl } = await stub();
    const directory = directories.create("tavi-onboard-");
    // Stopped at the model choice: the connection and its key are written, nothing verified.
    const stopped = await tavi(["onboard", "--data-dir", directory], ["5", "7", baseUrl, KEY]);
    expect(stopped.exit).toBe(130);
    expect(stopped.out).toContain("What was set up is kept");
    const resumed = await tavi(["onboard", "--data-dir", directory], [...custom(baseUrl, KEY), ...REST]);
    expect(resumed.exit, resumed.out + resumed.err).toBe(0);
    const models = await tavi(["models", "list", "--data-dir", directory]);
    expect(models.out).toContain("custom");
    expect(models.out).not.toContain("custom-2");
  });
});

describe("tavi setup", () => {
  it("refuses a --key-file that is not there as the flag's mistake (exit 2), in JSON under --json", async () => {
    const directory = directories.create("tavi-onboard-");
    const missing = join(directory, "no-such-key");
    const run = await tavi([
      "setup",
      "--non-interactive",
      "--preset",
      "anthropic",
      "--key-file",
      missing,
      "--json",
      "--data-dir",
      directory,
    ]);
    expect(run.exit).toBe(EXIT.usage);
    expect(JSON.parse(run.out)).toEqual({ ok: false, error: { code: "INVALID_INPUT", message: `--key-file ${missing}: no such file` } });
    const plain = await tavi(["setup", "--non-interactive", "--preset", "anthropic", "--key-file", missing, "--data-dir", directory]);
    expect(plain.exit).toBe(EXIT.usage);
    expect(plain.err).toBe(`tavi setup: --key-file ${missing}: no such file\n`);
  });

  it("shows the model that is set and keeps it on Enter", async () => {
    const { baseUrl } = await stub();
    const directory = directories.create("tavi-onboard-");
    await tavi(["onboard", "--data-dir", directory], [...custom(baseUrl, KEY), ...REST]);
    const kept = await tavi(["setup", "model", "--data-dir", directory], [""]);
    expect(kept.exit, kept.out).toBe(0);
    expect(kept.out).toContain("Model: Custom · m1 · verified");
    expect(kept.out).toContain("Change it? [y/N]");
    expect(kept.out).not.toContain("Which model provider?");
  });

  it("exits 3 headless without a key, naming --key-file, and never takes a key in argv", async () => {
    const directory = directories.create("tavi-onboard-");
    const missing = await tavi([
      "setup",
      "--non-interactive",
      "--preset",
      "openrouter",
      "--model",
      "m1",
      "--json",
      "--data-dir",
      directory,
    ]);
    expect(missing.exit).toBe(3);
    expect(JSON.parse(missing.out)).toMatchObject({ exit: 3, missing: "--key-file" });
    expect(missing.err).toContain("--key-file");
    expect((await tavi(["setup", "--key-file", "/tmp/k", "--data-dir", directory])).exit).toBe(2);
    expect((await tavi(["setup", "--non-interactive", "--key", "sk-or-v1-x", "--data-dir", directory])).exit).toBe(2);
  });
});

describe("tavi onboard status, reset and provider", () => {
  it("lists the checklist, the built-in flow, and resets skips only", async () => {
    const directory = directories.create("tavi-onboard-");
    const status = await tavi(["onboard", "status", "--data-dir", directory]);
    // The flow's own names, as Welcome and Home's card show them, and one count over the whole flow.
    expect(status.out).toMatch(/^Setup: 0 of \d+ done\n/);
    expect(status.out).toContain("○ Choose the model Tavi thinks with — No model is set up");
    // Where a step is done goes on a line of its own, under the step, so no row runs past a 100-column terminal.
    expect(status.out).toContain(
      "○ Web search — Web search is not set up\n  in tavi ui, or now with: tavi search add <id> --kind <kind>\n",
    );
    expect(Math.max(...status.out.split("\n").map((line) => line.length))).toBeLessThanOrEqual(100);
    expect(status.out).toContain("run tavi onboard");
    expect((await tavi(["onboard", "provider", "--data-dir", directory])).out).toContain("* tavi.onboarding (builtin)");
    expect((await tavi(["onboard", "reset", "--json", "--data-dir", directory])).out).toBe('{"cleared":0}\n');
    expect((await tavi(["onboard", "nonsense", "--data-dir", directory])).exit).toBe(2);
  });
});

describe("tavi onboard attached to a running owner", () => {
  it("writes through the owner, and an offline status afterwards reads the same store", async () => {
    const { baseUrl } = await stub();
    const directory = directories.create("tavi-onboard-");
    const placeholder: OwnerModelTarget = { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" };
    const handle = await serve(
      fixtureServeOptions(directory, {
        defaultConnectionId: "default",
        defaultModel: "default",
        modelTargetUnconfigured: true,
        liveModelTarget: {},
      }),
      { dataDirectory: directory, drainDeadlineMs: 5_000, modelTarget: placeholder },
      { stdout: () => {}, stderr: () => {}, isTty: false },
      { browserOverride: createFixtureBrowser() },
    );
    let stopped = false;
    cleanups.push(async () => {
      if (!stopped) await handle.shutdown("test cleanup");
    });
    // Attached, the channel step asks too: about you, channels, keeping it running, a first idea.
    const attached = await tavi(["onboard", "--data-dir", directory], [...custom(baseUrl, KEY), "n", "3", "n", "3", ""]);
    expect(attached.exit, attached.out + attached.err).toBe(0);
    expect(attached.out).toContain("✓ Inference ready: m1");
    await handle.shutdown("test done");
    stopped = true;
    const offline = await tavi(["onboard", "status", "--json", "--data-dir", directory]);
    expect((JSON.parse(offline.out) as OnboardingStatus).steps.find((step) => step.kind === "model")).toMatchObject({
      state: "done",
      createdRef: "custom",
    });
    // The key is in the credentials store only: in no log and no database file, its write-ahead log included.
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? (entry.name === "credentials" ? [] : files(join(dir, entry.name))) : [join(dir, entry.name)],
      );
    const leaked = files(directory).filter((path) => readFileSync(path).includes(KEY));
    expect(leaked).toEqual([]);
  });
});

describe("a model that fails verify", () => {
  it("is left configured with the advice on the checklist, and the run exits 3", async () => {
    const { baseUrl } = await stub({ unknown: true });
    const directory = directories.create("tavi-onboard-");
    const run = await tavi(["onboard", "--data-dir", directory], [...custom(baseUrl, KEY), "3", ...REST]);
    expect(run.exit, run.out + run.err).toBe(3);
    expect(run.out).toContain("✗ The model m1 failed: This account can't use m1. Pick another.");
    const status = JSON.parse((await tavi(["onboard", "status", "--json", "--data-dir", directory])).out) as OnboardingStatus;
    expect(status.steps.find((step) => step.kind === "model")).toMatchObject({
      state: "todo",
      detail: expect.stringContaining("can't use m1"),
    });
  });

  it("never replaces the working default in tavi setup: the change goes beside it until it passes", async () => {
    const chat = { unknown: false };
    const { baseUrl } = await stub(chat);
    const directory = directories.create("tavi-onboard-");
    expect((await tavi(["onboard", "--data-dir", directory], [...custom(baseUrl, KEY), ...REST])).exit).toBe(0);
    chat.unknown = true;
    const changed = await tavi(["setup", "model", "--data-dir", directory], ["y", ...custom(baseUrl, KEY), "3"]);
    expect(changed.out).toContain("Your previous model is still the default.");
    expect(changed.out).toContain(
      "A connection or key named custom is already there (in use, or added outside setup), so this one is added beside it as custom-2",
    );
    const status = JSON.parse((await tavi(["onboard", "status", "--json", "--data-dir", directory])).out) as OnboardingStatus;
    expect(status.steps.find((step) => step.kind === "model")).toMatchObject({ state: "done", detail: "Custom · m1 · verified" });
    const models = await tavi(["models", "list", "--data-dir", directory]);
    expect(models.out).toContain("custom-2");
  });
});

describe("the first-run offer", () => {
  async function atTerminal(
    argv: readonly string[],
    lines: readonly string[],
  ): Promise<{ readonly exit: number; readonly out: string; readonly err: string }> {
    let out = "";
    let err = "";
    const input = new PassThrough();
    input.end(lines.map((line) => `${line}\n`).join(""));
    const exit = await main(argv, {
      io: { stdout: (text) => void (out += text), stderr: (text) => void (err += text), isTty: true },
      onboard: { input, env: { TERM: "dumb" }, fetch: noLocalServer },
    });
    return { exit, out, err };
  }

  it("asks at a terminal on a first run; no runs the command as it was, Ctrl-C stops it", async () => {
    const directory = directories.create("tavi-onboard-");
    const declined = await atTerminal(["run", "hello", "--data-dir", directory], ["n"]);
    expect(declined.out).toContain("No model is set up. Run tavi onboard now (about 2 minutes)? [Y/n]");
    expect(declined.exit).toBe(2);
    expect(declined.err).toContain("run `tavi onboard`");
    expect((await atTerminal(["run", "hello", "--data-dir", directory], [])).exit).toBe(130);
  });

  it("never asks under TAVI_SERVICE=1 or once a model is set up", async () => {
    const fresh = directories.create("tavi-onboard-");
    const service = await (async () => {
      let out = "";
      const input = new PassThrough();
      input.end("");
      const exit = await main(["run", "hello", "--data-dir", fresh], {
        io: { stdout: (text) => void (out += text), stderr: () => {}, isTty: true },
        onboard: { input, env: { TERM: "dumb", TAVI_SERVICE: "1" }, fetch: noLocalServer },
      });
      return { exit, out };
    })();
    expect(service.out).not.toContain("No model is set up");
    expect(service.exit).toBe(2);
    const { baseUrl } = await stub();
    const directory = directories.create("tavi-onboard-");
    await tavi(["onboard", "--data-dir", directory], [...custom(baseUrl, KEY), ...REST]);
    // No input: an offer would end as cancelled (130) before the task ran.
    const ran = await atTerminal(["run", "hello", "--data-dir", directory], []);
    expect(ran.out).not.toContain("No model is set up");
    expect(ran.exit).not.toBe(130);
  });
});

describe("serve's first run", () => {
  it("asks nothing, says where setup is, then lets serve start; says nothing under TAVI_SERVICE=1", async () => {
    let out = "";
    const io: CliIo = { stdout: (text) => void (out += text), stderr: () => {}, isTty: true };
    // No input stream: a prompt here would wait on stdin and never settle.
    const stopped = await offerFirstRun(directories.create("tavi-onboard-"), io, { env: { TERM: "dumb" } }, "serve");
    expect(stopped).toBeUndefined();
    expect(out).toBe("No model is set up yet: run `tavi chat` or `tavi ui` (or `tavi onboard`) to set one up.\n");
    let quiet = "";
    const service = await offerFirstRun(
      directories.create("tavi-onboard-"),
      { stdout: (text) => void (quiet += text), stderr: () => {}, isTty: true },
      { env: { TAVI_SERVICE: "1" } },
      "serve",
    );
    expect(service).toBeUndefined();
    expect(quiet).toBe("");
  });
});

describe("tavi onboard import", () => {
  const home = "/home/elsewhere";
  const importFiles = {
    home,
    env: {},
    readText: async (path: string) =>
      path === `${home}/.hermes/.env`
        ? "OPENROUTER_API_KEY=sk-or-imported\n"
        : path === `${home}/.hermes/config.yaml`
          ? "model:\n  provider: openrouter\n  default: anthropic/claude-sonnet-4.5\n"
          : undefined,
  };
  const run = async (argv: readonly string[], answers: readonly string[] = []) => {
    let out = "";
    let err = "";
    const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), isTty: false };
    const input = new PassThrough();
    input.end(answers.map((line) => `${line}\n`).join(""));
    const exit = await main(argv, { io, onboard: { input, env: {}, fetch: noLocalServer, sleep: async () => undefined, importFiles } });
    return { exit, out, err };
  };

  it("says what a dry run would import, by name and place, and changes nothing", async () => {
    const directory = directories.create("tavi-onboard-");
    const dry = await run(["onboard", "import", "--dry-run", "--data-dir", directory]);
    expect(dry.exit).toBe(0);
    expect(dry.out).toContain("Hermes (~/.hermes):");
    expect(dry.out).toContain(
      "✓ openrouter → OpenRouter, anthropic/claude-sonnet-4.5 (its default); key: OPENROUTER_API_KEY in ~/.hermes/.env",
    );
    expect(dry.out).toContain("Dry run: nothing was changed.");
    expect(dry.out).not.toContain("sk-or-imported");
    const json = JSON.parse((await run(["onboard", "import", "--dry-run", "--json", "--data-dir", directory])).out) as {
      found: { connections: unknown[] }[];
    };
    expect(json.found[0]?.connections).toHaveLength(1);
    expect(JSON.stringify(json)).not.toContain("sk-or-imported");
    // Still a first run: nothing was written.
    expect((await tavi(["onboard", "status", "--data-dir", directory])).exit).toBe(3);
  });

  it("copies the key with --with-secrets and answers JSON without it", async () => {
    const directory = directories.create("tavi-onboard-");
    const imported = await run(["onboard", "import", "--with-secrets", "--json", "--data-dir", directory]);
    expect(imported.out).not.toContain("sk-or-imported");
    expect(`${imported.out}${imported.err}`).not.toContain("sk-or-imported");
    const answer = JSON.parse(imported.out) as { imported: { connected?: string[]; withoutKey?: string[] }[] };
    // The key went to Tavi's store (the connection's own discover may fail offline, which the line says).
    expect(answer.imported[0]?.withoutKey ?? []).toEqual([]);
  });

  it("copies no key unasked and none is said, and says when nothing is installed", async () => {
    const directory = directories.create("tavi-onboard-");
    const declined = await run(["onboard", "import", "--data-dir", directory], ["n"]);
    expect(declined.out).toContain("Copy these keys into Tavi's credentials file (0600)? [y/N]");
    expect(declined.out).toContain("○ openrouter: its key was not copied; add it with tavi setup model.");
    expect(`${declined.out}${declined.err}`).not.toContain("sk-or-imported");
    let out = "";
    await main(["onboard", "import", "--data-dir", directory], {
      io: { stdout: (text) => void (out += text), stderr: () => undefined, isTty: false },
      onboard: { env: {}, importFiles: { home, env: {}, readText: async () => undefined } },
    });
    expect(out).toBe("No OpenClaw or Hermes install was found.\n");
  });
});
