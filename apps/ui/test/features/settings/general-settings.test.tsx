// @vitest-environment jsdom
import { DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS, parseNoThumbnailHosts, type WorkspaceSettingsAnswer } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { GeneralSettings } from "../../../src/features/settings/GeneralSettings.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, clickSettled as click, mountSettled as mount, settle, unmountAll } from "../../support/dom.js";

/**
 * Settings → General's task summaries:
 * on by default, the switch writes `activitySummaries`, and the model choice
 * defaults to the fast role's model, else each task's own.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the owner has in effect for `settings`: an older owner (`older`) answers only the timezone. */
const effectiveOf = (settings: WorkspaceSettingsAnswer["settings"], older: boolean): WorkspaceSettingsAnswer["effective"] =>
  older
    ? { timezone: "UTC" }
    : {
        timezone: "UTC",
        activitySummaries: settings.activitySummaries !== false,
        browserNoThumbnailHosts: [...(settings.browserNoThumbnailHosts ?? DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS)],
        travelFlightSearch: settings.travelFlightSearch !== false,
        travelGoogleFlights: settings.travelGoogleFlights !== false,
        videoEnabled: settings.videoEnabled !== false,
        ...(settings.videoKeepDays === undefined ? {} : { videoKeepDays: settings.videoKeepDays }),
      };

function owner(initial: WorkspaceSettingsAnswer["settings"], older = false, disabledPlugins?: string[]) {
  let answer: WorkspaceSettingsAnswer = {
    workspaceId: "default",
    revision: 1,
    settings: initial,
    effective: effectiveOf(initial, older),
    hostTimezone: "UTC",
    ...(disabledPlugins === undefined ? {} : { disabledPlugins }),
  };
  const writes: Record<string, unknown>[] = [];
  /** The credential references stored, never values. */
  const stored = new Set<string>();
  const client: SettingsClient = {
    request: (command, payload) => {
      const body = payload as Record<string, unknown>;
      if (command === "workspace-settings") {
        if (body["action"] !== "get") {
          writes.push(body);
          const settings = { ...answer.settings };
          if (body["key"] === "activitySummaries") {
            if (body["action"] === "set") settings.activitySummaries = false;
            else delete settings.activitySummaries;
          }
          if (body["key"] === "browserNoThumbnailHosts") {
            const parsed = body["action"] === "set" ? parseNoThumbnailHosts(String(body["value"])) : undefined;
            if (parsed !== undefined && "hosts" in parsed) settings.browserNoThumbnailHosts = [...parsed.hosts];
            else delete settings.browserNoThumbnailHosts;
          }
          if (body["key"] === "videoKeepDays" && body["action"] === "set") settings.videoKeepDays = Number(body["value"]);
          for (const key of ["travelFlightSearch", "travelGoogleFlights"] as const) {
            if (body["key"] !== key) continue;
            if (body["action"] === "set") settings[key] = false;
            else delete settings[key];
          }
          answer = { ...answer, revision: answer.revision + 1, settings, effective: effectiveOf(settings, older) };
        }
        return Promise.resolve({ ok: true, result: answer } as never);
      }
      if (command === "browser" && body["action"] === "recipes") {
        return Promise.resolve({
          ok: true,
          result: {
            recipes: [
              {
                host: "google.com",
                steps: [
                  { kind: "type", role: "combobox", label: "Where from?" },
                  { kind: "scroll", value: "down" },
                ],
                results: 9,
                uses: 2,
                updatedAt: "2026-10-08T12:00:00.000Z",
              },
            ],
          },
        } as never);
      }
      if (command === "browser" && body["action"] === "propose-site-note") {
        writes.push({ command, ...body });
        return Promise.resolve({
          ok: true,
          result: {
            proposed: { id: "recipe-google-com", name: "google.com", hosts: ["google.com"], file: "recipe-google-com.json", on: false },
          },
        } as never);
      }
      if (command === "credentials") {
        if (body["action"] === "list") return Promise.resolve({ ok: true, result: { credentials: [...stored], unusable: [] } } as never);
        writes.push({ command, ...body });
        if (body["action"] === "set") stored.add(String(body["reference"]));
        if (body["action"] === "delete") stored.delete(String(body["reference"]));
        return Promise.resolve({ ok: true, result: {} } as never);
      }
      if (command === "reset-instance") {
        writes.push({ command, ...body });
        return Promise.resolve({ ok: true, result: { resetting: true } } as never);
      }
      if (command === "models" && body["action"] === "list")
        return Promise.resolve({ ok: true, result: [{ connectionId: "ollama", label: "Ollama" }] } as never);
      if (command === "models" && body["action"] === "roles")
        return Promise.resolve({ ok: true, result: { workspaceDefault: null, resolved: [] } } as never);
      if (command === "models" && body["action"] === "show")
        return Promise.resolve({
          ok: true,
          result: { catalog: [{ connectionId: "ollama", modelId: "llama3", provenance: "live", state: "available", capabilities: [] }] },
        } as never);
      return new Promise<never>(() => undefined);
    },
  };
  return { client, writes };
}

/** The checkbox inside the label that reads `text`, or undefined. */
const checkbox = (page: ParentNode, text: string): HTMLInputElement | undefined =>
  [...page.querySelectorAll<HTMLInputElement>("label > input[type=checkbox]")].find(
    (input) => (input.parentElement?.textContent ?? "").trim() === text,
  );

describe("task summaries in Settings → General", () => {
  it("are on by default, turn off with the switch, and use the fast role, else each task's own model, until one is chosen", async () => {
    const { client, writes } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Task summaries");
    const toggle = checkbox(page, "Summarize finished tasks") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    // The default is the fast role's model when bound, else the task's own, as the summarizer chooses it.
    expect(page.querySelector('[aria-label="summary model"]')?.textContent).toContain("Fast role, else each task’s own model");
    expect(page.textContent).toContain("Fast role’s model writes it when one is bound, else the model the task itself used");
    expect(page.textContent).not.toContain("goes nowhere it has not already been");

    await act(async () => toggle.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(writes).toEqual([{ action: "set", workspaceId: "default", key: "activitySummaries", value: "off", expectedRevision: 1 }]);
    expect((checkbox(page, "Summarize finished tasks") as HTMLInputElement).checked).toBe(false);
    expect(page.textContent).toContain("Task summaries are off");

    // Turning them back on clears the key: on is the default.
    await act(async () => (checkbox(page, "Summarize finished tasks") as HTMLInputElement).click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(writes[1]).toEqual({ action: "unset", workspaceId: "default", key: "activitySummaries", expectedRevision: 2 });
  });

  it("shows the chosen summary model", async () => {
    const { client } = owner({ activitySummaryModel: { connectionId: "ollama", model: "llama3" } });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    expect(page.querySelector('[aria-label="summary model"]')?.textContent).toContain("llama3 (Ollama)");
  });
});

/** Types into an input as React sees it. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("an older owner in Settings → General", () => {
  it("shows neither task summaries nor thumbnail hosts when the owner does not answer for them", async () => {
    const { client } = owner({}, true);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Timezone");
    expect(page.textContent).not.toContain("Task summaries");
    expect(checkbox(page, "Summarize finished tasks")).toBeUndefined();
    expect(page.textContent).not.toContain("Browser thumbnails");
  });
});

describe("browser thumbnail hosts in Settings → General", () => {
  it("shows the defaults, saves a list, checks it first, and resets to the defaults", async () => {
    const { client, writes } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    const field = () => page.querySelector<HTMLInputElement>('input[aria-label="hosts without thumbnails"]') as HTMLInputElement;
    expect(field().value).toBe(DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS.join(", "));
    expect(page.textContent).toContain("The defaults:");
    expect(button(page, "Reset to defaults")?.disabled).toBe(true);

    // A list that is not hosts is refused here, before the owner is asked.
    await type(field(), "mail.example.com, not a host");
    await act(async () => field().closest("form")?.requestSubmit());
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("not a host is not a host or *.domain");
    expect(writes).toEqual([]);

    await type(field(), "mail.example.com, *.Bank");
    await act(async () => field().closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    await settle();
    expect(writes).toEqual([
      { action: "set", workspaceId: "default", key: "browserNoThumbnailHosts", value: "mail.example.com, *.Bank", expectedRevision: 1 },
    ]);
    expect(field().value).toBe("mail.example.com, *.bank");
    expect(page.textContent).toContain("Your list.");

    await act(async () => button(page, "Reset to defaults")?.click());
    await settle();
    expect(writes[1]).toEqual({ action: "unset", workspaceId: "default", key: "browserNoThumbnailHosts", expectedRevision: 2 });
    expect(field().value).toBe(DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS.join(", "));
  });

  it("saves none as an empty list", async () => {
    const { client, writes } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    const field = page.querySelector<HTMLInputElement>('input[aria-label="hosts without thumbnails"]') as HTMLInputElement;
    await type(field, "none");
    await act(async () => field.closest("form")?.requestSubmit());
    await settle();
    expect(writes.at(-1)).toMatchObject({ key: "browserNoThumbnailHosts", value: "none" });
    expect(page.querySelector<HTMLInputElement>('input[aria-label="hosts without thumbnails"]')?.value).toBe("none");
  });
});

describe("how long videos are kept, in Settings → General", () => {
  it("saves like the page's other fields: primary, and only once the number has changed and is in range (Mac mini UI check)", async () => {
    const { client, writes } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    const field = () => page.querySelector<HTMLInputElement>('input[aria-label="days a video is kept"]') as HTMLInputElement;
    const save = () => field().closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;
    expect(field().value).toBe("30");
    expect(save().className).toContain("button-primary");
    expect(save().disabled).toBe(true);
    await type(field(), "0");
    expect(save().disabled).toBe(true);
    await type(field(), "7");
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    await settle();
    expect(writes).toEqual([{ action: "set", workspaceId: "default", key: "videoKeepDays", value: "7", expectedRevision: 1 }]);
    expect(field().value).toBe("7");
    expect(save().disabled).toBe(true);
  });
});

describe("a save the owner refuses, in Settings → General", () => {
  it("is said as a failure, an alert, not in the grey of a saved one", async () => {
    const { client } = owner({});
    const refusing: SettingsClient = {
      request: (command, payload) =>
        command === "workspace-settings" && (payload as Record<string, unknown>)["action"] === "set"
          ? Promise.resolve({ ok: false, error: { code: "CONFLICT", message: "stale revision" } } as never)
          : client.request(command, payload),
    };
    const page = await mount(
      <InWorkspace client={refusing} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    const field = page.querySelector<HTMLInputElement>('input[aria-label="days a video is kept"]') as HTMLInputElement;
    await type(field, "7");
    await act(async () => field.closest("form")?.requestSubmit());
    await settle();
    const alert = page.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("stale revision");
    expect(page.querySelector(".settings > p.notice")).toBeNull();
  });
});

describe("a plugin turned off in Settings → General", () => {
  it("shows no setting only the browser, flight search or video plugin reads while it is off", async () => {
    const page = async (disabledPlugins?: string[]) =>
      await mount(
        <InWorkspace client={owner({}, false, disabledPlugins).client} workspaceId="default">
          <GeneralSettings />
        </InWorkspace>,
      );
    const on = await page();
    expect(checkbox(on, "Search flights with Kiwi.com")).not.toBeNull();
    expect(on.querySelector('input[aria-label="let the agent read videos"]')).not.toBeNull();
    expect(on.textContent).toContain("Clear browser profile");
    expect(on.textContent).toContain("Browser thumbnails");
    const off = await page(["tavi.browser", "tavi.flights", "tavi.video"]);
    expect(checkbox(off, "Search flights with Kiwi.com")).toBeUndefined();
    expect(off.querySelector('input[aria-label="let the agent read videos"]')).toBeNull();
    expect(off.textContent).not.toContain("Clear browser profile");
    expect(off.textContent).not.toContain("Browser thumbnails");
    expect(off.textContent).toContain("Timezone");
  });
});

describe("flight search and site recipes in Settings → General", () => {
  it("turns the flight search and its best-effort Google Flights back end off, each on its own", async () => {
    const { client, writes } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("best effort");
    const google = checkbox(page, "Search Google Flights too (unofficial, best effort)") as HTMLInputElement;
    expect(google.checked).toBe(true);
    await act(async () => google.click());
    await settle();
    expect(writes.at(-1)).toMatchObject({ action: "set", key: "travelGoogleFlights", value: "off" });
    expect(checkbox(page, "Search Google Flights too (unofficial, best effort)")?.checked).toBe(false);
    expect(checkbox(page, "Search flights with Kiwi.com")?.checked).toBe(true);
  });

  it("stores a SerpApi key for round trips on Google Flights, says it is stored, and removes it", async () => {
    const { client, writes } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("one-way trips only");
    const field = page.querySelector<HTMLInputElement>("#serpapi-key");
    expect(field).not.toBeNull();
    await type(field!, " sk-test ");
    await click(button(page, "Store key"));
    expect(writes.at(-1)).toMatchObject({ command: "credentials", action: "set", reference: "serpapi", value: "sk-test" });
    expect(page.textContent).toContain("A SerpApi key is stored");
    expect(page.querySelector("#serpapi-key")).toBeNull();
    await click(button(page, "Remove key"));
    expect(writes.at(-1)).toMatchObject({ command: "credentials", action: "delete", reference: "serpapi" });
    expect(page.querySelector("#serpapi-key")).not.toBeNull();
    // Google Flights off, no key is asked for.
    await act(async () => checkbox(page, "Search Google Flights too (unofficial, best effort)")?.click());
    await settle();
    expect(page.querySelector("#serpapi-key")).toBeNull();
  });

  it("names each switch by the words beside it, so a name holds its visible text", async () => {
    const page = await mount(
      <InWorkspace client={owner({}).client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    const mismatched = [...page.querySelectorAll<HTMLInputElement>("label > input[type=checkbox][aria-label]")]
      .map((input) => ({ name: input.getAttribute("aria-label") ?? "", shown: (input.parentElement?.textContent ?? "").trim() }))
      .filter(({ name, shown }) => !name.toLowerCase().includes(shown.toLowerCase()));
    expect(mismatched).toEqual([]);
  });

  it("shows a site recipe's steps as the agent is shown them", async () => {
    const { client } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    await settle();
    expect(page.textContent).toContain("google.com");
    expect([...page.querySelectorAll(".site-recipes details li")].map((item) => item.textContent)).toEqual([
      "type combobox “Where from?”",
      "scroll the page (down)",
    ]);
  });
});

describe("saving a site recipe as a site note", () => {
  it("asks the owner to propose it, and shows the note off with how to turn it on", async () => {
    const { client, writes } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    await settle();
    const save = button(page, "Save as a site note") as HTMLButtonElement;
    // Its name starts with the words it shows, then says which site's.
    expect(save.getAttribute("aria-label")).toBe("Save as a site note: google.com");
    await act(async () => save.click());
    await settle();
    expect(writes.filter((write) => write["command"] === "browser")).toEqual([
      { command: "browser", action: "propose-site-note", workspaceId: "default", host: "google.com" },
    ]);
    const notice = page.querySelector(".site-recipes [role=status]");
    expect(notice?.textContent).toContain("Saved as the site note recipe-google-com, off");
    expect(notice?.textContent).toContain("site-notes/recipe-google-com.json");
    expect(notice?.textContent).toContain("tavi browser site-notes --on recipe-google-com");
    // Saved once: the button does not offer a second, which the owner would refuse.
    expect((button(page, "Save as a site note") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Reset instance in Settings → General", () => {
  it("asks for the typed word, sends it, and hands the page over to start again", async () => {
    const { client, writes } = owner({});
    let reset = 0;
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings onReset={() => (reset += 1)} />
      </InWorkspace>,
    );
    await act(async () => button(page, "Reset instance…")?.click());
    const confirm = () => button(page, "Reset instance") as HTMLButtonElement;
    const field = page.querySelector<HTMLInputElement>('input[aria-label="type reset to confirm"]') as HTMLInputElement;
    expect(confirm().disabled).toBe(true);
    await type(field, "Reset");
    expect(confirm().disabled).toBe(true);
    await type(field, "reset");
    expect(confirm().disabled).toBe(false);

    await act(async () => confirm().click());
    await settle();
    expect(writes).toEqual([{ command: "reset-instance", confirm: "reset" }]);
    expect(reset).toBe(1);
    expect(page.querySelector('input[aria-label="type reset to confirm"]')).toBeNull();
    expect(page.textContent).toContain("this page reloads when it is back");
  });

  it("sends nothing when cancelled", async () => {
    const { client, writes } = owner({});
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    await act(async () => button(page, "Reset instance…")?.click());
    await act(async () => button(page, "Cancel")?.click());
    expect(page.querySelector('input[aria-label="type reset to confirm"]')).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe("Run setup again in Settings → General", () => {
  it("opens every setup step through onRunSetup, writing nothing, and is absent where the owner offers no setup", async () => {
    const { client, writes } = owner({});
    let runs = 0;
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings
          onRunSetup={() => {
            runs += 1;
          }}
        />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("Go through every setup step again");
    await act(async () => button(page, "Run setup again")?.click());
    await settle();
    expect(runs).toBe(1);
    expect(writes).toEqual([]);
    unmountAll();
    const without = await mount(
      <InWorkspace client={client} workspaceId="default">
        <GeneralSettings />
      </InWorkspace>,
    );
    expect(button(without, "Run setup again")).toBeUndefined();
    expect(without.textContent).not.toContain("Go through every setup step again");
  });
});
