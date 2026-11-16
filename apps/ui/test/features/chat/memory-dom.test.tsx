// @vitest-environment jsdom
import {
  MEMORY_CONFIG_KEYS,
  MEMORY_FORGET_UNREACHED,
  MEMORY_TIDY_UP_LOOK,
  effectiveMemorySettings,
  type MemoryItem,
  type MemoryProviderAnswer,
  type ChatContextAnswer,
  type ChatNotice,
  type MemoryCardAnswer,
  type MemoryCardItem,
  type MemorySettings,
  type WorkspaceSettingsAnswer,
} from "@tavi/contracts";
import axe from "axe-core";
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { TidyUpSuggestions } from "../../../src/features/center/MemoryTidyUp.js";
import { MemoryBulkDecide } from "../../../src/features/center/MemoryProposals.js";
import { MemorySettingsCard } from "../../../src/features/center/MemorySettingsCard.js";
import { HeartbeatItemCard } from "../../../src/features/center/HeartbeatItem.js";
import { MemoryCard } from "../../../src/features/chat/MemoryCard.js";
import { MemoryUsed } from "../../../src/features/chat/MemoryUsed.js";
import { MemoryModeToggle, memoryModeLabel } from "../../../src/features/chat/MemoryMode.js";
import { NEW_PRIVATE_CHAT_LABEL, SidebarFrame } from "../../../src/features/shell/SidebarFrame.js";
import { NoticeCards } from "../../../src/features/chat/Notices.js";
import { settingsPath } from "../../../src/features/shell/route.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { pick, selected } from "../../pick.js";
import { announced, freshAnnouncer } from "../../announced.js";
import { InWorkspace } from "../../support/workspace.js";
import { mountSettled as mount, rerender, settle, unmountAll } from "../../support/dom.js";

beforeEach(() => void freshAnnouncer());

/**
 * Center → Soul & memory → the Settings card: memory on or paused, learn from chats, and the limits under
 * More, each written as the whole section against the revision read. Only
 * this step's keys are shown; every control is labelled and reachable by
 * keyboard.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An owner holding the settings document: each write is a compare-and-set, refused when stale. */
function owner(
  initial: MemorySettings | undefined,
  options: { readonly moveUnder?: boolean; readonly disclosure?: string; readonly personalDisclosure?: string } = {},
) {
  const answerOf = (memory: MemorySettings | undefined, revision: number): WorkspaceSettingsAnswer => ({
    workspaceId: "default",
    revision,
    settings: memory === undefined ? {} : { memory },
    effective: { timezone: "UTC", memory: effectiveMemorySettings(memory) },
    hostTimezone: "UTC",
  });
  let answer = answerOf(initial, 3);
  const writes: Record<string, unknown>[] = [];
  /** The embedding connection bound now: a disclosure names it, and a confirm accepts only it. */
  let bound = "cloud";
  // The memory provider: the built-in and one plugin, each change after its disclosure.
  let provider: MemoryProviderAnswer = {
    workspaceId: "default",
    revision: 3,
    selected: "tavi.memoryprovider",
    serving: "tavi.memoryprovider",
    egress: { records: false, conversation: false, includePersonal: false },
    personalDisclosure: "Personal memory is your own and shared by all your workspaces.",
    providers: [
      { id: "tavi.memoryprovider", kind: "builtin", index: "host", capabilities: ["recall", "capture"], receives: [] },
      {
        id: "acme.memory",
        kind: "plugin",
        index: "own",
        capabilities: ["recall"],
        receives: ["records", "conversation"],
        disclosure: "Memory provider: ranks what memory recalls.",
      },
    ],
    pendingRemovals: 0,
  };
  const providerWrites: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: (command, payload) => {
      const body = payload as Record<string, unknown>;
      if (command === "memory") {
        if (body["action"] === "provider") return Promise.resolve({ ok: true, result: provider } as never);
        providerWrites.push(body);
        const widens = body["action"] === "set-provider" ? body["providerId"] !== "tavi.memoryprovider" : body["on"] === true;
        if (widens && body["confirmed"] !== true)
          return Promise.resolve({
            ok: false,
            error: { code: "APPROVAL_REQUIRED", message: `Sends things to acme.memory (${String(body["field"] ?? "provider")}).` },
          } as never);
        if (body["action"] === "set-provider")
          provider = {
            ...provider,
            selected: String(body["providerId"]),
            serving: String(body["providerId"]),
            egress: { records: false, conversation: false, includePersonal: false },
          };
        else {
          const field = String(body["field"]);
          const on = body["on"] === true;
          const egress =
            field === "personal"
              ? { ...provider.egress, includePersonal: on }
              : field === "records"
                ? { ...provider.egress, records: on, includePersonal: on && provider.egress.includePersonal }
                : { ...provider.egress, conversation: on };
          provider = { ...provider, egress };
        }
        provider = { ...provider, revision: provider.revision + 1 };
        return Promise.resolve({ ok: true, result: provider } as never);
      }
      if (command !== "workspace-settings")
        return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "unexpected" } } as never);
      if (body["action"] === "get") return Promise.resolve({ ok: true, result: answer } as never);
      writes.push(body);
      // Someone else changed the settings since the page read them.
      if (options.moveUnder === true && writes.length === 1) answer = answerOf(answer.settings.memory, answer.revision + 1);
      if (body["expectedRevision"] !== answer.revision)
        return Promise.resolve({
          ok: false,
          error: { code: "CONFLICT", message: "The settings changed meanwhile; read them again" },
        } as never);
      // Hybrid recall on a remote embedding connection: the owner's disclosure until it is accepted.
      const asked = JSON.parse(String(body["value"])) as MemorySettings;
      const accepted = body["confirmed"] === true && body["confirmedConnection"] === bound;
      if (options.disclosure !== undefined && asked.retrieval === "hybrid" && answer.settings.memory?.retrieval !== "hybrid" && !accepted) {
        return Promise.resolve({
          ok: false,
          error: { code: "APPROVAL_REQUIRED", message: `${options.disclosure} (${bound})`, details: { connectionId: bound } },
        } as never);
      }
      // Personal memory through the remote connection: its own disclosure, then stored by the owner for the accepted connection.
      if (body["retrievalPersonal"] === true && !accepted && options.personalDisclosure !== undefined) {
        return Promise.resolve({
          ok: false,
          error: { code: "APPROVAL_REQUIRED", message: `${options.personalDisclosure} (${bound})`, details: { connectionId: bound } },
        } as never);
      }
      const { retrievalPersonal: kept, ...written } = asked;
      const personal =
        body["retrievalPersonal"] === true ? written.retrievalConnection : body["retrievalPersonal"] === false ? undefined : kept;
      answer = answerOf(personal === undefined ? written : { ...written, retrievalPersonal: personal }, answer.revision + 1);
      return Promise.resolve({ ok: true, result: answer } as never);
    },
  };
  return {
    client,
    writes,
    answer: () => answer,
    providerWrites,
    provider: () => provider,
    rebind: (connectionId: string) => (bound = connectionId),
  };
}

const switchNamed = (page: HTMLElement, name: string): HTMLInputElement => {
  const found = [...page.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find(
    (input) => input.closest("label")?.textContent?.includes(name) === true,
  );
  if (found === undefined) throw new Error(`no switch named ${name}`);
  return found;
};

describe("the memory Settings card", () => {
  it("shows memory on and learning from chats by default, and pauses memory as the whole section at the revision read", async () => {
    const { client, writes, answer } = owner(undefined);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const memory = switchNamed(page, "Memory");
    expect(memory.checked).toBe(true);
    expect(switchNamed(page, "Learn from chats").checked).toBe(true);
    await act(async () => memory.click());
    await settle();
    expect(writes).toEqual([
      { action: "set", workspaceId: "default", key: "memory", value: JSON.stringify({ enabled: false }), expectedRevision: 3 },
    ]);
    expect(answer().effective.memory?.enabled).toBe(false);
    expect(switchNamed(page, "Memory").checked).toBe(false);
    expect(page.textContent).toContain("Paused");
    expect(announced()).toContain("Memory is paused");
  });

  it("turns learning from chats off, keeping what else is set", async () => {
    const { client, writes } = owner({ limits: { evidence: 4 } });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    await act(async () => switchNamed(page, "Learn from chats").click());
    await settle();
    expect(JSON.parse(String(writes[0]?.["value"]))).toEqual({ limits: { evidence: 4 }, capture: "off" });
    expect(page.textContent).toContain("Off: only what you write yourself");
  });

  it("saves the limits under More once, and refuses a limit out of bounds before asking the owner", async () => {
    const { client, writes } = owner(undefined);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const field = (label: string): HTMLInputElement => {
      const target = [...page.querySelectorAll("label")].find((entry) => entry.textContent === label)?.htmlFor;
      return page.querySelector<HTMLInputElement>(`#${CSS.escape(target ?? "")}`)!;
    };
    const type = async (input: HTMLInputElement, value: string): Promise<void> => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const save = page.querySelector<HTMLButtonElement>(".memory-settings-limits button[type=submit]")!;
    expect(save.disabled).toBe(true);
    expect(field("Records per person").value).toBe("5000");
    await type(field("Records per person"), "9");
    await act(async () => save.click());
    await settle();
    expect(writes).toEqual([]);
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("from 10 to 20,000");
    await type(field("Records per person"), "100");
    await type(field("Days a proposal waits"), "7");
    await act(async () => save.click());
    await settle();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.["value"]))).toEqual({ limits: { maxRecords: 100, proposalDays: 7 } });
    expect(announced()).toContain("Memory limits saved");
  });

  it("treats a cleared limit as no change, never as a reset to the default", async () => {
    const { client, writes } = owner({ limits: { maxRecords: 100 } });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const field = (label: string): HTMLInputElement => {
      const target = [...page.querySelectorAll("label")].find((entry) => entry.textContent === label)?.htmlFor;
      return page.querySelector<HTMLInputElement>(`#${CSS.escape(target ?? "")}`)!;
    };
    const type = async (input: HTMLInputElement, value: string): Promise<void> => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const save = page.querySelector<HTMLButtonElement>(".memory-settings-limits button[type=submit]")!;
    await type(field("Records per person"), "");
    expect(save.disabled).toBe(true);
    await type(field("Days a proposal waits"), "7");
    await act(async () => save.click());
    await settle();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.["value"]))).toEqual({ limits: { maxRecords: 100, proposalDays: 7 } });
  });

  it("turns the weekly digest off under More, keeping what else is set", async () => {
    const { client, writes } = owner({ capture: "off" });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    expect(switchNamed(page, "Weekly digest").checked).toBe(true);
    await act(async () => switchNamed(page, "Weekly digest").click());
    await settle();
    expect(JSON.parse(String(writes.at(-1)?.["value"]))).toEqual({ capture: "off", digest: "off" });
    expect(switchNamed(page, "Weekly digest").checked).toBe(false);
  });

  it("turns weekly tidy-up suggestions on under More, off by default, keeping what else is set", async () => {
    const { client, writes } = owner({ capture: "off" });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    expect(switchNamed(page, "Tidy-up suggestions").checked).toBe(false);
    expect(page.textContent).toContain("Off: what is kept is never tidied");
    await act(async () => switchNamed(page, "Tidy-up suggestions").click());
    await settle();
    expect(JSON.parse(String(writes.at(-1)?.["value"]))).toEqual({ capture: "off", consolidation: "weekly" });
    expect(switchNamed(page, "Tidy-up suggestions").checked).toBe(true);
  });

  it("shows sensitive topics as not saved by default, and asks for them suggested and masked as the whole section", async () => {
    const { client, writes } = owner({ capture: "suggest" });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const label = [...page.querySelectorAll("label")].find((entry) => entry.textContent === "Sensitive topics");
    const select = page.querySelector<HTMLElement>(`#${CSS.escape(label?.htmlFor ?? "")}`)!;
    // Among the first settings, not under More.
    expect(select.closest("details")).toBeNull();
    expect(selected(select)).toBe("skip");
    expect(page.textContent).toContain("not saved from chats, unless you ask");
    await pick(select, "suggest");
    await settle();
    expect(JSON.parse(String(writes.at(-1)?.["value"]))).toEqual({ capture: "suggest", sensitive: "suggest" });
    expect(page.textContent).toContain("masked until you reveal them");
    expect(selected(page.querySelector(`#${CSS.escape(label?.htmlFor ?? "")}`))).toBe("suggest");
  });

  it("offers search quality under More, words by default; meaning search on a remote connection shows the owner's disclosure and turns on only after Turn on (invariant 14)", async () => {
    const disclosure =
      "Memory text and each message's retrieval query will be sent to cloud to compute embeddings: 12 approved memories now, and each new one as it is approved. Confirm to turn hybrid recall on.";
    const { client, writes, answer } = owner({ capture: "suggest" }, { disclosure });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const label = [...page.querySelectorAll("label")].find((entry) => entry.textContent === "Search quality");
    const select = () => page.querySelector<HTMLElement>(`#${CSS.escape(label?.htmlFor ?? "")}`)!;
    expect(select().closest("details")).not.toBeNull();
    expect(selected(select())).toBe("lexical");
    await pick(select(), "hybrid");
    await settle();
    // Asked, refused for the disclosure: nothing changed, the disclosure shown with Turn on and Cancel.
    expect(writes.at(-1)).not.toHaveProperty("confirmed");
    expect(answer().settings.memory?.retrieval).toBeUndefined();
    expect(page.textContent).toContain("sent to cloud to compute embeddings: 12 approved memories");
    const button = (name: string) => [...page.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
    await act(async () => button("Turn on").click());
    await settle();
    expect(writes.at(-1)).toMatchObject({ confirmed: true, confirmedConnection: "cloud" });
    expect(JSON.parse(String(writes.at(-1)?.["value"]))).toEqual({ capture: "suggest", retrieval: "hybrid" });
    expect(selected(select())).toBe("hybrid");
    expect(page.textContent).not.toContain("sent to cloud");
    expect(announced()).toContain("searched by meaning too");
    // Back to words needs no disclosure.
    await pick(select(), "lexical");
    await settle();
    expect(JSON.parse(String(writes.at(-1)?.["value"]))).toEqual({ capture: "suggest", retrieval: "lexical" });
  });

  it("a Turn on accepts the connection its disclosure named: one bound since is refused, and its own disclosure shown for a new yes", async () => {
    const { client, writes, answer, rebind } = owner(undefined, { disclosure: "Memory text will be sent to compute embeddings." });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const label = [...page.querySelectorAll("label")].find((entry) => entry.textContent === "Search quality");
    const select = page.querySelector<HTMLElement>(`#${CSS.escape(label?.htmlFor ?? "")}`)!;
    await pick(select, "hybrid");
    await settle();
    expect(page.textContent).toContain("Memory text will be sent to compute embeddings. (cloud)");
    // The role moves to cloud-b before the yes: the yes for cloud is refused with cloud-b's disclosure.
    rebind("cloud-b");
    const button = (name: string) => [...page.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
    await act(async () => button("Turn on").click());
    await settle();
    expect(writes.at(-1)).toMatchObject({ confirmed: true, confirmedConnection: "cloud" });
    expect(answer().settings.memory?.retrieval).toBeUndefined();
    expect(page.textContent).toContain("Memory text will be sent to compute embeddings. (cloud-b)");
    await act(async () => button("Turn on").click());
    await settle();
    expect(writes.at(-1)).toMatchObject({ confirmed: true, confirmedConnection: "cloud-b" });
    expect(answer().settings.memory?.retrieval).toBe("hybrid");
  });

  it("offers Personal memory too under search quality once hybrid is on with a remote connection; on only after its own disclosure, off with no confirm", async () => {
    const personalDisclosure =
      "Your personal memory is shared by all your workspaces: turning this on sends 3 of your approved personal memories (never sensitive ones) to cloud to compute embeddings now, and each new one as it is approved. Other people's personal memory is never sent there. Confirm to turn it on.";
    // Words only, or meaning on a local connection (no accepted remote one): no control, nothing to choose.
    for (const memory of [undefined, { retrieval: "hybrid" } as const]) {
      const page = await mount(
        <InWorkspace client={owner(memory).client} workspaceId="default">
          <MemorySettingsCard />
        </InWorkspace>,
      );
      // (The provider's own *Personal memory too* is its egress switch, another control.)
      expect(
        [...page.querySelectorAll('input[type="checkbox"]:not([role="switch"])')].filter(
          (input) => input.closest("label")?.textContent?.trim() === "Personal memory too",
        ),
      ).toEqual([]);
      unmountAll();
    }
    const { client, writes, answer } = owner({ retrieval: "hybrid", retrievalConnection: "cloud" }, { personalDisclosure });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const box = () =>
      [...page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])')].find(
        (input) => input.closest("label")?.textContent?.trim() === "Personal memory too",
      )!;
    expect(box().closest("details")).not.toBeNull();
    expect(box().checked).toBe(false);
    expect(page.textContent).toContain("is matched by its words; on, it is sent to cloud too");
    await act(async () => box().click());
    await settle();
    // Asked, refused for its own disclosure: nothing stored, the disclosure shown with its own Turn on and Cancel.
    expect(writes.at(-1)).toMatchObject({ retrievalPersonal: true });
    expect(writes.at(-1)).not.toHaveProperty("confirmed");
    expect(answer().settings.memory).not.toHaveProperty("retrievalPersonal");
    expect(page.textContent).toContain(
      "Your personal memory is shared by all your workspaces: turning this on sends 3 of your approved personal memories",
    );
    const button = (name: string) => [...page.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
    await act(async () => button("Turn on for personal memory").click());
    await settle();
    expect(writes.at(-1)).toMatchObject({ confirmed: true, confirmedConnection: "cloud", retrievalPersonal: true });
    expect(answer().settings.memory).toMatchObject({ retrievalPersonal: "cloud" });
    expect(box().checked).toBe(true);
    expect(page.textContent).not.toContain("turning this on sends");
    expect(announced()).toContain("Personal memory is now searched by meaning too");
    // Off needs no disclosure.
    await act(async () => box().click());
    await settle();
    expect(writes.at(-1)).toMatchObject({ retrievalPersonal: false });
    expect(writes.at(-1)).not.toHaveProperty("confirmed");
    expect(answer().settings.memory).not.toHaveProperty("retrievalPersonal");
    expect(box().checked).toBe(false);
    // Cancel on its disclosure sends nothing more.
    const before = writes.length;
    await act(async () => box().click());
    await settle();
    await act(async () => button("Cancel").click());
    await settle();
    expect(writes).toHaveLength(before + 1);
    expect(page.textContent).not.toContain("turning this on sends");
    expect(box().checked).toBe(false);
    // Labelled, and no WCAG 2.1 A/AA violations axe can find with its confirm open.
    await act(async () => box().click());
    await settle();
    expect(box().labels?.length).toBeGreaterThan(0);
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  });

  it("Cancel on the disclosure leaves recall on words, sending nothing more", async () => {
    const { client, writes } = owner(undefined, { disclosure: "Memory text … will be sent to cloud." });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const label = [...page.querySelectorAll("label")].find((entry) => entry.textContent === "Search quality");
    const select = page.querySelector<HTMLElement>(`#${CSS.escape(label?.htmlFor ?? "")}`)!;
    await pick(select, "hybrid");
    await settle();
    await act(async () => [...page.querySelectorAll("button")].find((entry) => entry.textContent === "Cancel")!.click());
    await settle();
    expect(writes).toHaveLength(1);
    expect(page.textContent).not.toContain("will be sent to cloud");
    expect(selected(page.querySelector(`#${CSS.escape(label?.htmlFor ?? "")}`))).toBe("lexical");
  });

  it("says a conflict and reads the settings again, so the next change starts from them", async () => {
    const { client, writes } = owner(undefined, { moveUnder: true });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    await act(async () => switchNamed(page, "Memory").click());
    await settle();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("changed meanwhile");
    await act(async () => switchNamed(page, "Memory").click());
    await settle();
    expect(writes.at(-1)).toMatchObject({ expectedRevision: 4 });
    expect(switchNamed(page, "Memory").checked).toBe(false);
  });

  it("shows one control per key, and no key no step has added", async () => {
    const { client } = owner(undefined);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    // Three switches (the weekly digest's among them), the sensitive-topics and search-quality choices, the four limits,
    // and Keep without asking's one group of ticks: one control per key; and the provider's choice and its three egress
    // switches, which `tavi memory config` does not change.
    const groups = page.querySelectorAll("fieldset.memory-settings-keep").length;
    expect(groups).toBe(1);
    expect(
      page.querySelectorAll('input[role="switch"]').length +
        page.querySelectorAll(".select-trigger").length +
        page.querySelectorAll('input[type="number"]').length +
        groups,
    ).toBe(MEMORY_CONFIG_KEYS.length + 4);
  });

  it("keeps without asking: Preferences, Facts and Lessons, all unticked; a tick saves the kind and says each still shows with Undo", async () => {
    const { client, writes, answer } = owner({ capture: "suggest" });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const group = page.querySelector("fieldset.memory-settings-keep");
    expect(group?.querySelector("legend")?.textContent).toBe("Keep without asking");
    const tick = (name: string): HTMLInputElement => {
      const found = [...(group?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])].find(
        (input) => input.closest("label")?.textContent?.trim() === name,
      );
      if (found === undefined) throw new Error(`no tick named ${name}`);
      return found;
    };
    for (const name of ["Preferences", "Facts", "Lessons"]) expect(tick(name).checked).toBe(false);
    expect(page.textContent).not.toContain("You'll still see each one, with Undo");
    await act(async () => tick("Facts").click());
    await settle();
    expect(JSON.parse(String(writes[0]?.["value"]))).toEqual({ capture: "suggest", autoApprove: ["fact"] });
    expect(answer().effective.memory?.autoApprove).toEqual(["fact"]);
    expect(tick("Facts").checked).toBe(true);
    const hint = page.querySelector(`#${CSS.escape(tick("Facts").getAttribute("aria-describedby") ?? "")}`);
    expect(hint?.textContent).toBe("You'll still see each one, with Undo");
    expect(announced()).toContain("kept without asking");
    await act(async () => tick("Preferences").click());
    await settle();
    expect(JSON.parse(String(writes[1]?.["value"]))).toEqual({ capture: "suggest", autoApprove: ["preference", "fact"] });
    // Unticking the last one clears the key: every proposal waits again.
    await act(async () => tick("Facts").click());
    await settle();
    await act(async () => tick("Preferences").click());
    await settle();
    expect(JSON.parse(String(writes.at(-1)?.["value"]))).toEqual({ capture: "suggest" });
    expect(page.textContent).not.toContain("You'll still see each one, with Undo");
  });

  it("shows the provider under More: the built-in, whose switches are off and say they apply to a plugin", async () => {
    const { client } = owner(undefined);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const select = page.querySelector('[id$="-provider"]');
    expect(selected(select)).toBe("tavi.memoryprovider");
    for (const name of ["Records", "Personal memory too", "Conversation"]) {
      expect(switchNamed(page, name).checked).toBe(false);
      expect(switchNamed(page, name).disabled).toBe(true);
    }
    expect(page.textContent).toContain("The built-in receives nothing");
  });

  it("chooses a provider and turns Records, then Personal memory too, on only after each disclosure; Personal memory too waits for Records", async () => {
    const { client, providerWrites, provider } = owner(undefined);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    const select = page.querySelector('[id$="-provider"]');
    if (select === null) throw new Error("no provider choice");
    await pick(select, "acme.memory");
    await settle();
    // Asked first, with what the owner says it sends; nothing changed yet.
    expect(page.textContent).toContain("Sends things to acme.memory (provider).");
    expect(provider().selected).toBe("tavi.memoryprovider");
    const goOn = [...page.querySelectorAll("button")].find((button) => button.textContent === "Go on");
    await act(async () => goOn?.click());
    await settle();
    expect(provider().selected).toBe("acme.memory");
    expect(page.textContent).toContain("Memory provider: ranks what memory recalls.");
    // Personal memory too is under Records, and waits for it.
    expect(switchNamed(page, "Personal memory too").disabled).toBe(true);
    expect(switchNamed(page, "Personal memory too").closest("ul")?.closest("li")?.textContent).toContain("Records");
    await act(async () => switchNamed(page, "Records").click());
    await settle();
    expect(page.textContent).toContain("Sends things to acme.memory (records).");
    await act(async () => [...page.querySelectorAll("button")].find((button) => button.textContent === "Go on")?.click());
    await settle();
    expect(switchNamed(page, "Records").checked).toBe(true);
    expect(switchNamed(page, "Personal memory too").disabled).toBe(false);
    await act(async () => switchNamed(page, "Personal memory too").click());
    await settle();
    await act(async () => [...page.querySelectorAll("button")].find((button) => button.textContent === "Go on")?.click());
    await settle();
    expect(provider().egress).toEqual({ records: true, conversation: false, includePersonal: true });
    expect(providerWrites.filter((write) => write["confirmed"] === true).map((write) => write["field"] ?? write["providerId"])).toEqual([
      "acme.memory",
      "records",
      "personal",
    ]);
    // Off needs no yes.
    await act(async () => switchNamed(page, "Records").click());
    await settle();
    expect(provider().egress).toEqual({ records: false, conversation: false, includePersonal: false });
  });

  it("links Learn from chats to the capture model, the extraction role in Settings → Models", async () => {
    const { client } = owner(undefined);
    let opened = 0;
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard
          onModels={() => {
            opened += 1;
          }}
        />
      </InWorkspace>,
    );
    const link = [...page.querySelectorAll("a")].find((candidate) => candidate.textContent === "Settings → Models");
    expect(link?.getAttribute("href")).toBe(settingsPath("models"));
    expect(link?.closest("li")?.textContent).toContain("the extraction role");
    await act(async () => link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(opened).toBe(1);
  });

  it("labels every control, reaches each by keyboard, and has no WCAG 2.1 A/AA violations axe can find", async () => {
    const { client } = owner({ enabled: false, autoApprove: ["fact"] }); // A tick and its Undo note are checked too.
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemorySettingsCard />
      </InWorkspace>,
    );
    page.querySelector("details")?.setAttribute("open", "");
    const controls = [...page.querySelectorAll<HTMLElement>("input, select, button, summary")];
    expect(controls.length).toBeGreaterThanOrEqual(9);
    for (const control of controls) {
      // A real control in the tab order: no negative tabindex.
      expect(control.tabIndex, control.outerHTML).toBeGreaterThanOrEqual(0);
      if (control instanceof HTMLInputElement || (control instanceof HTMLButtonElement && control.classList.contains("select-trigger")))
        expect(control.labels?.length ?? 0, control.outerHTML).toBeGreaterThan(0);
    }
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  });
});

/**
 * Center → *Tidy-up suggestions*:
 * each suggestion's before and after, Keep and Discard named by it; a stale
 * one says to let the next run suggest it again and cannot be kept.
 */
describe("tidy-up suggestions in the Center", () => {
  const tidy = (recordId: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
    recordId,
    kind: "fact",
    scope: { kind: "personal", principalId: "operator" },
    scopeKey: "personal|p=operator",
    status: "proposed",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: "2026-10-12T03:00:00.000Z",
    updatedAt: "2026-10-12T03:00:00.000Z",
    target: "personal",
    title: "Garden",
    body: "Keeps a vegetable garden and grows tomatoes in it",
    redacted: false,
    truncated: false,
    sourceCount: 0,
    supersedes: [
      { recordId: "mem-1", revisionId: "rev-1", title: "Keeps a vegetable garden", excerpt: null, stale: false },
      { recordId: "mem-2", revisionId: "rev-2", title: "Grows tomatoes", excerpt: "Grows tomatoes in the garden", stale: false },
    ],
    ...extra,
  });
  const context = { timeZone: "UTC", today: "2026-10-12", agentNames: {} };
  function decisions(
    answer: (action: string) => {
      readonly ok: boolean;
      readonly result?: unknown;
      readonly error?: { readonly code: string; readonly message: string };
    },
  ) {
    const sent: Record<string, unknown>[] = [];
    const client = {
      request: (command: string, payload: Record<string, unknown>) => {
        sent.push({ command, ...payload });
        return Promise.resolve(answer(String(payload["action"])));
      },
    } as unknown as SettingsClient;
    return { client, sent };
  }

  it("shows each suggestion's before and after, and Keep approves it as one decision", async () => {
    const decided: string[] = [];
    const { client, sent } = decisions(() => ({ ok: true, result: { ...tidy("t1"), status: "approved" } }));
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <TidyUpSuggestions items={[tidy("t1")]} context={context} onDecided={(recordId) => decided.push(recordId)} />
      </InWorkspace>,
    );
    expect(page.querySelector("h4")?.textContent).toBe("Tidy-up suggestions");
    const text = page.textContent ?? "";
    expect(text).toContain("Merge 2 into one");
    expect(text).toContain("Before");
    expect(text).toContain("Grows tomatoes in the garden");
    expect(text).toContain("After");
    expect(text).toContain("Keeps a vegetable garden and grows tomatoes in it");
    const keep = page.querySelector<HTMLButtonElement>('button[aria-label="Keep tidy-up: Garden"]');
    expect(keep?.disabled).toBe(false);
    await act(async () => keep?.click());
    await settle();
    expect(sent).toEqual([{ command: "memory", action: "approve", workspaceId: "default", recordId: "t1" }]);
    expect(decided).toEqual(["t1"]);
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  });

  it("a stale suggestion says to let the next run suggest it again and cannot be kept; a refusal says the same", async () => {
    const { client } = decisions(() => ({ ok: false, error: { code: "REVISION_CONFLICT", message: "changed" } }));
    const stale = tidy("t2", { supersedes: [{ recordId: "mem-1", revisionId: "rev-1", title: null, excerpt: null, stale: true }] });
    let page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <TidyUpSuggestions items={[stale]} context={context} onDecided={() => undefined} />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("the next weekly run suggests it again");
    expect(page.textContent).toContain("Not shown: sensitive, or forgotten since");
    expect(page.querySelector<HTMLButtonElement>('button[aria-label="Keep tidy-up: Garden"]')?.disabled).toBe(true);
    expect(page.querySelector<HTMLButtonElement>('button[aria-label="Discard tidy-up: Garden"]')?.disabled).toBe(false);
    unmountAll();
    page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <TidyUpSuggestions items={[tidy("t3")]} context={context} onDecided={() => undefined} />
      </InWorkspace>,
    );
    await act(async () => page.querySelector<HTMLButtonElement>('button[aria-label="Keep tidy-up: Garden"]')?.click());
    await settle();
    expect(page.querySelector(".failure")?.textContent).toContain("the next weekly run suggests it again");
  });

  it("shows a tidy-up's joined provenance: what the chats its inputs came from read", async () => {
    const { client } = decisions(() => ({ ok: true }));
    const read = {
      integrity: "untrusted" as const,
      sources: ["web" as const],
      refs: [{ source: "web" as const, ref: "call-1", host: "seeds.example.com", at: "2026-10-12T03:00:00.000Z" }],
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <TidyUpSuggestions items={[tidy("t1", { provenance: read })]} context={context} onDecided={() => undefined} />
      </InWorkspace>,
    );
    expect(page.querySelector(".memory-provenance")?.textContent).toBe(
      "Merges memories proposed after a chat read a web page (seeds.example.com) · Keep all leaves it waiting",
    );
  });

  it("shows nothing when no tidy-up waits", async () => {
    const { client } = decisions(() => ({ ok: true }));
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <TidyUpSuggestions items={[]} context={context} onDecided={() => undefined} />
      </InWorkspace>,
    );
    expect(page.textContent).toBe("");
  });
});

/**
 * Center → the proposals' bulk *Keep all* / *Discard all*: over exactly the listed proposals, under the one
 * *Keep all* rule; a *Saved · N* receipt whose Undo forgets exactly what that
 * press kept; each outcome announced politely.
 */
describe("bulk Keep and Discard in the Center", () => {
  const listed = (recordId: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
    recordId,
    kind: "fact",
    scope: { kind: "personal", principalId: "operator" },
    scopeKey: "personal|p=operator",
    status: "proposed",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: "2026-10-12T03:00:00.000Z",
    updatedAt: "2026-10-12T03:00:00.000Z",
    target: "personal",
    title: recordId,
    body: recordId,
    redacted: false,
    truncated: false,
    sourceCount: 0,
    ...extra,
  });
  const items = [
    listed("p1"),
    listed("p2"),
    listed("s1", { sensitivity: "sensitive", redacted: true, title: null, body: null }),
    listed("u1", { updates: { recordId: "kept-1", title: "Reply in Spanish", currentRevisionId: "kept-1-rev" } }),
    listed("t1", { supersedes: [{ recordId: "mem-1", revisionId: "rev-1", title: "Garden", excerpt: null, stale: false }] }),
  ];
  function bulkOwner() {
    const sent: Record<string, unknown>[] = [];
    const client = {
      request: (command: string, payload: Record<string, unknown>) => {
        sent.push({ command, ...payload });
        if (payload["action"] === "decide-all") {
          // The owner's one rule: the plain ones kept, the rest counted.
          return Promise.resolve(
            payload["decision"] === "keep"
              ? { ok: true, result: { kept: ["p1", "p2"], discarded: 0, needsLook: 3 } }
              : { ok: true, result: { kept: [], discarded: 5, needsLook: 0 } },
          );
        }
        if (payload["action"] === "forget") return Promise.resolve({ ok: true, result: {} });
        return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "unexpected" } });
      },
    } as unknown as SettingsClient;
    return { client, sent };
  }
  const named = (page: HTMLElement, name: string): HTMLButtonElement | undefined =>
    [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
    );

  it("Keep all keeps the listed plain ones only, says how many need a look, and the Saved receipt's Undo forgets exactly those", async () => {
    const { client, sent } = bulkOwner();
    let done = 0;
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryBulkDecide
          items={items}
          onDone={() => {
            done += 1;
          }}
        />
      </InWorkspace>,
    );
    const keep = named(page, "Keep all: the 2 plain proposals listed");
    expect(keep?.tabIndex).toBeGreaterThanOrEqual(0);
    await act(async () => keep?.click());
    await settle();
    expect(sent).toEqual([
      { command: "memory", action: "decide-all", workspaceId: "default", recordIds: ["p1", "p2", "s1", "u1", "t1"], decision: "keep" },
    ]);
    expect(announced()).toBe("Kept 2 · 3 needs a look.");
    expect(page.textContent).toContain("Saved · 2");
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
    await act(async () => named(page, "Undo: forget the 2 memories just kept")?.click());
    await settle();
    expect(sent.slice(1)).toEqual([
      { command: "memory", action: "forget", workspaceId: "default", recordId: "p1" },
      { command: "memory", action: "forget", workspaceId: "default", recordId: "p2" },
    ]);
    expect(announced()).toBe(`Forgotten 2. ${MEMORY_FORGET_UNREACHED}`);
    expect(page.textContent).not.toContain("Saved · 2");
    expect(done).toBe(2);
  });

  it("the Saved receipt's Undo names the memory provider the removals wait for", async () => {
    const { client: base } = bulkOwner();
    const client = {
      request: (command: string, payload: Record<string, unknown>) =>
        payload["action"] === "forget"
          ? Promise.resolve({ ok: true, result: { cleanupStatus: "pending", pendingProviders: ["acme.index"] } })
          : base.request(command as never, payload as never),
    } as unknown as SettingsClient;
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryBulkDecide items={items} onDone={() => undefined} />
      </InWorkspace>,
    );
    await act(async () => named(page, "Keep all: the 2 plain proposals listed")?.click());
    await settle();
    await act(async () => named(page, "Undo: forget the 2 memories just kept")?.click());
    await settle();
    expect(announced()).toBe(`Forgotten 2. ${MEMORY_FORGET_UNREACHED} It will be removed from acme.index when it next runs.`);
  });

  it("never counts one proposed after its chat read untrusted content as plain", async () => {
    const { client } = bulkOwner();
    const read = { integrity: "untrusted" as const, sources: ["web" as const], refs: [] };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryBulkDecide items={[...items, listed("w1", { provenance: read })]} onDone={() => undefined} />
      </InWorkspace>,
    );
    expect(named(page, "Keep all: the 2 plain proposals listed")).toBeDefined();
    const onlyRead = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryBulkDecide items={[listed("w2", { provenance: read })]} onDone={() => undefined} />
      </InWorkspace>,
    );
    expect([...onlyRead.querySelectorAll("button")].map((candidate) => candidate.textContent)).toEqual(["Discard all"]);
  });

  it("offers no Keep all when nothing listed is plain, and Discard all asks once, then discards every listed one", async () => {
    const { client, sent } = bulkOwner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryBulkDecide items={items.slice(2)} onDone={() => undefined} />
      </InWorkspace>,
    );
    expect([...page.querySelectorAll("button")].map((candidate) => candidate.textContent)).toEqual(["Discard all"]);
    await act(async () => named(page, "Discard all: the 3 proposals listed")?.click());
    // The way back takes focus, so a second Enter does not discard.
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(sent).toEqual([]);
    await act(async () =>
      [...page.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Discard all")?.click(),
    );
    await settle();
    expect(sent).toEqual([
      { command: "memory", action: "decide-all", workspaceId: "default", recordIds: ["s1", "u1", "t1"], decision: "discard" },
    ]);
    expect(announced()).toBe("Discarded 5.");
  });
});

/**
 * A memory card in the transcript:
 * read from the owner, its actions the `memory` IPC's own, each a button
 * named with its record, the heading a polite live region.
 */
describe("a memory card in the transcript", () => {
  const AT = "2026-10-11T08:00:00.000Z";
  const proposal = (number: number, recordId: string, title: string, overrides: Partial<MemoryCardItem> = {}): MemoryCardItem => ({
    token: `token-${recordId}`,
    number,
    recordId,
    state: "proposed",
    kind: "fact",
    target: "personal",
    sensitive: false,
    title,
    excerpt: null,
    currentRevisionId: `${recordId}-rev`,
    ...overrides,
  });

  /** An owner holding cards by notice id; approve, reject and forget change the record's state on every card. */
  function owner(cards: Record<string, MemoryCardAnswer>, options: { readonly failCorrect?: boolean } = {}) {
    const calls: Record<string, unknown>[] = [];
    const states = new Map<string, MemoryCardItem["state"]>();
    const forgotten = new Set<string>();
    const render = (card: MemoryCardAnswer): MemoryCardAnswer => {
      const items = card.items
        .filter((item) => !forgotten.has(item.recordId))
        .map((item) => ({ ...item, state: states.get(item.recordId) ?? item.state }));
      return { ...card, items, forgotten: card.forgotten + card.items.length - items.length };
    };
    const client: SettingsClient = {
      request: (command, payload) => {
        const body = payload as Record<string, unknown>;
        calls.push({ command, ...body });
        if (command !== "memory") return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "unexpected" } } as never);
        const recordId = String(body["recordId"]);
        switch (body["action"]) {
          case "card": {
            const card = cards[String(body["noticeId"])];
            return Promise.resolve(
              card === undefined
                ? ({ ok: false, error: { code: "NOT_FOUND", message: "no such card" } } as never)
                : ({ ok: true, result: render(card) } as never),
            );
          }
          case "card-all": {
            // The one *Keep all* rule, as the owner applies it: Keep all keeps the plain ones; Discard all every one.
            const card = cards[String(body["noticeId"])];
            const waiting = (card?.items ?? []).filter((each) => (states.get(each.recordId) ?? each.state) === "proposed");
            const keep = body["decision"] === "keep";
            const decided = keep ? waiting.filter((each) => !each.sensitive) : waiting;
            for (const each of decided) states.set(each.recordId, keep ? "saved" : "discarded");
            return Promise.resolve({
              ok: true,
              result: {
                kept: keep ? decided.length : 0,
                discarded: keep ? 0 : decided.length,
                needsLook: keep ? waiting.length - decided.length : 0,
              },
            } as never);
          }
          case "approve":
            states.set(recordId, "saved");
            break;
          case "reject":
            states.set(recordId, "discarded");
            break;
          // *Replace*: the kept record is corrected, and the proposal discarded as applied.
          case "replace":
            states.set(recordId, "discarded");
            break;
          case "get":
            return Promise.resolve({
              ok: true,
              result: {
                record: { ...item(recordId, "proposed"), body: "The person is vegetarian." },
                revisions: [],
                revisionCount: 1,
                reviews: [],
              },
            } as never);
          case "correct":
            if (options.failCorrect === true)
              return Promise.resolve({ ok: false, error: { code: "REVISION_CONFLICT", message: "The record changed meanwhile" } } as never);
            break;
          case "forget":
            forgotten.add(recordId);
            return Promise.resolve({
              ok: true,
              result: {
                deletionId: "d1",
                recordId,
                scopeKey: "k",
                deletionGeneration: 1,
                requestedBy: "operator",
                reason: String(body["reason"]),
                requestedAt: AT,
                cleanupStatus: "complete",
              },
            } as never);
          default:
            return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "unexpected" } } as never);
        }
        return Promise.resolve({ ok: true, result: item(recordId, String(body["action"])) } as never);
      },
    };
    return { client, calls, states };
  }
  /** A record as the owner answers it, its revision named after the action that made it. */
  const item = (recordId: string, action: string) => ({
    recordId,
    kind: "fact",
    scope: { kind: "personal", principalId: "operator" },
    scopeKey: "k",
    status: action === "proposed" ? "proposed" : "approved",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: AT,
    updatedAt: AT,
    currentRevisionId: `${recordId}-${action}`,
    target: "personal",
    title: null,
    body: null,
    redacted: false,
    truncated: false,
    sourceCount: 0,
  });

  const button = (page: HTMLElement, name: string): HTMLButtonElement => {
    const found = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  };

  it("lists a turn's proposals with Keep, Edit and Discard named by record; Keep approves at the revision shown and the card reads again", async () => {
    const { client, calls } = owner({
      n1: {
        noticeId: "n1",
        taskId: "chat",
        title: "2 things to remember",
        items: [proposal(1, "r1", "You're vegetarian"), proposal(2, "r2", "Lives in Lisbon", { target: "chat:chat" })],
        forgotten: 0,
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="n1" />
      </InWorkspace>,
    );
    expect(page.querySelector('[role="status"]')?.textContent).toBe("2 things to remember");
    for (const name of [
      "Keep: You're vegetarian",
      "Edit: You're vegetarian",
      "Discard: You're vegetarian",
      "Keep: Lives in Lisbon",
      "Discard: Lives in Lisbon",
    ])
      expect(button(page, name)).toBeDefined();
    await act(async () => button(page, "Keep: You're vegetarian").click());
    await settle();
    expect(calls).toContainEqual({
      command: "memory",
      action: "approve",
      workspaceId: "default",
      recordId: "r1",
      expectedRevisionId: "r1-rev",
    });
    expect(page.textContent).toContain("Saved");
    expect(button(page, "Undo: You're vegetarian")).toBeDefined();
    expect(page.querySelector('[role="status"]')?.textContent).toBe("1 thing to remember");
  });

  it("Undo on a saved record forgets it, and the card then says it was forgotten without its text", async () => {
    const { client, calls } = owner({
      n1: {
        noticeId: "n1",
        taskId: "chat",
        title: "1 thing to remember",
        items: [proposal(1, "r1", "You're vegetarian", { state: "saved" })],
        forgotten: 0,
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="n1" />
      </InWorkspace>,
    );
    expect(page.querySelector('[role="status"]')?.textContent).toBe("Saved");
    await act(async () => button(page, "Undo: You're vegetarian").click());
    await settle();
    expect(calls).toContainEqual(expect.objectContaining({ action: "forget", recordId: "r1" }));
    expect(page.querySelector('[role="status"]')?.textContent).toBe("Forgotten");
    expect(page.textContent).not.toContain("vegetarian");
  });

  it("Edit loads the whole body, then Save and keep approves and corrects at the approved revision, and the card reads again", async () => {
    const { client, calls } = owner({
      n1: { noticeId: "n1", taskId: "chat", title: "1 thing to remember", items: [proposal(1, "r1", "You're vegetarian")], forgotten: 0 },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="n1" />
      </InWorkspace>,
    );
    await act(async () => button(page, "Edit: You're vegetarian").click());
    await settle();
    expect(calls).toContainEqual({ command: "memory", action: "get", workspaceId: "default", recordId: "r1" });
    const textarea = page.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea === null) throw new Error("no edit field");
    expect(textarea.value).toBe("The person is vegetarian.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "The person is vegan.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const reads = calls.filter((call) => call["action"] === "card").length;
    await act(async () => button(page, "Save and keep").click());
    await settle();
    const decided = calls.filter((call) => call["action"] === "approve" || call["action"] === "correct");
    expect(decided).toEqual([
      { command: "memory", action: "approve", workspaceId: "default", recordId: "r1", expectedRevisionId: "r1-rev" },
      {
        command: "memory",
        action: "correct",
        workspaceId: "default",
        recordId: "r1",
        expectedRevisionId: "r1-approve",
        body: "The person is vegan.",
      },
    ]);
    expect(calls.filter((call) => call["action"] === "card").length).toBe(reads + 1);
    expect(page.querySelector("textarea")).toBeNull();
    expect(page.textContent).toContain("Saved");
  });

  it("says the proposal was kept but the edit not saved when the correction fails", async () => {
    const { client } = owner(
      {
        n1: { noticeId: "n1", taskId: "chat", title: "1 thing to remember", items: [proposal(1, "r1", "You're vegetarian")], forgotten: 0 },
      },
      { failCorrect: true },
    );
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="n1" />
      </InWorkspace>,
    );
    await act(async () => button(page, "Edit: You're vegetarian").click());
    await settle();
    await act(async () => button(page, "Save and keep").click());
    await settle();
    expect(page.textContent).toContain("Kept as proposed; the edit was not saved: The record changed meanwhile");
  });

  it("reads the card again when its version moves, so a record decided elsewhere shows its new state", async () => {
    const { client, states } = owner({
      n1: { noticeId: "n1", taskId: "chat", title: "1 thing to remember", items: [proposal(1, "r1", "You're vegetarian")], forgotten: 0 },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="n1" version={`${AT}|1`} />
      </InWorkspace>,
    );
    expect(button(page, "Keep: You're vegetarian")).toBeDefined();
    // Kept in the chat panel's Memory tab: the workspace memory revision moves.
    states.set("r1", "saved");
    await rerender(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="n1" version={`${AT}|2`} />
      </InWorkspace>,
    );
    await settle();
    expect(page.querySelector('[role="status"]')?.textContent).toBe("Saved");
    expect(button(page, "Undo: You're vegetarian")).toBeDefined();
  });

  it("a digest says what it said when sent, how many more wait, and offers Keep all, Discard all and Review; Keep all keeps the plain ones only", async () => {
    const digest: MemoryCardAnswer = {
      noticeId: "d1",
      taskId: "home",
      title: "2 of 12 things waiting to be remembered — the oldest expires Thu 15 Oct",
      items: [proposal(1, "r1", "You're vegetarian"), proposal(2, "r2", "", { sensitive: true, title: null })],
      forgotten: 0,
      digest: { waiting: 12 },
    };
    const { client, calls, states } = owner({ d1: digest });
    let reviewed = 0;
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard
          noticeId="d1"
          onReview={() => {
            reviewed += 1;
          }}
        />
      </InWorkspace>,
    );
    expect(page.querySelector('[role="status"]')?.textContent).toBe(
      "2 of 12 things waiting to be remembered — the oldest expires Thu 15 Oct",
    );
    expect(page.textContent).toContain("and 10 more");
    expect(page.textContent).not.toContain("vegetarian diet");
    await act(async () => button(page, "Review").click());
    expect(reviewed).toBe(1);
    await act(async () => button(page, "Keep all").click());
    await settle();
    expect(calls).toContainEqual({ command: "memory", action: "card-all", workspaceId: "default", noticeId: "d1", decision: "keep" });
    expect(states.get("r1")).toBe("saved");
    expect(states.get("r2")).toBeUndefined();
    expect(page.textContent).toContain("Kept 1 · 1 needs a look — open Tavi to review.");
    // Only the sensitive one waits: no Keep all, still Discard all.
    expect([...page.querySelectorAll("button")].map((each) => each.textContent)).not.toContain("Keep all");
    await act(async () => button(page, "Discard all").click());
    await settle();
    expect(states.get("r2")).toBe("discarded");
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("an update says what it updates and offers Replace and, a fact, Keep both — never Keep or Edit; Replace is held to the revisions shown", async () => {
    const updates = { recordId: "kept-1", title: "Reply in Spanish", currentRevisionId: "kept-1-rev" };
    const { client, calls, states } = owner({
      n1: {
        noticeId: "n1",
        taskId: "chat",
        title: "3 things to remember",
        forgotten: 0,
        items: [
          proposal(1, "r1", "Reply in French", { kind: "preference", updates }),
          proposal(2, "r2", "Lives in Porto", {
            mayUpdate: { recordId: "kept-2", title: "Lives in Lisbon", currentRevisionId: "kept-2-rev" },
          }),
          proposal(3, "r3", "Has two cats", { similarTo: { recordId: "kept-3", title: "Has two cats and a dog" } }),
        ],
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="n1" />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("updates: Reply in Spanish");
    expect(page.textContent).toContain("may update: Lives in Lisbon");
    expect(page.textContent).toContain("similar to: Has two cats and a dog");
    const names = [...page.querySelectorAll("button")].map((candidate) => candidate.getAttribute("aria-label") ?? candidate.textContent);
    expect(names).toEqual(
      expect.arrayContaining([
        "Replace: Reply in French",
        "Discard: Reply in French",
        "Replace: Lives in Porto",
        "Keep both: Lives in Porto",
        "Keep: Has two cats",
      ]),
    );
    // A preference's update has no Keep both; neither update has Keep or Edit.
    for (const absent of [
      "Keep both: Reply in French",
      "Keep: Reply in French",
      "Edit: Reply in French",
      "Keep: Lives in Porto",
      "Edit: Lives in Porto",
    ])
      expect(names).not.toContain(absent);
    await act(async () => button(page, "Replace: Reply in French").click());
    await settle();
    expect(calls).toContainEqual({
      command: "memory",
      action: "replace",
      workspaceId: "default",
      recordId: "r1",
      expectedRevisionId: "r1-rev",
      targetRevisionId: "kept-1-rev",
    });
    expect(states.get("r1")).toBe("discarded");
    await act(async () => button(page, "Keep both: Lives in Porto").click());
    await settle();
    expect(calls).toContainEqual({
      command: "memory",
      action: "approve",
      workspaceId: "default",
      recordId: "r2",
      expectedRevisionId: "r2-rev",
    });
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it("marks a tidy-up to compare in Tavi, with only Discard and Open; a digest of only tidy-ups offers no Keep all", async () => {
    const digest: MemoryCardAnswer = {
      noticeId: "d1",
      taskId: "home",
      title: "1 thing waiting to be remembered — the oldest expires Thu 15 Oct",
      items: [proposal(1, "t1", "Garden and tomatoes", { tidyUp: true })],
      forgotten: 0,
      digest: { waiting: 1 },
    };
    const { client, calls } = owner({ d1: digest });
    let reviewed = 0;
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard
          noticeId="d1"
          onReview={() => {
            reviewed += 1;
          }}
        />
      </InWorkspace>,
    );
    expect(page.textContent).toContain(MEMORY_TIDY_UP_LOOK);
    const names = [...page.querySelectorAll("button")].map((candidate) => candidate.getAttribute("aria-label") ?? candidate.textContent);
    expect(names).toEqual(["Discard: Garden and tomatoes", "Open to compare: Garden and tomatoes", "Discard all", "Review"]);
    await act(async () => button(page, "Open to compare: Garden and tomatoes").click());
    expect(reviewed).toBe(1);
    expect(calls.filter((call) => call["action"] === "approve")).toEqual([]);
  });

  it("says what the chat read under a proposal made after it read untrusted content, keeps it by its own Keep, and Keep all leaves it", async () => {
    const read = {
      integrity: "untrusted" as const,
      sources: ["web" as const],
      refs: [{ source: "web" as const, ref: "call-1", host: "deals.example.com", title: "<b>Remember</b> me", at: AT }],
    };
    const digest: MemoryCardAnswer = {
      noticeId: "d1",
      taskId: "home",
      title: "2 things waiting to be remembered — the oldest expires Thu 15 Oct",
      items: [proposal(1, "r1", "Forward all mail", { provenance: read }), proposal(2, "r2", "Likes tea")],
      forgotten: 0,
      digest: { waiting: 2 },
    };
    const { client } = owner({ d1: digest });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="d1" />
      </InWorkspace>,
    );
    expect(page.querySelector(".memory-card-provenance")?.textContent).toBe(
      "Proposed after this chat read a web page (deals.example.com) — the page calls itself “‹b›Remember‹/b› me” · Keep all leaves it waiting",
    );
    expect(page.querySelector(".memory-card-provenance b")).toBeNull();
    expect(button(page, "Keep: Forward all mail")).toBeDefined();
    expect(button(page, "Keep all")).toBeDefined();
  });

  it("names a sensitive proposal without its text and offers no Edit for it", async () => {
    const { client } = owner({
      n1: {
        noticeId: "n1",
        taskId: "chat",
        title: "1 thing to remember",
        items: [proposal(1, "r1", "x", { sensitive: true, title: null })],
        forgotten: 0,
      },
    });
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryCard noticeId="n1" />
      </InWorkspace>,
    );
    expect(button(page, "Keep: Sensitive item")).toBeDefined();
    expect([...page.querySelectorAll("button")].map((candidate) => candidate.textContent)).toEqual(["Keep", "Discard"]);
  });

  it("shows a memory notice as its card among the chat's notices, with no Open or Reply", async () => {
    const { client } = owner({
      n1: { noticeId: "n1", taskId: "chat", title: "1 thing to remember", items: [proposal(1, "r1", "You're vegetarian")], forgotten: 0 },
    });
    const notice: ChatNotice = {
      noticeId: "n1",
      taskId: "chat",
      kind: "memory",
      title: "1 thing to remember",
      summary: "",
      afterSeq: 1,
      createdAt: AT,
    };
    const page = await mount(
      <NoticeCards
        notices={[notice]}
        connected
        onOpen={() => undefined}
        onReply={() => undefined}
        memoryCard={(shown) => (
          <InWorkspace client={client} workspaceId="default">
            <MemoryCard noticeId={shown.noticeId} />
          </InWorkspace>
        )}
      />,
    );
    expect(page.querySelector('[data-notice-kind="memory"] [role="status"]')?.textContent).toBe("Proposed · remember everywhere");
    expect(page.textContent).not.toContain("Reply in a side chat");
  });

  it("has no WCAG 2.1 A/AA violations axe can find in a transcript with an open and a settled card", async () => {
    const { client } = owner({
      open: {
        noticeId: "open",
        taskId: "chat",
        title: "2 things to remember",
        items: [proposal(1, "r1", "You're vegetarian"), proposal(2, "r2", "Lives in Lisbon")],
        forgotten: 0,
      },
      settled: {
        noticeId: "settled",
        taskId: "chat",
        title: "1 thing to remember",
        items: [proposal(1, "r3", "Prefers metric units", { state: "discarded" })],
        forgotten: 0,
      },
    });
    const notices: ChatNotice[] = ["open", "settled"].map((noticeId, index) => ({
      noticeId,
      taskId: "chat",
      kind: "memory",
      title: "card",
      summary: "",
      afterSeq: index,
      createdAt: AT,
    }));
    const page = await mount(
      <main>
        <NoticeCards
          notices={notices}
          connected
          memoryCard={(shown) => (
            <InWorkspace client={client} workspaceId="default">
              <MemoryCard noticeId={shown.noticeId} />
            </InWorkspace>
          )}
        />
      </main>,
    );
    expect(page.querySelectorAll(".memory-card")).toHaveLength(2);
    expect(page.textContent).toContain("Discarded");
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});

/**
 * What an answer used: a quiet
 * "Used N memories" chip under the answer, a disclosure button that opens to
 * the records read from the owner now, each with Forget and Correct.
 */
describe("the memory an answer used", () => {
  const AT = "2026-10-11T08:00:00.000Z";
  const record = (recordId: string, title: string, overrides: Record<string, unknown> = {}) => ({
    recordId,
    kind: "fact",
    scope: { kind: "personal", principalId: "operator" },
    scopeKey: "k",
    status: "approved",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: AT,
    updatedAt: AT,
    currentRevisionId: `${recordId}-rev`,
    originTaskId: "chat-0",
    target: "personal",
    title,
    body: `${title}.`,
    redacted: false,
    truncated: false,
    sourceCount: 0,
    ...overrides,
  });

  /** An owner answering one turn's use; forget takes a record off it, counted as forgotten. */
  function owner(
    records: readonly ReturnType<typeof record>[],
    preferences = 0,
    listed: readonly ReturnType<typeof record>[] = [],
    listedCount = listed.length,
  ) {
    const calls: Record<string, unknown>[] = [];
    const forgotten = new Set<string>();
    const client: SettingsClient = {
      request: (command, payload) => {
        const body = payload as Record<string, unknown>;
        calls.push({ command, ...body });
        if (command !== "memory") return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "unexpected" } } as never);
        switch (body["action"]) {
          case "list": {
            const shown = records.filter((item) => !forgotten.has(item.recordId));
            return Promise.resolve({
              ok: true,
              result: {
                records: shown,
                ...(listedCount === 0 ? {} : { listed }),
                otherPeople: [],
                used: {
                  recorded: true,
                  used: records.length,
                  forgotten: records.length - shown.length,
                  preferences,
                  ...(listedCount === 0 ? {} : { listed: { count: listedCount, forgotten: 0 } }),
                },
              },
            } as never);
          }
          case "forget":
            forgotten.add(String(body["recordId"]));
            return Promise.resolve({
              ok: true,
              result: {
                deletionId: "d1",
                recordId: String(body["recordId"]),
                scopeKey: "k",
                deletionGeneration: 1,
                requestedBy: "operator",
                reason: String(body["reason"]),
                requestedAt: AT,
                cleanupStatus: "complete",
              },
            } as never);
          case "get":
            return Promise.resolve({
              ok: true,
              result: { record: records.find((item) => item.recordId === body["recordId"]), revisions: [], revisionCount: 1, reviews: [] },
            } as never);
          case "correct":
            return Promise.resolve({
              ok: true,
              result: { ...records.find((item) => item.recordId === body["recordId"]), body: String(body["body"]) },
            } as never);
          default:
            return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "unexpected" } } as never);
        }
      },
    };
    return { client, calls };
  }
  const used = (count: number, more = 0) => ({
    records: Array.from({ length: count }, (_, index) => ({ recordId: `r${index + 1}`, revisionId: `r${index + 1}-rev` })),
    preferences: 1,
    more,
  });
  const button = (page: HTMLElement, name: string): HTMLButtonElement => {
    const found = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
    );
    if (found === undefined) throw new Error(`no button named ${name}`);
    return found;
  };

  it("is a collapsed disclosure button named with the count; opening it reads that turn's use and lists title, kind, scope, date and source chat", async () => {
    const { client, calls } = owner(
      [
        record("r1", "You're vegetarian"),
        record("r2", "Lives in Lisbon", { target: "chat:chat-1", originTaskId: undefined }),
        record("r3", "Diet", { body: "I'm vegetarian." }),
      ],
      1,
    );
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <MemoryUsed taskId="chat-1" seq={4} used={used(2)} />
      </InWorkspace>,
    );
    const chip = button(page, "Used 2 memories");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    // Nothing is read until it is opened.
    expect(calls).toEqual([]);
    await act(async () => chip.click());
    await settle();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(chip.getAttribute("aria-controls") ?? "")).not.toBeNull();
    expect(calls).toEqual([
      {
        command: "memory",
        action: "list",
        workspaceId: "default",
        usedInTurn: { taskId: "chat-1", seq: 4 },
        statuses: ["approved"],
        limit: 100,
      },
    ]);
    expect(page.textContent).toContain("You're vegetarian");
    // The day as the rest of the canvas says it, and what a titled memory says under its title.
    expect(page.textContent).toMatch(/fact · everywhere · Sun 11 Oct( 2026)? · from chat chat-0/);
    expect(page.textContent).toMatch(/fact · this chat's notes · Sun 11 Oct( 2026)?/);
    expect(page.textContent).not.toContain("2026-10-11");
    const diet = [...page.querySelectorAll(".memory-used-item")].find((item) => item.textContent?.includes("Diet"));
    expect(diet?.querySelector(".memory-used-body")?.textContent).toBe("I'm vegetarian.");
    // A body that only repeats its title is not said twice.
    const veg = [...page.querySelectorAll(".memory-used-item")].find((item) => item.textContent?.includes("You're vegetarian"));
    expect(veg?.querySelector(".memory-used-body")).toBeNull();
    expect(page.textContent).toContain("1 preference applied");
    for (const name of ["Forget: You're vegetarian", "Correct: You're vegetarian", "Forget: Lives in Lisbon"])
      expect(button(page, name)).toBeDefined();
  });

  it("a turn that only listed says Looked through, and opens to those records", async () => {
    const { client } = owner([], 0, [record("r1", "Has a cat called Miso"), record("r2", "Drives an old Volvo")], 3);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <MemoryUsed taskId="chat-1" seq={4} used={{ records: [], preferences: 0, more: 0, listed: { records: [], more: 3 } }} />
      </InWorkspace>,
    );
    await act(async () => button(page, "Looked through 3 memories").click());
    await settle();
    expect(page.textContent).toContain("Drives an old Volvo");
    expect(page.textContent).toContain("and 1 more not listed");
    expect(button(page, "Forget: Has a cat called Miso")).toBeDefined();
    expect(page.textContent).not.toContain("Used ");
  });

  it("a turn that did both says both, and heads what it only looked through", async () => {
    const { client } = owner([record("r1", "Loves thoughtful science fiction")], 0, [record("r2", "Drives an old Volvo")]);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <MemoryUsed taskId="chat-1" seq={4} used={{ records: [], preferences: 0, more: 1, listed: { records: [], more: 1 } }} />
      </InWorkspace>,
    );
    await act(async () => button(page, "Used 1 memory · looked through 1 more").click());
    await settle();
    const words = page.textContent ?? "";
    expect(words.indexOf("Loves thoughtful science fiction")).toBeLessThan(words.lastIndexOf("Looked through 1 more"));
    expect(words.lastIndexOf("Looked through 1 more")).toBeLessThan(words.indexOf("Drives an old Volvo"));
  });

  it("Forget erases the record from the list, reads it again, and says how many are forgotten since", async () => {
    const { client, calls } = owner([record("r1", "You're vegetarian"), record("r2", "Lives in Lisbon")]);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <MemoryUsed taskId="chat-1" seq={4} used={used(2)} />
      </InWorkspace>,
    );
    await act(async () => button(page, "Used 2 memories").click());
    await settle();
    await act(async () => button(page, "Forget: You're vegetarian").click());
    await settle();
    expect(calls.filter((call) => call["action"] === "forget")).toEqual([
      { command: "memory", action: "forget", workspaceId: "default", recordId: "r1", reason: "forgotten from an answer's memory list" },
    ]);
    expect(page.textContent).not.toContain("You're vegetarian");
    expect(page.textContent).toContain("1 forgotten since");
  });

  it("Correct loads the whole body and saves the person's words at the revision shown", async () => {
    const { client, calls } = owner([record("r1", "You're vegetarian")]);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <MemoryUsed taskId="chat-1" seq={4} used={used(1)} />
      </InWorkspace>,
    );
    await act(async () => button(page, "Used 1 memory").click());
    await settle();
    await act(async () => button(page, "Correct: You're vegetarian").click());
    await settle();
    const box = page.querySelector<HTMLTextAreaElement>("textarea");
    expect(box?.labels?.[0]?.textContent).toBe("Correct: You're vegetarian");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(box, "The person is vegan.");
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(page, "Save").click());
    await settle();
    expect(calls.filter((call) => call["action"] === "correct")).toEqual([
      {
        command: "memory",
        action: "correct",
        workspaceId: "default",
        recordId: "r1",
        expectedRevisionId: "r1-rev",
        body: "The person is vegan.",
      },
    ]);
  });

  it("shows nothing for an answer that used no memory, and counts those past the 20 a turn names", async () => {
    const { client } = owner([]);
    const empty = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <MemoryUsed taskId="chat-1" seq={4} used={{ records: [], preferences: 3, more: 0 }} />
      </InWorkspace>,
    );
    expect(empty.querySelector("button")).toBeNull();
    unmountAll();
    const many = await mount(
      <InWorkspace client={client} workspaceId="default" timeZone="UTC">
        <MemoryUsed taskId="chat-1" seq={4} used={used(20, 5)} />
      </InWorkspace>,
    );
    expect(button(many, "Used 25 memories")).toBeDefined();
  });

  it("has no WCAG 2.1 A/AA violations axe can find, closed and open, and every action is a named button", async () => {
    const { client } = owner([
      record("r1", "You're vegetarian"),
      record("r2", "Health note", { redacted: true, title: null, body: null, sensitivity: "sensitive" }),
    ]);
    const page = await mount(
      <main>
        <InWorkspace client={client} workspaceId="default" timeZone="UTC">
          <MemoryUsed taskId="chat-1" seq={4} used={used(2)} />
        </InWorkspace>
      </main>,
    );
    const rules = {
      runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    };
    expect((await axe.run(page, rules)).violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    await act(async () => button(page, "Used 2 memories").click());
    await settle();
    // A sensitive record is never named, and offers no Correct.
    expect(button(page, "Forget: Sensitive item")).toBeDefined();
    expect(() => button(page, "Correct: Sensitive item")).toThrow();
    expect((await axe.run(page, rules)).violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});

describe("a heartbeat item that used memory", () => {
  const AT = "2026-10-11T08:00:00.000Z";
  const item = {
    itemId: "i1",
    workspaceId: "default",
    principalId: "operator",
    key: "k",
    hash: "h",
    signalKeys: [],
    urgency: "now",
    heldBack: false,
    title: "Your train leaves at 9",
    sources: [{ label: "Calendar" }],
    state: "told",
    firstToldAt: AT,
    lastToldAt: AT,
    updatedAt: AT,
  };
  const client = (because?: readonly string[]): SettingsClient => ({
    request: (command, payload) => {
      const body = payload as Record<string, unknown>;
      if (command === "heartbeat" && body["action"] === "item")
        return Promise.resolve({ ok: true, result: { item, ...(because === undefined ? {} : { because }) } } as never);
      return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "unexpected" } } as never);
    },
  });

  it("names up to two memories the check was given, and none when the owner names none", async () => {
    const page = await mount(
      <InWorkspace client={client(["Travelling to Lisbon until Friday", "Prefers trains"])} workspaceId="default">
        <HeartbeatItemCard itemId="i1" timeZone="UTC" />
      </InWorkspace>,
    );
    expect(page.querySelector(".heartbeat-item-because")?.textContent).toBe(
      "Because you said: “Travelling to Lisbon until Friday”, “Prefers trains”",
    );
    unmountAll();
    const plain = await mount(
      <InWorkspace client={client()} workspaceId="default">
        <HeartbeatItemCard itemId="i1" timeZone="UTC" />
      </InWorkspace>,
    );
    expect(plain.querySelector(".heartbeat-item-because")).toBeNull();
  });
});

describe("a chat's memory in its header", () => {
  const AXE = {
    runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  };
  const client = {} as SettingsClient;
  /** The owner's side of a press: each save changes the chat's mode and answers it. */
  function owner() {
    const saves: ("on" | "off")[] = [];
    const save = async (_client: SettingsClient, _workspaceId: string, _taskId: string, next: "on" | "off") => {
      saves.push(next);
      const answer: ChatContextAnswer = {
        taskId: "chat-1",
        revision: 0,
        current: null,
        ...(next === "off" ? { memoryMode: "off" as const } : {}),
      };
      return { ok: true as const, value: answer };
    };
    return { saves, save };
  }

  it("turns the chat's memory off and back on from a named button, its words said as text", async () => {
    const fixture = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryModeToggle taskId="chat-1" mode={undefined} save={fixture.save} />
      </InWorkspace>,
    );
    const button = (): HTMLButtonElement => page.querySelector("button.memory-mode") as HTMLButtonElement;
    expect(button().textContent).toContain("Memory on");
    expect(button().getAttribute("aria-label")).toBe("Memory on: turn it off for this chat");
    await act(async () => button().click());
    await settle();
    expect(fixture.saves).toEqual(["off"]);
    expect(button().textContent).toContain("Memory off");
    expect(button().classList.contains("memory-mode-off")).toBe(true);
    expect(button().getAttribute("aria-label")).toBe("Memory off: turn it on for this chat");
    await act(async () => button().click());
    await settle();
    expect(fixture.saves).toEqual(["off", "on"]);
    expect(button().textContent).toContain("Memory on");
  });

  it("shows a private chat as a label with its words, never a button: private is never lifted", async () => {
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <MemoryModeToggle taskId="chat-1" mode="private" save={owner().save} />
      </InWorkspace>,
    );
    expect(page.querySelector("button")).toBeNull();
    expect(page.querySelector(".memory-mode-private")?.textContent).toContain(memoryModeLabel("private"));
    expect(page.querySelector(".memory-mode-private")?.getAttribute("title")).toMatch(/forgotten about a day after its last/);
  });

  it("offers New private chat beside the new chat's +, by its name", async () => {
    let asked = 0;
    const page = await mount(
      <SidebarFrame
        onNew={() => undefined}
        onNewPrivate={() => {
          asked += 1;
        }}
      >
        <p>chats</p>
      </SidebarFrame>,
    );
    const button = [...page.querySelectorAll("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === NEW_PRIVATE_CHAT_LABEL || candidate.textContent?.includes(NEW_PRIVATE_CHAT_LABEL),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(asked).toBe(1);
  });

  it("the header toggle and the private label have text labels and no WCAG 2.1 A/AA violations axe can find", async () => {
    for (const mode of [undefined, "off", "private"] as const) {
      const page = await mount(
        <header className="task-header">
          <h1>A chat</h1>
          <InWorkspace client={client} workspaceId="default">
            <MemoryModeToggle taskId="chat-1" mode={mode} save={owner().save} />
          </InWorkspace>
        </header>,
      );
      expect(page.textContent).toContain(memoryModeLabel(mode));
      expect((await axe.run(page, AXE)).violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
      unmountAll();
    }
  });
});
