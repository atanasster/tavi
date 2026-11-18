// What the documentation's capture scripts share: a throwaway data directory
// with its own `tavi serve` (and `tavi ui`) on free ports, the CLI run against
// it, a terminal shot drawn from what a command printed, and the clean-up that
// stops and deletes all of it however a run ends. scripts/docs/capture-ui.mjs
// (the reference docs' screenshots) and the how-to guide walks in tests/guides/
// both drive Tavi through this module, so there is one capture pipeline.
//
// A configured session talks to OpenRouter with the key in a plain-text file
// (by default the `openrouter` credential of your own data directory). The key
// is stored, from that file, in the throwaway directory's own credential store
// (0600, never the OS keychain), which is deleted when the run ends; it is never
// printed, logged or written into the repository.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { missed, root } from "./browser.mjs";
import { screenOf } from "./terminal-svg.mjs";

export const cli = join(root, "apps/cli/dist/executable.mjs");

/** The model every capture uses: one pinned main model and one fast one, on OpenRouter; `sight` drives acting by sight. */
export const MODEL = {
  connection: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  main: "google/gemini-3.8-flash",
  fast: "anthropic/claude-haiku-5.5",
  sight: "anthropic/claude-sonnet-5.5",
};

/** Your own data directory, found as the CLI finds it: TAVI_DATA_DIR, an absolute XDG_DATA_HOME, then the platform's. */
function userDataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  return (
    (process.env.TAVI_DATA_DIR || undefined) ??
    (xdg !== undefined && isAbsolute(xdg)
      ? join(xdg, "tavi")
      : platform() === "darwin"
        ? join(homedir(), "Library/Application Support/tavi")
        : join(homedir(), ".local/share/tavi"))
  );
}

/** The default key file: the `openrouter` credential of your own data directory. */
export const defaultKeyFile = () => join(userDataDir(), "credentials/openrouter");

/** Why `keyFile` cannot give a throwaway store its key, or undefined when it can. */
export function keyFileProblem(keyFile) {
  if (!existsSync(keyFile)) return `no key file at ${keyFile}: pass --api-key-file <path>`;
  // A data directory whose credentials are encrypted at rest holds ciphertext, which a throwaway store cannot read.
  if (readFileSync(keyFile, "utf8").startsWith("tavi-enc:")) {
    return `${keyFile} is encrypted at rest: pass --api-key-file <path> with the plain key, in a 0600 file`;
  }
  return undefined;
}

/** The children's environment: none of the caller's TAVI_* settings (a data directory no one can create instead), no key in the OS keychain, and a fixed zone. */
export const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_")));
env["TAVI_CREDENTIAL_KEYCHAIN"] = "off";
// A command that misses `--data-dir` fails on a folder no one can create (one under a file, on every platform), never falls back to the reader's own data.
env["TAVI_DATA_DIR"] = join(process.execPath, "tavi-docs-walk-without-data-dir");
// The owner's zone is the browser's, so a picture does not change with the machine that takes it.
env["TZ"] = "Europe/London";
env["LANG"] = "en_US.UTF-8";

/** `arg` as one word of a `sh -c` line. */
const shellQuote = (arg) => `'${arg.replace(/'/g, `'\\''`)}'`;

/** What a run must stop and delete however it ends. */
const live = { children: new Set(), directories: new Set() };

/** Stops every child this module started and deletes every directory it made. */
export async function cleanUp() {
  await Promise.all(
    [...live.children].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve(undefined);
          const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("exit", () => {
            clearTimeout(force);
            resolve(undefined);
          });
          child.kill("SIGTERM");
        }),
    ),
  );
  live.children.clear();
  for (const directory of live.directories) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.warn(`could not delete ${directory}: ${error.message}; delete it by hand`);
    }
  }
  live.directories.clear();
}

/** Ctrl-C and SIGTERM clean up before the process exits. */
export function cleanUpOnSignals() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void cleanUp().finally(() => process.exit(130));
    });
  }
}

/** A new, empty directory in the system's temporary folder, deleted by `cleanUp`. */
function scratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  live.directories.add(directory);
  return directory;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** `rest` with `--data-dir <dataDir>` added before any `--`: what follows `--` goes to another program, so a flag
 * added after it would leave tavi on the default (real) data dir. */
export function withDataDir(rest, dataDir) {
  const end = rest.indexOf("--");
  return end === -1 ? [...rest, "--data-dir", dataDir] : [...rest.slice(0, end), "--data-dir", dataDir, ...rest.slice(end)];
}

/** `tavi <rest> --data-dir <dataDir>`, returning what it printed; throws when it exits non-zero. */
function tavi(dataDir, ...rest) {
  if (process.env["TAVI_DOCS_DEBUG"] === "1") console.error(`tavi ${rest.join(" ")}`);
  return execFileSync(process.execPath, [cli, ...withDataDir(rest, dataDir)], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

/** A long-running tavi command, with a promise of the first match of `ready` in what it prints. */
function start(dataDir, rest, ready) {
  const child = spawn(process.execPath, [cli, ...withDataDir(rest, dataDir)], { env, stdio: ["ignore", "pipe", "pipe"] });
  live.children.add(child);
  child.once("exit", () => live.children.delete(child));
  let seen = "";
  const matched = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tavi ${rest[0]} did not start: ${seen.slice(-400)}`)), 60_000);
    child.stdout.on("data", (chunk) => {
      seen += chunk;
      const hit = ready.exec(seen);
      if (hit !== null) {
        clearTimeout(timer);
        resolve(hit);
      }
    });
    child.stderr.on("data", (chunk) => {
      seen += chunk;
    });
    child.on("exit", (code) => reject(new Error(`tavi ${rest[0]} exited ${code}: ${seen.slice(-400)}`)));
  });
  return { child, matched };
}

/**
 * Until no "Loading…" text a reader can see is left on the page, for at most
 * 20 seconds: a screen reader's off-screen live region does not count. A
 * wait that misses is reported through `miss` (by default `missed`).
 */
export async function settled(page, name, miss = missed) {
  await page
    .waitForFunction(
      () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (!/^\s*Loading\b/i.test(node.textContent ?? "")) continue;
          const box = node.parentElement?.getBoundingClientRect();
          if (box !== undefined && box.width > 1 && box.height > 1 && box.bottom > 0 && box.right > 0) return false;
        }
        return true;
      },
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => miss(`${name}: the page was still loading`));
}

/**
 * What a command printed, as the lines of a `cols`-wide terminal (the first
 * `lines` of them). `spec` is `{ args, tty?, record?, input?, cols?, lines? }`:
 * `tty` runs it under a pseudo-terminal (for the terminal UI); `record` first
 * runs those `tavi run` arguments on the session's owner with `--format json`,
 * and `{recording}` in `args` is the file that wrote; `input` is typed into the
 * pseudo-terminal a step at a time, as `typeInto` says. `redact` rewrites the
 * transcript before it is drawn (paths a picture must not show); a run or
 * command that printed nothing is reported through `miss` (by default `missed`).
 */
export async function terminalLines(dataDir, spec, name = "terminal", redact = (text) => text, miss = missed) {
  const cols = spec.cols ?? 100;
  // The run may end on a refusal, which is what it records, so its exit status is not checked.
  let args = spec.args;
  if (spec.record !== undefined) {
    const recording = join(scratch("tavi-docs-record-"), "turn.ndjson");
    const ran = spawnSync(process.execPath, [cli, ...withDataDir([...spec.record, "--format", "json"], dataDir)], {
      encoding: "utf8",
      env,
      cwd: root,
      timeout: 240_000,
    });
    if (ran.stdout.trim() === "") miss(`${name}: the recorded run printed nothing`);
    writeFileSync(recording, ran.stdout);
    args = args.map((arg) => (arg === "{recording}" ? recording : arg));
  }
  let transcript;
  if (spec.tty === true) {
    if (platform() === "win32") {
      miss(`${name}: a terminal picture is drawn through script(1) and stty, which Windows does not have: take it on macOS or Linux`);
      return [];
    }
    const file = join(scratch("tavi-docs-tty-"), "transcript");
    const quoted = withDataDir(args, dataDir).map(shellQuote).join(" ");
    const inner = `stty cols ${cols} rows 32; exec ${shellQuote(process.execPath)} ${shellQuote(cli)} ${quoted}`;
    const linux = platform() === "linux";
    // Each write flushed to the transcript as it comes (-f / -F), so a wait for a short line sees it at once.
    const scriptArgs = linux ? ["-q", "-f", "-e", "-c", inner, file] : ["-q", "-F", file, "sh", "-c", inner];
    const ttyEnv = { ...env, TERM: "xterm-256color", FORCE_COLOR: "1", ...(linux ? { SHELL: "/bin/sh" } : {}) };
    if (spec.input === undefined) {
      execFileSync("script", scriptArgs, { env: ttyEnv, cwd: root, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
    } else {
      await typeInto(scriptArgs, ttyEnv, file, spec.input, name, miss);
    }
    transcript = readFileSync(file, "utf8");
  } else {
    transcript = tavi(dataDir, ...args).replace(/\n/g, "\r\n");
  }
  const lines = screenOf(redact(transcript), cols, 200).slice(0, spec.lines ?? 200);
  if (lines.length === 0) miss(`${name}: the command printed nothing`);
  return lines;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the transcript shows so far, without its escape sequences. */
const shown = (file) => (existsSync(file) ? readFileSync(file, "utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "") : "");

/**
 * Runs `script` and types `steps` into the command on its pseudo-terminal, as a
 * person would: each step `{ text?, wait?, until? }` waits `wait` seconds (1 by
 * default), or, with `until` (a regular expression), until the transcript shows
 * it, for at most `wait` seconds (60 by default), and then types `text`. A step
 * whose `until` never shows ends the typing, and is reported through `miss`
 * once the command has been stopped. A second after the last
 * step, the command is stopped (so `script` writes out its transcript and ends),
 * and a `script` still there is killed; the clean-up stops it too.
 */
async function typeInto(scriptArgs, ttyEnv, file, steps, name, miss) {
  // `script` refuses input that is a socket (what Node hands a child) or, on macOS, a named pipe: `cat` passes the
  // keys on through an anonymous pipe, the one kind it takes.
  const child = spawn("sh", ["-c", `cat | exec script ${scriptArgs.map(shellQuote).join(" ")}`], {
    env: ttyEnv,
    cwd: root,
    stdio: ["pipe", "ignore", "pipe"],
  });
  live.children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ended = new Promise((resolve) => child.once("exit", resolve));
  child.once("exit", () => live.children.delete(child));
  child.stdin.on("error", () => undefined);
  // A step that misses is reported once the command is stopped: reporting may throw, and nothing may outlive it.
  let missedStep;
  for (const step of steps) {
    if (step.until === undefined) {
      await pause(Math.max(0, step.wait ?? 1) * 1_000);
    } else {
      const deadline = Date.now() + (step.wait ?? 60) * 1_000;
      const pattern = new RegExp(step.until);
      while (!pattern.test(shown(file)) && Date.now() < deadline && child.exitCode === null) await pause(500);
      if (!pattern.test(shown(file))) {
        missedStep = `${name}: the screen never showed ${pattern}`;
        break;
      }
    }
    if (child.exitCode !== null) break;
    if (step.text !== undefined && step.text !== "") child.stdin.write(step.text);
  }
  await pause(1_000);
  if (child.exitCode === null) {
    // The command runs under `script`, which runs under `sh`: stopping the command lets `script` end by itself.
    const scriptPid = spawnSync("pgrep", ["-P", String(child.pid), "script"], { encoding: "utf8" }).stdout.trim();
    if (scriptPid !== "") spawnSync("pkill", ["-TERM", "-P", scriptPid]);
    const stopped = await Promise.race([ended.then(() => true), pause(5_000).then(() => false)]);
    if (!stopped) {
      if (scriptPid !== "") spawnSync("kill", ["-KILL", scriptPid]);
      child.kill("SIGKILL");
      await ended;
    }
  }
  child.stdin.end();
  if (missedStep !== undefined) miss(missedStep);
  if (!existsSync(file)) throw new Error(`${name}: script wrote no transcript: ${stderr.trim()}`);
}

/** The search providers a walk can be given keys for, by the variable that holds each key in a `searchKeys` file. */
const SEARCH_KEYS = [
  { variable: "TAVILY_API_KEY", kind: "tavily" },
  { variable: "BRAVE_API_KEY", kind: "brave" },
  { variable: "SERPER_API_KEY", kind: "serper" },
];

/**
 * The keys in a `KEY=value` file (such as the gitignored `.env.tutorials`): each
 * one found goes into the data directory's credential store as `search.<kind>`,
 * written through a 0600 scratch file so it never reaches an argument, the
 * environment or a log. Returns the providers whose key was stored.
 */
function storeSearchKeys(run, file) {
  if (file === undefined || !existsSync(file)) return [];
  const values = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null) values.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  const stored = [];
  for (const { variable, kind } of SEARCH_KEYS) {
    const value = values.get(variable);
    if (value === undefined || value === "") continue;
    const keyFile = join(scratch("tavi-docs-key-"), "key");
    writeFileSync(keyFile, value, { mode: 0o600 });
    run("credentials", "set", `search.${kind}`, "--file", keyFile);
    stored.push(kind);
  }
  return stored;
}

/**
 * One throwaway data directory and its owner: `configured` gives it the model
 * connection (with `keyFile` when `withModel`), the search keys in `searchKeys`
 * (a `KEY=value` file; Tavily is then added with its key) and runs `seed` (tavi
 * argument lists) once the owner is up; `serve` adds flags to the owner's
 * `tavi serve` (`--browser-allow-host 127.0.0.1:<port>`, `--fs-root`); `main` is the main model in place of
 * `MODEL.main`, for a walk whose feature needs another kind of model. Returns the directory, a `tavi` bound to it, and
 * `openUi(browser, viewport, deviceScaleFactor)`, which starts `tavi ui` on a free port and signs a
 * new browser context in through its one-time link.
 */
export async function openSession({
  configured,
  withModel = false,
  keyFile = defaultKeyFile(),
  searchKeys,
  seed = [],
  serve = [],
  main = MODEL.main,
}) {
  const dataDir = scratch("tavi-docs-");
  const run = (...rest) => tavi(dataDir, ...rest);
  if (configured) {
    // With a model, the key goes into this throwaway directory's credential store, read from the file; it is never printed.
    if (withModel) run("credentials", "set", MODEL.connection, "--file", keyFile);
    run("models", "add", MODEL.connection, "--base-url", MODEL.baseUrl, "--model", main, "--credential", MODEL.connection);
    run("models", "set-default", "--connection", MODEL.connection, "--model", main);
    run("models", "set-role", "fast", "--connection", MODEL.connection, "--model", MODEL.fast);
  }
  const searchKinds = configured ? storeSearchKeys(run, searchKeys) : [];
  const owner = start(
    dataDir,
    [...(configured ? ["serve", "--connection", MODEL.connection, "--model", main] : ["serve"]), ...serve],
    /"serving": true/,
  );
  await owner.matched;
  if (searchKinds.includes("tavily")) run("search", "add", "tavily", "--kind", "tavily", "--credential", "search.tavily");
  for (const command of configured ? seed : []) {
    try {
      run(...command);
    } catch (error) {
      missed(
        `seed: tavi ${command.join(" ")}: ${
          String(error.stderr ?? error)
            .trim()
            .split("\n")[0]
        }`,
      );
    }
  }
  async function openUi(browser, viewport = { width: 1280, height: 800 }, deviceScaleFactor = 1) {
    const port = await freePort();
    // The link ends its line: read only once the whole token has arrived.
    const ui = start(dataDir, ["ui", "--print-url", "--port", String(port)], /(http:\/\/127\.0\.0\.1:\d+\/\S*#\S+)\r?\n/);
    const [, link] = await ui.matched;
    const context = await browser.newContext({ viewport, deviceScaleFactor, locale: "en-GB", timezoneId: "Europe/London" });
    const page = await context.newPage();
    // A link signs in once; the session cookie it leaves serves every page after it.
    await page.goto(link);
    return { context, page, link };
  }
  return { dataDir, tavi: run, openUi };
}
