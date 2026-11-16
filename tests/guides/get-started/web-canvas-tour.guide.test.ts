import { expect } from "vitest";

import { MODEL } from "../../../scripts/docs/session.mjs";
import { keyFile, walkGuide } from "../support/walk.js";

interface Checklist {
  readonly steps: readonly { readonly kind: string; readonly state: string }[];
}

walkGuide("get-started/web-canvas-tour", {
  configured: false,
  model: true,
  steps: {
    "open-the-canvas": async (walk) => {
      const page = await walk.open("/");
      await page.waitForURL(/\/welcome\/model$/);
      await page.getByRole("heading", { name: "Choose the model Tavi thinks with" }).first().waitFor();
      await walk.shot();
    },
    "connect-a-model": async (walk) => {
      const page = await walk.page();
      await page
        .getByRole("button", { name: /^OpenRouter/ })
        .first()
        .click();
      await page.getByRole("button", { name: "Sign in with OpenRouter" }).waitFor();
      await walk.shot();
      // The key the walk uses is real, so it is never typed into a page: the same connection is made from the key file.
      walk.unwalked("signing in or pasting the key: the walk connects OpenRouter with tavi setup --key-file instead");
      walk.tavi(
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
      );
      const checklist = JSON.parse(walk.tavi("onboard", "status", "--json")) as Checklist;
      expect(checklist.steps.find((step) => step.kind === "model")?.state).toBe("done");
    },
    "tell-tavi-about-you": async (walk) => {
      const page = await walk.open("/welcome/about");
      await page.getByLabel("Your name").fill("Alex");
      await expect(page.getByLabel("Your time zone").inputValue()).resolves.toBe("Europe/London");
      // Saving moves Welcome on to the next step: the picture shows the form as the reader fills it.
      await walk.shot();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForURL(/\/welcome\/tasks$/);
      expect(walk.tavi("config", "get", "operator.name").trim()).toContain("Alex");
    },
    "choose-where-you-keep-tasks": async (walk) => {
      const page = await walk.page();
      await walk.shot();
      await page.getByRole("button", { name: "Use Tavi’s list" }).click();
      await page.waitForURL(/\/welcome\/channels$/);
      // As the guide says, the phone is left for its own guide.
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page.waitForURL(/\/welcome\/search$/);
      const checklist = JSON.parse(walk.tavi("onboard", "status", "--json")) as Checklist;
      expect(checklist.steps.find((step) => step.kind === "tasks")?.state).toBe("done");
    },
    "turn-on-web-search": async (walk) => {
      const page = await walk.page();
      await page.getByLabel("Search provider").click();
      await page.getByRole("option", { name: "Tavily", exact: true }).click();
      await walk.shot();
      await page.getByRole("button", { name: "Add and test", exact: true }).click();
      // The walk's owner runs in a terminal, not as a service: Welcome lists that step next, done in a terminal.
      await page.waitForURL(/\/welcome\/service$/, { timeout: 30_000 });
      await page.getByText("Do this in a terminal:").waitFor();
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await page.waitForURL(/\/welcome\/ideas$/, { timeout: 30_000 });
      expect(walk.tavi("search", "list")).toMatch(/tavily/i);
    },
    "try-something": async (walk) => {
      const page = await walk.page();
      // The ideas offered depend on what is set up by now: the walk takes the first, as a reader might.
      await page
        .getByRole("button", { name: /^Try it: / })
        .first()
        .click();
      const composer = page.getByRole("textbox").last();
      await expect.poll(async () => (await composer.inputValue()).trim(), { timeout: 15_000 }).not.toBe("");
      await walk.shot();
    },
  },
});
