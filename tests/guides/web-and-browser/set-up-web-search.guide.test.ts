import { expect } from "vitest";

import { walkGuide } from "../support/walk.js";

interface Providers {
  readonly providers: readonly { readonly providerId: string; readonly credentialRef?: string; readonly enabled: boolean }[];
}

const providers = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Providers>("search", "list").providers;

walkGuide("web-and-browser/set-up-web-search", {
  configured: true,
  steps: {
    "start-with-tavily-no-key-needed": async (walk) => {
      // The walk's data directory starts with Tavily on its stored key: the reader starts with none.
      if (providers(walk).some((provider) => provider.providerId === "tavily")) walk.tavi("search", "remove", "tavily");
      const screen = await walk.terminal({
        title: "tavi search add tavily --kind tavily",
        args: ["search", "add", "tavily", "--kind", "tavily"],
      });
      expect(screen.join("\n")).toContain("tavily");
      const tavily = providers(walk).find((provider) => provider.providerId === "tavily");
      expect(tavily?.credentialRef).toBeUndefined();
      expect(tavily?.enabled).toBe(true);
    },
    "store-a-key-for-another-provider": async (walk) => {
      // The key comes from the walk's own key file, stored when its data directory was made: it is never typed or shown.
      walk.unwalked("storing the key: the walk's data directory already holds search.brave, read from .env.tutorials");
      const stored = walk.tavi("credentials", "list");
      if (!/\bsearch\.brave\b/.test(stored)) walk.needsUser("a Brave Search key in .env.tutorials (BRAVE_API_KEY)");
      const screen = await walk.terminal({ title: "tavi credentials list", args: ["credentials", "list"] });
      expect(screen.join("\n")).toContain("search.brave");
    },
    "add-the-provider-with-its-key": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi search add brave --kind brave --credential search.brave",
        args: ["search", "add", "brave", "--kind", "brave", "--credential", "search.brave"],
      });
      expect(screen.join("\n")).toContain("search.brave");
      expect(providers(walk).find((provider) => provider.providerId === "brave")?.credentialRef).toBe("search.brave");
    },
    "test-it": async (walk) => {
      const screen = await walk.terminal({
        title: 'tavi search test brave --query "Royal Observatory Greenwich"',
        args: ["search", "test", "brave", "--query", "Royal Observatory Greenwich"],
      });
      expect(screen.join("\n")).toMatch(/brave answered \d+ result/);
      expect(screen.join("\n")).toMatch(/https:\/\//);
    },
    "keep-one-provider-on": async (walk) => {
      walk.tavi("search", "disable", "tavily");
      const screen = await walk.terminal({ title: "tavi search list", args: ["search", "list"] });
      expect(screen.join("\n")).toMatch(/tavily.*disabled/);
      expect(
        providers(walk)
          .filter((provider) => provider.enabled)
          .map((provider) => provider.providerId),
      ).toEqual(["brave"]);
    },
    "check-them-in-the-canvas": async (walk) => {
      const page = await walk.open("/settings/search");
      await page.getByRole("heading", { name: "Web search" }).first().waitFor();
      await page.getByRole("button", { name: "Disable brave" }).waitFor();
      await page.getByRole("button", { name: "Enable tavily" }).waitFor();
      await walk.shot(page.locator("section.settings"));
    },
    "or-add-one-in-the-canvas": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Add provider" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Serper", { exact: true }).click();
      await expect(dialog.getByLabel("Name").inputValue()).resolves.toBe("serper");
      await dialog.getByText("Serper API key").waitFor();
      await walk.shot(dialog);
      // The walk never types a key into a page: it closes the form as it found it.
      walk.unwalked("pasting a key and saving: no key is typed into a page by a walk");
      await dialog.getByRole("button", { name: "Cancel" }).click();
    },
  },
});
