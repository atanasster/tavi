// The documentation's screenshots of the web canvas, for
// scripts/docs/capture-ui.mjs. Each shot names the file it writes
// (docs/assets/screens/<name>.png), the route it opens, and optionally:
// `dark` (also <name>-dark.png), `model` (needs --model: a real model run),
// `fresh` (a data directory with nothing set up, for Welcome),
// `prepare(page, name)` (what to do on the page before the picture), `viewport`,
// `settle` (milliseconds to wait before it). Shots run in order on one page,
// so a model shot can build on the chat the one before it left. A `terminal`
// shot runs a tavi command (`tty: true` under a pseudo-terminal) and draws
// what it printed; with `record`, it first runs those `tavi run` arguments on
// the session's owner with `--format json`, and `{recording}` in its own args
// is the file that wrote.

import { join } from "node:path";

import { missed, root } from "./browser.mjs";

/** What the configured data directory is given before any shot, as tavi commands. */
export const SEED = [
  ["config", "set", "workspace.timezone", "Europe/London"],
  ["config", "set", "operator.name", "Alex"],
  ["search", "add", "tavily", "--kind", "tavily"],
  ["reminders", "add", "Take the bins out", "--repeat", "19:30"],
  ["reminders", "add", "Call the dentist about the crown", "--repeat", "09:15"],
  [
    "schedules",
    "add",
    "--name",
    "morning-news",
    "--at",
    "07:00",
    "--timezone",
    "Europe/London",
    "--prompt",
    "Summarise the three most important tech headlines for me.",
    "--allow",
    "web_search",
    "--deliver-to",
    "home",
  ],
  ["todos", "add", "Renew the car insurance", "--due", "2026-11-12"],
  ["todos", "add", "Book flights for the December trip"],
  ["todos", "add", "Send Maya the photos from Saturday"],
  ["memory", "remember", "--body", "I am vegetarian and allergic to peanuts."],
  ["memory", "remember", "--body", "My partner's name is Sam; our anniversary is 14 June."],
  ["memory", "remember", "--body", "I work from the Shoreditch office on Tuesdays and Thursdays."],
  ["heartbeat", "on"],
  // An installed plugin waiting for review, so Plugins shows one: the repository's example, found from this file.
  ["plugins", "install", join(root, "examples/plugins/acme-units")],
];

const pause = (page, ms) => page.waitForTimeout(ms);

/** Dismisses the setup checklist a new install shows over Home, once it has loaded (it may take a while on a busy owner). */
let dismissed = false;
async function dismissChecklist(page, name) {
  // The owner keeps a dismissal: once done, no later shot waits for the card again.
  if (dismissed) return;
  const heading = page.getByRole("heading", { name: /Setup checklist/ });
  const shown = await heading.waitFor({ timeout: 20_000 }).then(
    () => true,
    () => false,
  );
  if (!shown) return;
  await page.getByRole("button", { name: "Dismiss", exact: true }).filter({ visible: true }).first().click();
  await heading.waitFor({ state: "detached", timeout: 5_000 }).then(
    () => {
      dismissed = true;
    },
    () => missed(`${name}: the setup checklist stayed`),
  );
}

/** Clicks a button by its name when it shows within a few seconds; for a shot that needs it (`shot`), says when it never did. */
async function press(page, name, shot) {
  const button = page.getByRole("button", { name, exact: true }).first();
  await button.waitFor({ state: "visible", timeout: 3_000 }).then(
    () => button.click(),
    () => (shot === undefined ? undefined : missed(`${shot}: no ${name} button`)),
  );
}

/** Sends a prompt from the composer and waits until the turn has stopped, or `until` shows. */
async function ask(page, name, text, until) {
  await dismissChecklist(page, name);
  const box = page.getByRole("textbox").last();
  await box.fill(text);
  await box.press("Enter");
  // The composer's button reads Stop while the turn runs.
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const started = await stop.waitFor({ timeout: 15_000 }).then(
    () => true,
    () => false,
  );
  if (until !== undefined) {
    await page
      .getByText(until)
      .first()
      .waitFor({ timeout: 180_000 })
      .catch(() => missed(`${name}: no ${String(until)} on the page`));
  } else if (!started) missed(`${name}: the turn never started`);
  else await stop.waitFor({ state: "detached", timeout: 180_000 }).catch(() => missed(`${name}: the turn did not finish`));
  await pause(page, 800);
}

/** Opens one of the chat's views (Transcript, Trajectory, Held files, Agents), its nav's buttons. */
async function view(page, name, label) {
  const button = page.locator('nav[aria-label="chat views"]').getByRole("button", { name: label, exact: true });
  await button.waitFor({ timeout: 10_000 }).then(
    () => button.click(),
    () => missed(`${name}: no ${label} view`),
  );
  await pause(page, 1500);
}

/** In a new chat, sends a prompt and answers each approval it asks with Allow once, until the turn ends. */
async function askAllowing(page, name, text) {
  await dismissChecklist(page, name);
  // "New side chat" while Home is on, "New chat" otherwise.
  const fresh = page.getByRole("button", { name: /^New (side )?chat$/ }).first();
  await fresh.waitFor({ timeout: 5_000 }).then(
    () => fresh.click(),
    () => missed(`${name}: no New chat button`),
  );
  const box = page.getByRole("textbox").last();
  await box.fill(text);
  await box.press("Enter");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const allow = page.locator("main").getByRole("button", { name: "Allow once", exact: true }).first();
  const until = Date.now() + 240_000;
  let started = false;
  while (Date.now() < until) {
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => undefined);
    if (await stop.isVisible().catch(() => false)) started = true;
    else if (started) break;
    await pause(page, 1000);
  }
  if (!started) missed(`${name}: the turn never started`);
  else if (Date.now() >= until) missed(`${name}: the turn did not finish`);
  await pause(page, 800);
}

export const SHOTS = [
  {
    name: "chat-empty",
    route: "/",
    dark: true,
    prepare: (page, name) => dismissChecklist(page, name),
  },
  { name: "center-schedule", route: "/center/schedule" },
  { name: "center-heartbeat", route: "/center/heartbeat" },
  { name: "center-memory", route: "/center/identity" },
  { name: "settings-general", route: "/settings/general" },
  { name: "settings-models", route: "/settings/models" },
  { name: "settings-search", route: "/settings/search" },
  { name: "settings-apps", route: "/settings/apps" },
  { name: "settings-permissions", route: "/settings/permissions" },
  {
    name: "settings-plugins",
    route: "/settings/plugins",
    // The seeded plugin's folder is in this run's throwaway directory: shown as a usual data directory's instead.
    prepare: (page) =>
      page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
          node.textContent = node.textContent.replace(/\S*[\\/]tavi-docs-[^\\/\s]+[\\/]/g, "~/Library/Application Support/tavi/");
      }),
  },
  { name: "settings-system-prompt", route: "/settings/system-prompt" },
  { name: "settings-credentials", route: "/settings/credentials" },
  { name: "settings-ideas", route: "/settings/ideas" },
  { name: "settings-discover", route: "/settings/apps/discover" },
  {
    name: "chat-phone",
    route: "/",
    viewport: { width: 390, height: 844 },
    prepare: async (page, name) => {
      await dismissChecklist(page, name);
      // The page must fit the phone: anything wider than the screen is a layout bug.
      const wide = await page.evaluate(() => {
        // A child of a box that scrolls or clips sideways on purpose is not the page overflowing.
        const clipped = (element) => {
          for (let parent = element.parentElement; parent !== null; parent = parent.parentElement)
            if (getComputedStyle(parent).overflowX !== "visible") return true;
          return false;
        };
        const sideways = document.documentElement.scrollWidth > window.innerWidth ? ["the page scrolls sideways"] : [];
        const elements = [...document.querySelectorAll("body *")]
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1 && !clipped(element))
          .slice(0, 8)
          .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`);
        return [...sideways, ...elements];
      });
      if (wide.length > 0) missed(`${name}: wider than the screen: ${wide.join(", ")}`);
    },
  },
  {
    name: "keyboard",
    route: "/",
    prepare: async (page, name) => {
      await dismissChecklist(page, name);
      await page.keyboard.press("ControlOrMeta+/");
      await pause(page, 400);
    },
  },

  // A real model run, in Home: an answer, then a browser request that asks first.
  {
    name: "chat-answer",
    route: "/",
    model: true,
    dark: true,
    // Tall enough to keep the question above the answer in view.
    viewport: { width: 1280, height: 960 },
    prepare: (page, name) => ask(page, name, "Suggest a quick vegetarian dinner I could cook tonight, in three short bullet points."),
  },
  {
    name: "chat-approval",
    route: "/",
    model: true,
    dark: true,
    prepare: (page, name) =>
      ask(page, name, "Open bbcgoodfood.com in the browser and find a recipe like that.", /Allow (once|for this chat|until tomorrow)/),
  },
  { name: "center-approvals", route: "/center/approvals", model: true },
  // The approval above, allowed: the browser opens, and the chat panel's strip shows it live.
  {
    name: "chat-browser",
    route: "/",
    model: true,
    prepare: async (page, name) => {
      const allow = page.locator(".round").getByRole("button", { name: "Allow once", exact: true }).first();
      await allow.waitFor({ timeout: 15_000 }).then(
        () => allow.click(),
        () => missed(`${name}: no approval to allow`),
      );
      await press(page, "Show this chat's panel", name);
      await page
        .locator('aside[aria-label="this chat"] iframe')
        .first()
        .waitFor({ timeout: 90_000 })
        .catch(() => missed(`${name}: no live browser view in the panel`));
      // Frames arrive a few a second: let the page draw.
      await pause(page, 6000);
    },
  },
  { name: "center-activity", route: "/center/activity", model: true },
  // The browser chat's trajectory: each turn's model attempts and tool calls, timed.
  {
    name: "chat-trajectory",
    route: "/",
    model: true,
    prepare: async (page, name) => {
      await view(page, name, "Trajectory");
      // Each turn opened, its model attempts and tool calls shown.
      await page.locator("main details").evaluateAll((all) => {
        for (const details of all) details.open = true;
      });
      await pause(page, 800);
    },
  },
  // A chat that hands work to a sub-agent, named so a model takes it.
  {
    name: "chat-agents",
    route: "/",
    model: true,
    prepare: async (page, name) => {
      await askAllowing(
        page,
        name,
        "Call the agents.spawn tool once: ask a sub-agent to list three vegetarian pasta dishes, one line each. Then give me its answer.",
      );
      await view(page, name, "Agents");
    },
  },
  // A routine, created from Schedule and run once: Run now opens the run's inspector.
  {
    name: "routine-run",
    route: "/center/schedule",
    model: true,
    viewport: { width: 1280, height: 960 },
    prepare: async (page, name) => {
      await press(page, "New routine", name);
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("Weekend cooking");
      await dialog.getByLabel("Objective").fill("Find three seasonal vegetarian recipes worth cooking this weekend.");
      await dialog.getByRole("button", { name: "Save routine" }).click();
      await dialog.waitFor({ state: "detached", timeout: 120_000 }).catch(() => missed(`${name}: the routine was not created`));
      // The owner evaluates the routine's models before it can run: Run now is enabled once that passes.
      const run = page.getByRole("button", { name: "Run now", exact: true }).first();
      await run.waitFor({ timeout: 120_000 }).catch(() => missed(`${name}: no Run now`));
      for (let tries = 0; tries < 90 && (await run.isDisabled().catch(() => true)); tries++) await pause(page, 2000);
      if (await run.isDisabled().catch(() => true)) return missed(`${name}: Run now never enabled`);
      await run.click();
      // The inspector opens on the run, its status the badge in its "Run …" heading: wait until it is no longer live.
      const status = page.locator("h2.page-title", { hasText: /^Run / }).locator(".badge");
      await status.waitFor({ timeout: 30_000 }).catch(() => missed(`${name}: the run's inspector did not open`));
      let last = "";
      for (let tries = 0; tries < 100; tries++) {
        last = (await status.textContent().catch(() => "")) ?? "";
        if (last !== "" && !/queued|running|interrupted/.test(last)) break;
        await pause(page, 3000);
        await press(page, "Refresh run");
      }
      // The docs show a run that published its report (degraded only marks its caveats); a failed one is a different picture.
      if (!/succeeded|degraded/.test(last)) missed(`${name}: the run ended ${last || "with no status"}, without a report`);
      await pause(page, 1500);
    },
  },
  {
    name: "ideas",
    route: "/ideas",
    model: true,
    prepare: async (page) => {
      await press(page, "Refresh");
      await page
        .getByText("No ideas yet.")
        .waitFor({ state: "detached", timeout: 120_000 })
        .catch(() => undefined);
      await pause(page, 1500);
    },
  },

  {
    name: "ideas-tune",
    route: "/ideas",
    model: true,
    prepare: async (page, name) => {
      await press(page, "Tune", name);
      await page
        .getByRole("textbox")
        .first()
        .waitFor({ timeout: 5_000 })
        .catch(() => missed(`${name}: no brief box`));
    },
  },

  // The terminal: real output of the seeded directory, and two recorded turns replayed as `tavi chat` draws them.
  { name: "agenda", terminal: { title: "tavi schedules agenda", args: ["schedules", "agenda"], cols: 170, lines: 8 } },
  { name: "todos", terminal: { title: "tavi todos list", args: ["todos", "list"], cols: 120 } },
  {
    name: "chat-round",
    terminal: { title: "tavi chat", tty: true, args: ["chat", "--replay", "packages/client/test/fixtures/two-call-round.ndjson"] },
  },
  // A real turn, recorded on this run's owner and replayed: a browser request the owner denies, and what the model does then.
  {
    name: "chat-denied",
    model: true,
    terminal: {
      title: "tavi chat",
      tty: true,
      record: ["run", "Open bbcgoodfood.com in the browser and find a quick vegetarian pasta recipe.", "--approval", "deny"],
      args: ["chat", "--replay", "{recording}"],
      // The refusal and what the model does about it; the rest of its answer is not the point.
      lines: 9,
    },
  },
  {
    name: "chat-question",
    terminal: { title: "tavi chat", tty: true, args: ["chat", "--replay", "packages/client/test/fixtures/waiting-question.ndjson"] },
  },

  // A new install, before a model is chosen.
  { name: "welcome", route: "/welcome/model", fresh: true, dark: true },
  // A key the provider refuses: the step says so and keeps the form. The key is a made-up value, never a real one;
  // Verify does reach openrouter.ai, so this shot needs the network, with or without --model.
  {
    name: "welcome-refused",
    route: "/welcome/model",
    fresh: true,
    prepare: async (page, name) => {
      await page
        .getByRole("button", { name: /^OpenRouter/ })
        .first()
        .click();
      await press(page, "Paste a key instead", name);
      await page.getByLabel("OpenRouter key").fill("sk-or-v1-0000-not-a-real-key");
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      // The key is kept for the step; Verify is where the provider is asked, and refuses it.
      const verify = page.getByRole("button", { name: "Verify", exact: true });
      await verify.waitFor({ timeout: 20_000 }).then(
        () => verify.click(),
        () => missed(`${name}: no Verify`),
      );
      // Only a refused key offers Change the key: a network error or rate limit is a different picture.
      await page
        .getByRole("button", { name: "Change the key", exact: true })
        .waitFor({ timeout: 60_000 })
        .catch(() => missed(`${name}: the key was not refused as a bad key`));
      await pause(page, 800);
    },
  },
];
