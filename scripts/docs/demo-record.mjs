#!/usr/bin/env node
// Records the raw scenes of the README / YouTube demo video from a real Tavi:
//
//   node scripts/docs/demo-record.mjs [--out <dir>] [--api-key-file <path>] [--only terminal,canvas,phone]
//
// Like capture-ui.mjs, it starts from a new, empty data directory seeded
// through the CLI (scripts/docs/shots.mjs's SEED), starts its own `tavi serve`
// and `tavi ui`, and talks to OpenRouter with the key in --api-key-file (by
// default the `openrouter` credential of your own data directory), stored only
// in the throwaway directory. Nothing in it is staged: every answer is the
// model's, every approval the owner's.
//
// Each scene is recorded as the browser's own screencast, one JPEG per frame
// the page drew, with its time (sharper text than a video encoder's), into
// <out>/<scene>/ with a manifest.json that also holds the captions and the
// pauses the edit keeps. scripts/docs/demo-edit.mjs cuts them into the video.
//
//   terminal  `tavi chat` under a pseudo-terminal, drawn live by xterm.js
//   canvas    the web canvas at 1080p: a question, an approval, the live browser, the Center
//   phone     the same Home chat in a phone-sized canvas
//
// Build first (`pnpm run build`). The terminal scene loads xterm.js from
// jsdelivr, so the run needs the network (it needs it for the model anyway).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { launchBrowser, missed, root } from "./browser.mjs";
import { cleanUp, cleanUpOnSignals, cli, defaultKeyFile, env, keyFileProblem, openSession, settled, withDataDir } from "./session.mjs";
import { SEED } from "./shots.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const out = flag("--out") ?? join(root, ".demo-recording");
const keyFile = flag("--api-key-file") ?? defaultKeyFile();
const only = flag("--only")?.split(",") ?? ["terminal", "canvas", "phone"];

if (!existsSync(cli)) {
  console.error("apps/cli/dist is missing: run pnpm run build first");
  process.exit(2);
}
const keyProblem = keyFileProblem(keyFile);
if (keyProblem !== undefined) {
  console.error(keyProblem);
  process.exit(2);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The page's screencast into `dir`: a JPEG per frame Chromium drew, with its
 * time. `caption(text)` starts a caption from now; `hold(ms)` asks the edit to
 * keep the frame on screen now for at least `ms` (a reading pause); every
 * other still stretch is shortened in the edit, so a model's think time does
 * not become dead air. `fast(true)` … `fast(false)` marks a wait the edit
 * plays sped up, with a badge saying so (a spinner redraws the page, so its
 * frames are never still). `stop()` writes manifest.json.
 */
async function record(page, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const marks = [];
  let count = 0;
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = `${String(count++).padStart(6, "0")}.jpg`;
    writeFileSync(join(dir, file), Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  const viewport = page.viewportSize();
  const scale = await page.evaluate(() => window.devicePixelRatio);
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: Math.round(viewport.width * scale),
    maxHeight: Math.round(viewport.height * scale),
    everyNthFrame: 1,
  });
  const now = () => Date.now() / 1000;
  let fast = false;
  return {
    caption: (text) => marks.push({ caption: text, t: now() }),
    fast: (on) => {
      if (on !== fast) marks.push({ fast: on, t: now() });
      fast = on;
    },
    hold: async (ms) => {
      marks.push({ hold: ms, t: now() });
      await pause(400);
    },
    stop: async () => {
      if (fast) marks.push({ fast: false, t: now() });
      await pause(600);
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ frames, marks, end: now() }, null, 2)}\n`);
      if (frames.length < 2) missed(`${dir}: the screencast drew ${frames.length} frame(s)`);
      console.log(`${dir}: ${frames.length} frames`);
    },
  };
}

/** Types `text` into the focused field a key at a time, as a person would. */
const typeSlowly = (page, text) => page.keyboard.type(text, { delay: 38 });

/** Dismisses the setup checklist a new install shows over Home, when it shows. */
async function dismissChecklist(page) {
  const heading = page.getByRole("heading", { name: /Setup checklist/ });
  if (
    await heading.waitFor({ timeout: 15_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await page.getByRole("button", { name: "Dismiss", exact: true }).filter({ visible: true }).first().click();
    await heading.waitFor({ state: "detached", timeout: 5_000 }).catch(() => missed("the setup checklist stayed"));
  }
}

/**
 * Types `text` into the composer and sends it, then waits for the turn to end,
 * played sped up in the edit (`rec.fast`), answering each approval with Allow
 * once; `onApproval`, when given, handles the first one itself (it gets the
 * button), at normal speed. The turn has ended
 * once neither Stop nor an approval has shown for three seconds: a turn
 * waiting on an approval shows no Stop.
 */
async function ask(page, rec, name, text, onApproval) {
  const box = page.getByRole("textbox").last();
  await box.click();
  await typeSlowly(page, text);
  await pause(300);
  await box.press("Enter");
  rec.fast(true);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const allow = page.getByRole("button", { name: "Allow once", exact: true }).filter({ visible: true }).first();
  const until = Date.now() + 300_000;
  let started = false;
  let approvals = 0;
  let quietSince;
  while (Date.now() < until) {
    if (await allow.isVisible().catch(() => false)) {
      approvals += 1;
      if (onApproval !== undefined && approvals === 1) {
        // The first approval is the scene's moment: at its own speed.
        rec.fast(false);
        await onApproval(allow);
        rec.fast(true);
      } else {
        // Any later one is part of the wait, clicked as soon as it shows; a card still re-rendering is tried again.
        await allow.click({ timeout: 3_000 }).catch(() => undefined);
      }
      quietSince = undefined;
      continue;
    }
    if (await stop.isVisible().catch(() => false)) {
      started = true;
      quietSince = undefined;
    } else if (started) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince > 3_000) break;
    }
    await pause(400);
  }
  rec.fast(false);
  if (!started) missed(`${name}: the turn never started`);
  else if (Date.now() >= until) missed(`${name}: the turn did not finish`);
  await pause(600);
}

// ---------------------------------------------------------------------------
// The terminal: `tavi chat` on a pseudo-terminal, its bytes drawn as they come.

const TERM = { cols: 92, rows: 25 };

const terminalPage = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<style>
  html, body { margin: 0; height: 100%; background: #0f1a16; }
  body { display: grid; place-items: center; font-family: -apple-system, system-ui, sans-serif; }
  .window { background: #121f1a; border-radius: 14px; box-shadow: 0 30px 80px rgba(0,0,0,.45); overflow: hidden; border: 1px solid #22332c; }
  .bar { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #18271f; color: #9fb7ac; font-size: 14px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { flex: 1; text-align: center; margin-right: 52px; }
  #term { padding: 16px 18px 18px; }
</style></head><body>
<div class="window"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">tavi — zsh</span></div><div id="term"></div></div>
<script>
  window.term = new Terminal({
    cols: ${TERM.cols}, rows: ${TERM.rows}, fontSize: 21, lineHeight: 1.15,
    fontFamily: 'Menlo, "DejaVu Sans Mono", monospace', cursorBlink: false, allowProposedApi: true,
    theme: { background: "#121f1a", foreground: "#e3ece7", cursor: "#e9a62b", selectionBackground: "#2c4a3e",
      green: "#5fcf9f", brightGreen: "#7fe0b6", yellow: "#e9a62b", brightYellow: "#f2c063", blue: "#6fb3e0", cyan: "#62c6c0" },
  });
  term.open(document.getElementById("term"));
</script></body></html>`;

/** `tavi chat` on a pseudo-terminal through script(1), its transcript file, and a way to type into it. */
function startChat(dataDir, transcript) {
  const quote = (arg) => `'${arg.replace(/'/g, `'\\''`)}'`;
  const command = [process.execPath, cli, ...withDataDir(["chat"], dataDir)].map(quote).join(" ");
  const inner = `stty cols ${TERM.cols} rows ${TERM.rows}; exec ${command}`;
  const scriptArgs =
    process.platform === "linux" ? ["-q", "-f", "-e", "-c", inner, transcript] : ["-q", "-F", transcript, "sh", "-c", inner];
  const child = spawn("sh", ["-c", `cat | exec script ${scriptArgs.map(quote).join(" ")}`], {
    env: { ...env, TERM: "xterm-256color", FORCE_COLOR: "1", COLORTERM: "truecolor" },
    cwd: root,
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stdin.on("error", () => undefined);
  return child;
}

async function terminalScene(browser, session) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
  const page = await context.newPage();
  await page.setContent(terminalPage, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.term !== undefined);
  const rec = await record(page, join(out, "terminal"));
  const write = (text) => page.evaluate((chunk) => new Promise((done) => window.term.write(chunk, done)), text);

  rec.caption("In your terminal: tavi chat");
  await write("\x1b[38;2;95;207;159m~\x1b[0m \x1b[38;2;233;166;43m❯\x1b[0m ");
  await pause(700);
  for (const key of "tavi chat") {
    await write(key);
    await pause(70);
  }
  await pause(400);
  await write("\r\n");

  const transcript = join(out, "terminal.transcript");
  rmSync(transcript, { force: true });
  const child = startChat(session.dataDir, transcript);
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let seen = "";
  let lastChange = Date.now();
  const pump = async () => {
    if (!existsSync(transcript)) return;
    const size = statSync(transcript).size;
    if (size <= offset) return;
    const bytes = readFileSync(transcript).subarray(offset, size);
    offset = size;
    const text = decoder.write(bytes);
    seen += text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
    lastChange = Date.now();
    await write(text);
  };
  const waitFor = async (pattern, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await pump();
      if (pattern.test(seen)) return true;
      await pause(40);
    }
    return false;
  };

  // The chat's prompt is up once it has drawn and gone quiet.
  await waitFor(/./, 30_000);
  while (Date.now() - lastChange < 1_500) {
    await pump();
    await pause(40);
  }
  const before = seen.length;
  for (const key of "What's on my plate today? Check my to-dos and reminders.") {
    child.stdin.write(key);
    await pause(45);
    await pump();
  }
  await pause(400);
  child.stdin.write("\r");
  rec.caption("Same tools, same memory, one agent");
  rec.fast(true);
  // Until the run has started, its answer has come after it, and the screen has been still for three seconds; an
  // approval is answered once, at normal speed.
  const deadline = Date.now() + 240_000;
  let allowed = false;
  while (Date.now() < deadline) {
    await pump();
    const sent = seen.slice(before);
    if (!allowed && /\[y\/s\/a\/N\]/.test(sent)) {
      rec.fast(false);
      await pause(1_500);
      child.stdin.write("y");
      allowed = true;
      rec.fast(true);
    }
    const run = sent.lastIndexOf("running task");
    const answer =
      run === -1
        ? ""
        : sent
            .slice(run)
            .replace(/^[^\n]*\n/, "")
            .replace(/[❯\s█]/g, "");
    if (answer.length > 80 && Date.now() - lastChange > 3_000) break;
    await pause(60);
  }
  rec.fast(false);
  if (Date.now() >= deadline) missed("terminal: the chat's answer never came");
  await rec.hold(4_000);
  child.stdin.write("\x03");
  await pause(800);
  await pump();
  await rec.stop();
  child.kill("SIGTERM");
  spawnSync("pkill", ["-TERM", "-f", transcript]);
  await context.close();
}

// ---------------------------------------------------------------------------
// The web canvas, at 1920×1080.

/**
 * Opens a page the way a person would, by its link or tab named `name`, so the
 * recording shows no blank page between them; a full load of `route` when none shows.
 */
async function open(page, name, route) {
  const target = page
    .getByRole("link", { name, exact: typeof name === "string" })
    .or(page.getByRole("button", { name, exact: typeof name === "string" }));
  const shown = target.filter({ visible: true }).first();
  if (await shown.isVisible().catch(() => false)) {
    await shown.click({ timeout: 3_000 }).catch(() => undefined);
    await pause(900);
    if (new URL(page.url()).pathname.startsWith(route)) return;
  }
  await page.goto(new URL(route, page.url()).href);
}

async function canvasScene(browser, session) {
  const { page, context } = await session.openUi(browser, { width: 1280, height: 720 }, 1.5);
  await settled(page, "canvas");
  await dismissChecklist(page);
  await pause(1_000);
  const rec = await record(page, join(out, "canvas"));

  rec.caption("In your browser: tavi ui");
  await pause(1_200);
  await ask(page, rec, "canvas: dinner", "Suggest a quick dinner I could cook tonight, in three short bullet points.");
  rec.caption("It answers with what it remembers about you");
  await rec.hold(4_500);

  await ask(page, rec, "canvas: browse", "Open bbcgoodfood.com in the browser and find a recipe like that.", async (allow) => {
    rec.caption("Anything risky stops and asks you first");
    await allow.scrollIntoViewIfNeeded().catch(() => undefined);
    await rec.hold(3_000);
    await allow.click().catch(() => undefined);
    rec.caption("…then you watch it work, live");
    const panel = page.getByRole("button", { name: "Show this chat's panel", exact: true }).first();
    if (await panel.isVisible().catch(() => false)) await panel.click().catch(() => undefined);
    // A few seconds of the live browser at its own speed, before the rest of the turn is sped up.
    await pause(7_000);
    return true;
  });
  await rec.hold(4_000);

  rec.caption("Schedules and routines keep going while you're away");
  await open(page, "Center", "/center");
  await open(page, "Schedule", "/center/schedule");
  await settled(page, "canvas: schedule");
  await rec.hold(3_000);
  rec.caption("Everything it knows stays in one folder on your machine");
  await open(page, /^Soul (&|and) memory$/, "/center/identity");
  await settled(page, "canvas: memory");
  await rec.hold(3_000);
  await rec.stop();
  await context.close();
}

// ---------------------------------------------------------------------------
// The same Home, phone-sized.

async function phoneScene(browser, session) {
  const { page, context } = await session.openUi(browser, { width: 390, height: 844 }, 2);
  await settled(page, "phone");
  await dismissChecklist(page);
  await pause(1_000);
  const rec = await record(page, join(out, "phone"));
  rec.caption("On your phone: the same chat, the same agent");
  await rec.hold(2_500);
  await ask(page, rec, "phone: reminder", "Remind me to buy the ingredients at 17:30 today.");
  rec.caption("Also on Telegram, email and Discord");
  await rec.hold(4_000);
  await rec.stop();
  await context.close();
}

// ---------------------------------------------------------------------------

cleanUpOnSignals();
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
try {
  const session = await openSession({ configured: true, withModel: true, keyFile, searchKeys: join(root, ".env.tutorials"), seed: SEED });
  if (only.includes("terminal")) await terminalScene(browser, session);
  if (only.includes("canvas")) await canvasScene(browser, session);
  if (only.includes("phone")) await phoneScene(browser, session);
  console.log(`scenes in ${out}; cut them with: node scripts/docs/demo-edit.mjs --in ${out}`);
} finally {
  await browser.close();
  await cleanUp();
}
