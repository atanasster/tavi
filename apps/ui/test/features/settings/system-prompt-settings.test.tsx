// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import type { ClientResponse } from "@tavi/client/browser";
import type { SystemPromptAnswer } from "@tavi/contracts";

import { SystemPromptSettings } from "../../../src/features/settings/SystemPromptSettings.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, click, mount, rerender, unmountAll } from "../../support/dom.js";

/**
 * Settings → System prompt.
 *
 * The behaviours here are the ones easy to get wrong: the
 * draft must survive a reload that a failed save triggers, a custom override
 * whose text equals the shipped default must still be clearable, an untouched
 * built-in prompt must not become an override by being looked at, and two
 * workspaces must not share a draft.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function setText(area: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const containerText = (container: HTMLElement): string => container.textContent ?? "";
const field = (container: HTMLElement): HTMLTextAreaElement => {
  const area = container.querySelector("textarea");
  if (area === null) throw new Error("no textarea");
  return area;
};

/**
 * A stub of the owner's answer, not this build's shipped text: the editor renders
 * whatever the answer carries, and the version string is opaque to it. Kept equal
 * to the current shipped version only so a reader is not misled.
 */
const SHIPPED = "Fixture shipped base, not the product's own text.";
const shipped = { text: SHIPPED, templateVersion: "tavi-default-v2" };

function answer(overrides: Partial<SystemPromptAnswer> = {}): SystemPromptAnswer {
  const custom = overrides.custom ?? null;
  return {
    workspaceId: "default",
    revision: custom === null ? 0 : custom.revision,
    custom,
    shipped,
    effective:
      custom === null
        ? { text: SHIPPED, source: "builtin", revision: null, templateVersion: "tavi-default-v2" }
        : { text: custom.text, source: "workspace", revision: custom.revision, templateVersion: null },
    appliesTo: "next-message",
    explicitAdapterShadowing: false,
    ...overrides,
  };
}

function customPrompt(text: string, revision: number): NonNullable<SystemPromptAnswer["custom"]> {
  return {
    text,
    revision,
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastOperation: "set",
    previousRevision: revision - 1,
    actor: "operator:cli",
    hash: "a".repeat(64),
  };
}

/** A client whose answers the test scripts, recording every request. */
function scripted(handler: (payload: Record<string, unknown>, count: number) => ClientResponse): {
  readonly client: SettingsClient;
  readonly sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    client: {
      request: (_command: string, payload: unknown) => {
        sent.push(payload as Record<string, unknown>);
        return Promise.resolve(handler(payload as Record<string, unknown>, sent.length));
      },
    } as unknown as SettingsClient,
  };
}

const ok = (result: unknown): ClientResponse => ({ ok: true, result });

/** The editor in `workspaceId`, reading from `client`; `key` as the shell keys it. */
const editor = (client: SettingsClient, workspaceId = "default", key?: string) => (
  <InWorkspace client={client} workspaceId={workspaceId}>
    <SystemPromptSettings key={key} />
  </InWorkspace>
);

describe("the system prompt editor", () => {
  it("shows the shipped default on a first visit, and cannot save it as an override", async () => {
    const { client, sent } = scripted(() => ok(answer()));
    const container = await mount(editor(client));
    expect(container.querySelector("h1")?.textContent).toBe("System prompt");
    expect(field(container).value).toBe(SHIPPED);
    expect(field(container).readOnly).toBe(true);
    expect(container.textContent).toContain("Built-in default");
    // Nothing to save: an untouched built-in prompt is not a change, and the button says no more than Save.
    expect(button(container, "Save")?.disabled).toBe(true);
    expect(button(container, "Save (use the shipped default)")).toBeUndefined();
    // Nor is there a custom prompt to go back from.
    expect(container.textContent).not.toContain("only stages the change");
    expect(sent).toHaveLength(1);
  });

  it("saves an edit with the revision it read, and shows the acknowledged state", async () => {
    const { client, sent } = scripted((payload) =>
      payload["action"] === "get" ? ok(answer()) : ok(answer({ custom: customPrompt(String(payload["text"]), 1) })),
    );
    const container = await mount(editor(client));
    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "  custom base\n");
    await click(button(container, "Save"));
    expect(sent.at(-1)).toEqual({ action: "set", workspaceId: "default", text: "  custom base\n", expectedRevision: 0 });
    expect(container.textContent).toContain("Custom");
    expect(container.textContent).toContain("revision 1");
    expect(container.textContent).toContain("Saved. Changes apply from the next message in this workspace.");
    // The acknowledgement is the new baseline, so the form is clean.
    expect(button(container, "Save")?.disabled).toBe(true);
  });

  it("rejects blank and over-limit text before the owner is asked", async () => {
    const { client, sent } = scripted((payload) =>
      payload["action"] === "get" ? ok(answer({ custom: customPrompt("base", 1) })) : ok(answer({ custom: customPrompt("base", 1) })),
    );
    const container = await mount(editor(client));
    await setText(field(container), "   ");
    expect(container.textContent).toContain("cannot be whitespace only");
    expect(button(container, "Save")?.disabled).toBe(true);

    await setText(field(container), "x".repeat(20_001));
    expect(container.textContent).toContain("At most 20,000 characters");
    expect(button(container, "Save")?.disabled).toBe(true);
    // Only the initial read was sent: neither draft reached the owner.
    expect(sent.filter((payload) => payload["action"] !== "get")).toHaveLength(0);
  });

  it("counts characters against the owner's bound as the operator types", async () => {
    const { client } = scripted((payload) => (payload["action"] === "get" ? ok(answer()) : ok(answer())));
    const container = await mount(editor(client));
    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "abcde");
    expect(container.textContent).toContain("5 of 20,000 characters");
  });

  it("keeps the draft on a conflict and off the saved state until the operator reloads", async () => {
    let getCount = 0;
    const { client, sent } = scripted((payload) => {
      if (payload["action"] === "get") {
        getCount += 1;
        // The second read is what "Reload saved" asks for: somebody else saved.
        return ok(getCount === 1 ? answer() : answer({ custom: customPrompt("theirs", 4) }));
      }
      return { ok: false, error: { code: "CONFLICT", message: "The system prompt for workspace default changed since it was read" } };
    });
    const container = await mount(editor(client));
    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "mine");
    await click(button(container, "Save"));

    expect(container.textContent).toContain("changed since it was read");
    // The draft survives the refusal — that is the whole point.
    expect(field(container).value).toBe("mine");
    expect(container.textContent).toContain("Your draft is kept");
    expect(sent.filter((payload) => payload["action"] === "set")).toHaveLength(1);

    await click(button(container, "Reload saved"));
    expect(field(container).value).toBe("theirs");
    expect(container.textContent).toContain("revision 4");
  });

  it("does not reload after a failed write, so nothing can overwrite the draft", async () => {
    let getCount = 0;
    const { client } = scripted((payload) => {
      if (payload["action"] !== "get") return { ok: false, error: { code: "UNAVAILABLE", message: "storage unavailable" } };
      getCount += 1;
      return ok(answer());
    });
    const container = await mount(editor(client));
    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "do not lose me");
    await click(button(container, "Save"));
    expect(container.textContent).toContain("storage unavailable");
    expect(field(container).value).toBe("do not lose me");
    // No automatic reload was issued, so nothing could have replaced the draft.
    expect(getCount).toBe(1);
  });

  it("clears an override whose text equals the shipped default", async () => {
    const { client, sent } = scripted((payload) => {
      if (payload["action"] === "get") return ok(answer({ custom: customPrompt(SHIPPED, 2) }));
      return ok(answer());
    });
    const container = await mount(editor(client));
    // The two states display the same string, and only the mode tells them apart.
    expect(container.textContent).toContain("Custom");
    expect(field(container).value).toBe(SHIPPED);

    await click(button(container, "Restore default"));
    expect(button(container, "Save (use the shipped default)")?.disabled).toBe(false);
    await click(button(container, "Save (use the shipped default)"));
    expect(sent.at(-1)).toEqual({ action: "reset", workspaceId: "default", expectedRevision: 2 });
    expect(container.textContent).toContain("Cleared.");
    expect(container.textContent).toContain("Built-in default");
  });

  it("stages a reset without writing until Save is pressed", async () => {
    const { client, sent } = scripted((payload) =>
      payload["action"] === "get" ? ok(answer({ custom: customPrompt("original", 3) })) : ok(answer()),
    );
    const container = await mount(editor(client));
    await click(button(container, "Restore default"));
    // The shipped text is shown and the field is locked, and nothing was sent.
    expect(field(container).value).toBe(SHIPPED);
    expect(field(container).readOnly).toBe(true);
    expect(sent.filter((payload) => payload["action"] !== "get")).toHaveLength(0);

    await click(button(container, "Discard changes"));
    expect(field(container).value).toBe("original");
    expect(container.textContent).toContain("Custom");
  });

  it("reports an unknown write outcome as unknown, not as a rollback", async () => {
    let getCount = 0;
    const { client } = scripted((payload) => {
      if (payload["action"] === "get") {
        getCount += 1;
        return ok(answer());
      }
      throw new Error("the request timed out");
    });
    const container = await mount(editor(client));
    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "maybe saved");
    await click(button(container, "Save"));
    expect(container.textContent).toContain("The write may still have been applied");
    expect(field(container).value).toBe("maybe saved");
    expect(getCount).toBe(1);
  });

  it("says when an explicit adapter prompt outranks the workspace setting", async () => {
    const { client } = scripted(() => ok(answer({ explicitAdapterShadowing: true })));
    const container = await mount(editor(client));
    expect(container.textContent).toContain("outranks this one");
  });

  it("keeps two workspaces apart, including their drafts", async () => {
    const answers: Readonly<Record<string, SystemPromptAnswer>> = {
      one: answer({ workspaceId: "one", custom: customPrompt("prompt for one", 1) }),
      two: answer({ workspaceId: "two", custom: customPrompt("prompt for two", 7) }),
    };
    const { client, sent } = scripted((payload) => ok(answers[String(payload["workspaceId"])] ?? answer()));
    const first = await mount(editor(client, "one", "one"));
    expect(field(first).value).toBe("prompt for one");
    await setText(field(first), "draft for one");

    // The keying convention the shell uses: a new key remounts, so the draft
    // cannot follow the operator into another workspace.
    unmountAll();
    const second = await mount(editor(client, "two", "two"));
    expect(field(second).value).toBe("prompt for two");
    await setText(field(second), "draft for two");
    await click(button(second, "Save"));
    expect(sent.at(-1)).toEqual({ action: "set", workspaceId: "two", text: "draft for two", expectedRevision: 7 });
  });

  it("renders its heading and a loading line before the first answer arrives", async () => {
    const pending = new Promise<never>(() => undefined);
    const client = { request: () => pending } as unknown as SettingsClient;
    const container = await mount(editor(client));
    expect(container.querySelector("h1")?.textContent).toBe("System prompt");
    expect(container.textContent).toContain("Loading system prompt…");
  });

  it("restores the acknowledged baseline on Discard, not the pre-save load answer", async () => {
    // A successful save updates the acknowledged state but not what `useLoaded`
    // last returned, so Discard must restore the acknowledgement: restoring the
    // load answer would show "Built-in default · revision 0" for a workspace that
    // holds a custom override, and the next save would conflict with itself.
    const { client, sent } = scripted((payload) =>
      payload["action"] === "get" ? ok(answer()) : ok(answer({ custom: customPrompt("saved once", 1) })),
    );
    const container = await mount(editor(client));
    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "saved once");
    await click(button(container, "Save"));
    expect(container.textContent).toContain("revision 1");

    await setText(field(container), "an edit I regret");
    await click(button(container, "Discard changes"));
    expect(field(container).value).toBe("saved once");
    expect(container.textContent).toContain("Custom");
    expect(container.textContent).toContain("revision 1");
    // The success note described the save this draft was discarded *after*, so it
    // must not still be on screen contradicting the form.
    expect(container.textContent).not.toContain("Saved. New tasks");

    await setText(field(container), "another edit");
    await click(button(container, "Save"));
    expect(sent.at(-1)).toEqual({ action: "set", workspaceId: "default", text: "another edit", expectedRevision: 1 });
  });

  it("reports a typed refusal as a refusal, not as an unknown outcome", async () => {
    const { client } = scripted((payload) =>
      payload["action"] === "get"
        ? ok(answer())
        : { ok: false, error: { code: "INVALID_INPUT", message: "the system prompt is not valid" } },
    );
    const container = await mount(editor(client));
    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "rejected");
    await click(button(container, "Save"));
    expect(container.textContent).toContain("the system prompt is not valid");
    expect(container.textContent).toContain("Nothing was saved");
    // The owner answered definitely; "may still have been applied" would be a lie.
    expect(container.textContent).not.toContain("may still have been applied");
    expect(field(container).value).toBe("rejected");
  });

  it("disables Save after a conflict until the saved prompt is reloaded", async () => {
    let getCount = 0;
    const { client } = scripted((payload) => {
      if (payload["action"] === "get") {
        getCount += 1;
        return ok(getCount === 1 ? answer() : answer({ custom: customPrompt("theirs", 2) }));
      }
      return { ok: false, error: { code: "CONFLICT", message: "changed since it was read" } };
    });
    const container = await mount(editor(client));
    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "mine");
    await click(button(container, "Save"));
    // Resending the same stale revision could only conflict again.
    expect(container.textContent).toContain("changed since it was read");
    expect(button(container, "Save")?.disabled).toBe(true);
    await click(button(container, "Reload saved"));
    expect(button(container, "Save")?.disabled).toBe(true);
    await setText(field(container), "mine, on the newer revision");
    expect(button(container, "Save")?.disabled).toBe(false);
  });

  it("adopts the answer a Retry asks for, so a recovered owner is actually shown", async () => {
    let getCount = 0;
    const { client } = scripted((payload) => {
      if (payload["action"] !== "get") return ok(answer());
      getCount += 1;
      // The first read fails (the owner is still starting), the retry succeeds.
      return getCount === 1
        ? { ok: false, error: { code: "UNAVAILABLE", message: "owner restarted" } }
        : ok(answer({ custom: customPrompt("after the restart", 3) }));
    });
    const container = await mount(editor(client));
    expect(container.textContent).toContain("owner restarted");
    await click(button(container, "Retry"));
    // The retry's answer replaces the state, rather than clearing the error and
    // leaving a stale (or absent) form behind.
    expect(field(container).value).toBe("after the restart");
    expect(container.textContent).toContain("revision 3");
    expect(container.textContent).not.toContain("owner restarted");
  });

  it("guards a reload or a close while the draft is dirty, and only then", async () => {
    const { client } = scripted(() => ok(answer()));
    const container = await mount(editor(client));
    const fire = (): boolean => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(false);
    await setText(field(container), "unsaved");
    expect(fire()).toBe(true);
    await click(button(container, "Discard changes"));
    expect(fire()).toBe(false);
  });

  it("exposes an accessible editor: named textarea, described count, alert and status regions", async () => {
    const { client } = scripted((payload) =>
      payload["action"] === "get" ? ok(answer()) : { ok: false, error: { code: "NOT_AUTHORIZED", message: "not allowed" } },
    );
    const container = await mount(editor(client));
    const area = field(container);
    expect(area.getAttribute("aria-label")).toBe("System prompt");
    const described = area.getAttribute("aria-describedby") ?? "";
    for (const id of described.split(/\s+/)) expect(container.querySelector(`#${id}`), id).not.toBeNull();
    expect(area.getAttribute("maxlength")).toBe("20000");
    expect(container.querySelector("label[for='system-prompt-text']")).not.toBeNull();

    await click(button(container, "Write a custom prompt"));
    await setText(field(container), "rejected");
    await click(button(container, "Save"));
    const alerts = [...container.querySelectorAll("[role='alert']")];
    expect(alerts.some((node) => node.textContent?.includes("not allowed"))).toBe(true);
    // A refusal is announced without the misleading unknown-outcome wording.
    expect(alerts.some((node) => node.textContent?.includes("may still have been applied"))).toBe(false);
  });

  it("remounts on a changed key, and refuses to carry a draft across a changed workspace prop", async () => {
    const answers: Readonly<Record<string, SystemPromptAnswer>> = {
      one: answer({ workspaceId: "one", custom: customPrompt("prompt for one", 1) }),
      two: answer({ workspaceId: "two", custom: customPrompt("prompt for two", 7) }),
    };
    const { client, sent } = scripted((payload) => ok(answers[String(payload["workspaceId"])] ?? answer()));
    const host = await mount(editor(client, "one", "one"));
    await setText(field(host), "draft for one");

    // The shell's keying convention: a changed key is a real remount, so the
    // draft cannot follow the operator into another workspace.
    await rerender(editor(client, "two", "two"));
    expect(field(host).value).toBe("prompt for two");

    // And without a key, the component still refuses to keep the old workspace's
    // text: the guarantee must not rest on caller discipline.
    await setText(field(host), "draft for two");
    await rerender(editor(client, "one"));
    expect(field(host).value).toBe("prompt for one");
    expect(containerText(host)).toContain("applies from the next message in one");

    await setText(field(host), "saved to one");
    await click(button(host, "Save"));
    expect(sent.at(-1)).toEqual({ action: "set", workspaceId: "one", text: "saved to one", expectedRevision: 1 });
  });

  it("states that every chat runs under the setting from its next message, and shows what is added on top", async () => {
    const { client } = scripted(() => ok(answer()));
    const container = await mount(editor(client));
    // One story with the status line below it: a new chat, and an existing chat's next message, run under it.
    expect(container.textContent).toContain("A new chat, and each existing chat's next message, run under it");
    expect(container.textContent).not.toContain("Existing chats keep the prompt");
    // The workspace most people have is "this workspace"; another is named by its id.
    expect(container.textContent).toContain("chats in this workspace");
    expect(container.textContent).toContain("applies from the next message");
    expect(container.textContent).toContain(`The shipped default (${shipped.templateVersion})`);
    expect(container.textContent).toContain("compaction summary call uses its own dedicated prompt");
    // The shipped text is text, not markup the browser would execute.
    expect(container.querySelector("pre")?.textContent).toBe(SHIPPED);
  });
});
