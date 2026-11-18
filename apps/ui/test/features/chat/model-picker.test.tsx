// @vitest-environment jsdom
import axe from "axe-core";
import { act, type ComponentProps, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ModelPicker } from "../../../src/features/chat/ModelPicker.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, mountSettled } from "../../support/dom.js";

/** `node` mounted, and one promise turn let run in an act: the picker is drawn within it. */
const mount = (node: ReactNode) => mountSettled(node, () => flush(1, 1));

/** WCAG 2.2 AA. Colour contrast is left to the token test: jsdom computes no colours. */
const AXE = {
  runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  rules: { "color-contrast": { enabled: false } },
};
const violations = async (where: Element): Promise<string[]> =>
  (await axe.run(where, AXE)).violations.map((violation) => `${violation.id}: ${violation.help}`);

/** The picker for `target` in a form, as the composer holds it: a pick that says nothing, Manage that does nothing, unless `props` say otherwise. */
const picker = (client: SettingsClient, target: string, props: Partial<ComponentProps<typeof ModelPicker>> = {}, after?: ReactNode) => (
  <form>
    <InWorkspace client={client} workspaceId="default">
      <ModelPicker target={target} onPick={async () => ({ ok: true, value: undefined })} onManage={() => undefined} {...props} />
    </InWorkspace>
    {after}
  </form>
);

/** What Radix calls on open and jsdom lacks: no layout, no pointer capture. */
function radixShims(): void {
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
}

/** The picker's list opened with the keyboard; jsdom has no pointer. */
async function openList(page: HTMLElement): Promise<void> {
  const trigger = page.querySelector<HTMLButtonElement>(".model-select")!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
}

/** A capable model OpenRouter lists. */
const listed = (modelId: string, displayName: string, capabilities: string[] = []) => ({
  connectionId: "openrouter",
  modelId,
  displayName,
  provenance: "live" as const,
  state: "capable" as const,
  capabilities,
});

/** An owner whose one connection, OpenRouter, lists `models`, the workspace's default `model` when given. */
function catalog(models: readonly ReturnType<typeof listed>[], model?: string): SettingsClient {
  return {
    request: async (_family, input) => {
      const action = (input as { action: string }).action;
      if (action === "list")
        return { ok: true, result: [{ connectionId: "openrouter", label: "OpenRouter", kind: "openai-compatible" }] } as never;
      if (action === "roles")
        return {
          ok: true,
          result:
            model === undefined ? { resolved: [] } : { workspaceDefault: { target: { connectionId: "openrouter", model } }, resolved: [] },
        } as never;
      if (action === "show") return { ok: true, result: { catalog: models } } as never;
      return { ok: true, result: {} } as never;
    },
  };
}

/** An owner with one connection and two discovered models. */
function owner(): { readonly client: SettingsClient } {
  const answers: Record<string, unknown> = {
    list: [{ connectionId: "openrouter", label: "OpenRouter", kind: "openai-compatible" }],
    roles: { workspaceDefault: { target: { connectionId: "openrouter", model: "gpt-4.1-mini" } }, resolved: [] },
    show: {
      catalog: [
        {
          connectionId: "openrouter",
          modelId: "gpt-4.1-mini",
          displayName: "GPT-4.1 mini",
          provenance: "live",
          state: "capable",
          capabilities: ["tools"],
        },
        { connectionId: "openrouter", modelId: "gone", provenance: "live", state: "unavailable", capabilities: [] },
      ],
    },
  };
  const client: SettingsClient = {
    request: async (_family, input) => {
      const action = (input as { action: string }).action;
      return { ok: true, result: answers[action] } as never;
    },
  };
  return { client };
}

describe("the composer's model picker", () => {
  it("lists the discovered models, the current default selected and an unavailable one disabled", async () => {
    const { client } = owner();
    const page = await mount(picker(client, "openrouter/gpt-4.1-mini"));
    const trigger = page.querySelector<HTMLButtonElement>(".model-select")!;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toContain("GPT-4.1 mini");
    // Radix mirrors the options into a native select for the form.
    const options = [...page.querySelectorAll("select option")].map(
      (option) => `${option.getAttribute("value")}${(option as HTMLOptionElement).disabled ? " (disabled)" : ""}`,
    );
    expect(options).toContain("option:openrouter/gpt-4.1-mini");
    expect(options).toContain("option:openrouter/gone (disabled)");
  });

  it("opens the info dropdown showing full specs and a link to model settings", async () => {
    const { client } = owner();
    let managed = 0;
    const page = await mount(
      picker(client, "openrouter/gpt-4.1-mini", {
        onManage: () => {
          managed++;
        },
      }),
    );
    const infoButton = page.querySelector<HTMLButtonElement>('button[aria-label="Model specifications"]')!;
    expect(infoButton).not.toBeNull();
    expect(document.querySelector(".model-info-popover")).toBeNull();

    await act(async () => {
      infoButton.click();
    });
    const popover = document.querySelector<HTMLDivElement>(".model-info-popover")!;
    expect(popover).not.toBeNull();
    expect(popover.textContent).toContain("GPT-4.1 mini");
    expect(popover.textContent).toContain("OpenRouter");
    expect(popover.textContent).toContain("tools");

    const settingsBtn = popover.querySelector<HTMLButtonElement>(".model-info-manage-button")!;
    expect(settingsBtn).not.toBeNull();
    await act(async () => {
      settingsBtn.click();
    });
    expect(managed).toBe(1);
    expect(document.querySelector(".model-info-popover")).toBeNull();
  });

  it("keeps focus on its info button as the popover opens, moves it into the popover, and Escape gives it back without reaching the page", async () => {
    const { client } = owner();
    const page = await mount(picker(client, "openrouter/gpt-4.1-mini", {}, <button type="button">After</button>));
    const infoButton = page.querySelector<HTMLButtonElement>('button[aria-label="Model specifications"]')!;
    expect(infoButton.getAttribute("aria-haspopup")).toBe("dialog");
    infoButton.focus();
    await act(async () => {
      infoButton.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The same button, still in the page: opening it does not remount it.
    expect(page.querySelector('button[aria-label="Model specifications"]')).toBe(infoButton);
    expect(infoButton.isConnected).toBe(true);
    const popover = document.querySelector<HTMLDivElement>(".model-info-popover")!;
    expect(infoButton.getAttribute("aria-controls")).toBe(popover.id);
    // Focus is in it: Model settings is the next thing a keyboard reaches.
    expect(document.activeElement?.textContent).toBe("Model settings");
    expect(await violations(popover)).toEqual([]);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      document.activeElement?.dispatchEvent(escape);
    });
    expect(document.querySelector(".model-info-popover")).toBeNull();
    expect(document.activeElement).toBe(infoButton);
    // Handled: the page's own Escape (stopping a running turn) skips it.
    expect(escape.defaultPrevented).toBe(true);

    // Tab out of the popover, which sits at the page's end, closes it and goes on from its toggle.
    await act(async () => {
      infoButton.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector(".model-info-popover")).toBeNull();
    expect(document.activeElement?.textContent).toBe("After");
  });

  it("passes axe, its search outside the listbox, named, and counting what it finds", async () => {
    const client = catalog(Array.from({ length: 10 }, (_, i) => (i === 0 ? listed("nova", "Nova") : listed(`model-${i}`, `Model ${i}`))));
    radixShims();
    const page = await mount(picker(client, "openrouter/model-1"));
    expect(await violations(page)).toEqual([]);
    await openList(page);
    const content = document.querySelector<HTMLElement>(".select-content")!;
    const search = content.querySelector<HTMLInputElement>(".select-search-input")!;
    expect(search.getAttribute("aria-label")).toBe("Search models");
    expect(search.closest('[role="listbox"]')).toBeNull();
    const list = content.querySelector('[role="listbox"]')!;
    expect(search.getAttribute("aria-controls")).toBe(list.id);
    expect([...list.children].every((child) => child.getAttribute("role") === "option")).toBe(true);
    expect(await violations(content)).toEqual([]);
    const status = content.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("");
    const type = async (text: string): Promise<void> => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, text);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("nova");
    // The same region, there since the list opened, says each count.
    expect(content.querySelector('[role="status"]')).toBe(status);
    expect(status.textContent).toBe("1 result");
    await type("zzz");
    expect(status.textContent).toBe("No results found");
    expect(await violations(content)).toEqual([]);
  });

  it("names a target the catalog does not know, rather than pretending it is one of them", async () => {
    const { client } = owner();
    const page = await mount(picker(client, "openrouter/other"));
    expect(page.querySelector(".model-select")?.textContent).toContain("openrouter/other");
  });

  it("falls back to the settings link while nothing is discovered", async () => {
    const empty: SettingsClient = {
      request: async (_family, input) =>
        ({ ok: true, result: (input as { action: string }).action === "list" ? [] : { resolved: [], workspaceDefault: null } }) as never,
    };
    let managed = 0;
    const page = await mount(
      <InWorkspace client={empty} workspaceId="default">
        <ModelPicker
          target={undefined}
          onPick={async () => ({ ok: true, value: undefined })}
          onManage={() => {
            managed++;
          }}
        />
      </InWorkspace>,
    );
    const link = page.querySelector<HTMLButtonElement>(".model-selector")!;
    expect(link.textContent).toContain("Configure model");
    await act(async () => link.click());
    expect(managed).toBe(1);
  });

  it("names the running model by its own name while nothing is discovered, the full id as its title", async () => {
    const empty: SettingsClient = {
      request: async (_family, input) =>
        ({ ok: true, result: (input as { action: string }).action === "list" ? [] : { resolved: [], workspaceDefault: null } }) as never,
    };
    const page = await mount(
      <InWorkspace client={empty} workspaceId="default">
        <ModelPicker target="openrouter/vendor/model-x" onPick={async () => ({ ok: true, value: undefined })} onManage={() => undefined} />
      </InWorkspace>,
    );
    const link = page.querySelector<HTMLButtonElement>(".model-selector")!;
    expect(link.textContent).toContain("model-x");
    expect(link.textContent).not.toContain("openrouter/");
    expect(link.title).toBe("openrouter/vendor/model-x");
  });

  it("hands a pick to the caller, and shows its note", async () => {
    const { client } = owner();
    const picked: string[] = [];
    // The chat's model is not in the catalog, so the pick is a real change.
    const page = await mount(
      picker(client, "openrouter/other", {
        onPick: async (connectionId, model) => {
          picked.push(`${connectionId}/${model}`);
          return { ok: true, value: `This chat and new chats run ${model}.` };
        },
      }),
    );
    radixShims();
    await openList(page);
    const item = [...document.querySelectorAll<HTMLElement>(".select-option")].find((node) => node.textContent?.includes("GPT-4.1 mini"))!;
    expect(item).toBeDefined();
    await act(async () => {
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(picked).toEqual(["openrouter/gpt-4.1-mini"]);
    expect(page.querySelector(".model-note")?.textContent).toBe("This chat and new chats run gpt-4.1-mini.");
  });

  it("shows incremental search when models exceed dropdown capacity and filters options", async () => {
    const client = catalog(
      Array.from({ length: 10 }, (_, i) =>
        i === 0 ? listed("nova-2-lite", "Nova 2 Lite", ["tools"]) : listed(`model-${i}`, `Model ${i}`, ["tools"]),
      ),
      "model-1",
    );
    radixShims();
    const page = await mount(picker(client, "openrouter/model-1"));
    await openList(page);

    const searchInput = document.querySelector<HTMLInputElement>(".select-search-input");
    expect(searchInput).not.toBeNull();
    expect(searchInput?.placeholder).toBe("Search models…");

    // Filter by typing "nova"
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      searchInput?.focus();
      nativeInputValueSetter?.call(searchInput, "nova");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const visibleOptions = [...document.querySelectorAll<HTMLElement>(".select-option")];
    expect(visibleOptions.some((opt) => opt.textContent?.includes("Nova 2 Lite"))).toBe(true);
    expect(visibleOptions.every((opt) => !opt.textContent?.includes("Model 5"))).toBe(true);
    // The chosen model is filtered out of the list, and still named on the button.
    expect(page.querySelector(".model-select")?.textContent).toContain("Model 1");
  });

  it("says which connection each model is from when there are several, and finds them by it", async () => {
    const local = { ...listed("gemma4:12b", "gemma4:12b"), connectionId: "ollama" };
    const client: SettingsClient = {
      request: async (_family, input) => {
        const action = (input as { action: string }).action;
        if (action === "list")
          return {
            ok: true,
            result: [
              { connectionId: "ollama", label: "Ollama", kind: "openai-compatible" },
              { connectionId: "openrouter", label: "OpenRouter", kind: "openai-compatible" },
            ],
          } as never;
        if (action === "roles") return { ok: true, result: { resolved: [] } } as never;
        if (action === "show")
          return {
            ok: true,
            result: {
              catalog: [local, ...Array.from({ length: 9 }, (_, i) => listed(`model-${i}`, `Model ${i}`))].filter(
                (model) => model.connectionId === (input as { connectionId: string }).connectionId,
              ),
            },
          } as never;
        return { ok: true, result: {} } as never;
      },
    };
    radixShims();
    const page = await mount(picker(client, "ollama/gemma4:12b"));
    await openList(page);
    const detail = (name: string) =>
      [...document.querySelectorAll<HTMLElement>(".select-option")]
        .find((option) => option.textContent?.startsWith(name))
        ?.querySelector(".select-option-detail")?.textContent;
    expect(detail("gemma4:12b")).toBe("Ollama");
    expect(detail("Model 3")).toBe("OpenRouter");
    // The connection is searchable, and not part of the name the button shows.
    const search = document.querySelector<HTMLInputElement>(".select-search-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "ollama");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...document.querySelectorAll(".select-option")].map((option) => option.textContent)).toEqual(["gemma4:12bOllama"]);
    expect(page.querySelector(".model-select")?.textContent).toBe("gemma4:12b");
  });

  it("focuses the currently selected model on open, and down arrow moves to the next model", async () => {
    const client = catalog(
      Array.from({ length: 10 }, (_, i) => listed(`model-${i}`, `Model ${i}`, ["tools"])),
      "model-3",
    );
    radixShims();
    const page = await mount(picker(client, "openrouter/model-3"));
    await openList(page);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const selectedItem = document.querySelector<HTMLElement>('.select-option[data-state="checked"]');
    expect(selectedItem).not.toBeNull();
    expect(selectedItem?.textContent).toContain("Model 3");
    expect(selectedItem?.getAttribute("data-highlighted")).toBe("");

    // Press ArrowDown from the selected item
    await act(async () => {
      selectedItem!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const nextHighlighted = document.querySelector<HTMLElement>('.select-option[data-highlighted=""]');
    expect(nextHighlighted?.textContent).toContain("Model 4");
  });
});

describe("capacity labels", () => {
  it("says a model's size in a few characters, and nothing when the listing said nothing", async () => {
    const { capacityLabel } = await import("../../../src/features/settings/models-api.js");
    const { formatTokens } = await import("../../../src/lib/format.js");
    expect(formatTokens(1_047_576)).toBe("1,047,576");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(128_000)).toBe("128K");
    expect(formatTokens(4096)).toBe("4,096");
    expect(formatTokens(32_768)).toBe("32,768");
    expect(capacityLabel({ contextWindow: 128_000, maxTokens: 4096 })).toBe("128K context · 4,096 out");
    expect(capacityLabel({ contextWindow: 200_000 })).toBe("200K context");
    expect(capacityLabel({})).toBeUndefined();
  });
});
