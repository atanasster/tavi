// @vitest-environment jsdom
import type { SkillActivationHistoryEntry, SkillVersion } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { SkillsPane } from "../../../src/features/center/Skills.js";
import { requestSkillFocus } from "../../../src/features/center/skills-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { button, clickSettled as click, mountSettled as mount } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * Soul & memory → Skills, reviewing an agent's proposal: the tool trace of
 * the task it came from, what its turn read that Tavi does not trust, Edit
 * (a new proposed version following it) and Regenerate-with-feedback (the
 * feedback sent to its chat as the person's message), and a chat card's
 * *Review* opening it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-10-27T12:00:00.000Z";

const proposal = (overrides: Partial<SkillVersion> = {}): SkillVersion => ({
  skillId: "weekly-report",
  version: "proposed-20261027120000",
  contentHash: "a".repeat(64),
  scopeKey: "default",
  manifest: {
    name: "Weekly report",
    description: "How the weekly report is written",
    proposal: { taskId: "chat-1", note: "The person confirmed it", requested: true },
  },
  provenance: "chat:chat-1",
  reviewState: "proposed",
  packageArtifactId: "artifact-1",
  importedBy: "operator",
  importedAt: AT,
  ...overrides,
});

/** An owner holding `versions`: it answers the Skills page's reads and records what was asked. */
function owner(versions: SkillVersion[], texts: Record<string, string> = {}, history: SkillActivationHistoryEntry[] = []) {
  const asked: { command: string; payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const body = payload as Record<string, unknown>;
      asked.push({ command, payload: body });
      const find = () => versions.find((version) => version.skillId === body["skillId"] && version.version === body["version"]);
      if (command === "reply") return { ok: true, result: { taskId: body["taskId"], conversationId: "c", duplicate: false } } as never;
      switch (body["action"]) {
        case "list":
          return { ok: true, result: { versions, activations: [], usage: [] } } as never;
        case "show":
          return {
            ok: true,
            result: { versions: versions.filter((version) => version.skillId === body["skillId"]), history },
          } as never;
        case "body": {
          const version = find();
          return { ok: true, result: { version, text: texts[version?.version ?? ""] ?? "1. Gather.\n2. Check." } } as never;
        }
        case "trace":
          return {
            ok: true,
            result: {
              taskId: "chat-1",
              calls: [
                { toolName: "web_fetch", input: '{"url":"https://example.com/report"}', status: "completed" },
                { toolName: "sandbox.run", input: '{"command":"wc -l"}', status: "failed" },
              ],
              more: 3,
              partial: false,
            },
          } as never;
        case "edit": {
          const edited = proposal({
            version: "edited-20261027130000",
            parentVersion: body["version"] as string,
            importedAt: "2026-10-27T13:00:00.000Z",
          });
          const original = find();
          if (original !== undefined) versions.splice(versions.indexOf(original), 1, { ...original, reviewState: "rejected" });
          versions.push(edited);
          texts[edited.version] = body["body"] as string;
          return { ok: true, result: { version: edited, replaced: body["version"] } } as never;
        }
        default:
          return { ok: true, result: {} } as never;
      }
    },
  };
  return { client, asked };
}

async function type(element: Element | null | undefined, value: string): Promise<void> {
  if (!(element instanceof HTMLTextAreaElement)) throw new Error("nothing to type into");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const openProposal = async (page: HTMLElement): Promise<void> => {
  const opener = [...page.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes("weekly-report@proposed-20261027120000"),
  );
  await click(opener);
};

describe("reviewing an agent's skill proposal", () => {
  it("shows the source task's tool calls, condensed", async () => {
    const { client } = owner([proposal()]);
    const page = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(page);
    const calls = [...page.querySelectorAll(".soul-skill-trace-calls li")].map((item) => item.textContent);
    expect(calls).toEqual(['web_fetch {"url":"https://example.com/report"}', 'sandbox.run {"command":"wc -l"} — failed']);
    expect(page.querySelector(".soul-skill-trace summary")?.textContent).toBe("What the task did (5 tool calls)");
    expect(page.textContent).toContain("… and 3 more");
  });

  it("names what an asked-for proposal's turn read that Tavi does not trust, and says nothing for a clean turn", async () => {
    const tainted = proposal({
      manifest: {
        name: "Weekly report",
        proposal: {
          taskId: "chat-1",
          note: "ok",
          requested: true,
          untrusted: { integrity: "untrusted", sources: ["web"], refs: [{ source: "web", ref: "call-1", host: "example.com", at: AT }] },
        },
      },
    });
    const { client } = owner([tainted]);
    const page = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(page);
    const banner = page.querySelector(".skill-untrusted");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toMatch(/^Proposed after this chat read a web page \(example\.com\)\. Parts of this text may come from/);

    const clean = owner([proposal()]);
    const other = await mount(
      <InWorkspace client={clean.client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(other);
    expect(other.querySelector(".skill-untrusted")).toBeNull();
  });

  it("files an edit as a new proposed version following the proposal, and opens it", async () => {
    const { client, asked } = owner([proposal()]);
    const page = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(page);
    await click(button(page, "Edit"));
    const box = page.querySelector(".soul-skill-edit textarea");
    expect((box as HTMLTextAreaElement).value).toBe("1. Gather.\n2. Check.");
    // Unchanged, there is nothing to save.
    expect(button(page, "Save as a new version")?.disabled).toBe(true);
    await type(box, "1. Gather.\n2. Check the totals twice.");
    await click(button(page, "Save as a new version"));
    expect(asked.find((entry) => entry.payload["action"] === "edit")?.payload).toEqual({
      action: "edit",
      workspaceId: "default",
      skillId: "weekly-report",
      version: "proposed-20261027120000",
      body: "1. Gather.\n2. Check the totals twice.",
    });
    expect(page.querySelector(".soul-skill-viewer h3")?.textContent).toBe("weekly-report@edited-20261027130000");
    expect(page.querySelector(".soul-skill-viewer")?.textContent).toContain("Check the totals twice");
  });

  it("sends feedback to the chat the proposal came from, as the person's message asking to propose again", async () => {
    const { client, asked } = owner([proposal()]);
    const page = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(page);
    await click(button(page, "Regenerate with feedback"));
    expect(button(page, "Send feedback")?.disabled).toBe(true);
    await type(page.querySelector(".soul-skill-feedback textarea"), "Use the finance sheet, not the email.");
    await click(button(page, "Send feedback"));
    const reply = asked.find((entry) => entry.command === "reply")?.payload;
    expect(reply).toMatchObject({ workspaceId: "default", taskId: "chat-1", clientMessageId: expect.stringMatching(/^skill-feedback-/) });
    expect(reply?.["text"]).toContain('propose the skill "Weekly report" (weekly-report) again with skills.propose');
    expect(reply?.["text"]).toContain("Use the finance sheet, not the email.");
    expect(page.querySelector(".soul-skill-viewer [role=status]")?.textContent).toMatch(/^Sent to chat chat-1 as your message/);
  });

  it("says each activation as a local time and what changed, not a raw UTC timestamp", async () => {
    const entry = (overrides: Partial<SkillActivationHistoryEntry>): SkillActivationHistoryEntry => ({
      historyId: "h-1",
      scopeKey: "default",
      skillId: "weekly-report",
      reason: "activate",
      newVersion: "proposed-20261027120000",
      actor: "operator",
      at: AT,
      ...overrides,
    });
    const { client } = owner([proposal()], {}, [
      entry({ historyId: "h-2", previousVersion: "1.0.0", at: "2026-10-27T12:30:00.000Z" }),
      entry({ historyId: "h-1", newVersion: "1.0.0" }),
    ]);
    const page = await mount(
      <InWorkspace client={client} timeZone="Europe/Lisbon">
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(page);
    const lines = [...page.querySelectorAll("section[aria-label='Activation history'] li")].map((item) => item.textContent);
    expect(lines).toEqual([
      "Tue 27 Oct 12:30 · Activated proposed-20261027120000 (was 1.0.0) · operator",
      "Tue 27 Oct 12:00 · Activated 1.0.0 · operator",
    ]);
    expect(page.querySelector("section[aria-label='Activation history'] time")?.getAttribute("dateTime")).toBe("2026-10-27T12:30:00.000Z");
  });

  it("lets a long hash wrap inside the card, and makes the text panel a named region a keyboard reaches", async () => {
    const { client } = owner([proposal()]);
    const page = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(page);
    expect(page.querySelector(".soul-skill-viewer .soul-skill-hash")?.textContent).toBe("a".repeat(64));
    const panel = page.querySelector(".soul-skill-body");
    expect(panel?.getAttribute("tabindex")).toBe("0");
    expect(panel?.getAttribute("role")).toBe("region");
    expect(panel?.getAttribute("aria-label")).toBe("SKILL.md text");
  });

  it("asks once before approving another author's archive, and approves your own import in one click", async () => {
    const archive = proposal({ provenance: "archive:weekly-report", manifest: { name: "Weekly report" } });
    const { client, asked } = owner([archive]);
    const page = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(page);
    const approvals = () => asked.filter((entry) => entry.payload["action"] === "approve");
    await click(button(page, "Approve"));
    expect(approvals()).toEqual([]);
    const dialog = document.querySelector("dialog");
    expect(dialog?.textContent).toContain("archive:weekly-report");
    await click([...(dialog?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent === "Cancel"));
    expect(document.querySelector("dialog")).toBeNull();
    expect(approvals()).toEqual([]);
    await click(button(page, "Approve"));
    await click(
      [...(document.querySelector("dialog")?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.textContent === "Yes, approve",
      ),
    );
    expect(approvals()).toHaveLength(1);

    const mine = owner([proposal({ provenance: "my own notes", manifest: { name: "Weekly report" } })]);
    const own = await mount(
      <InWorkspace client={mine.client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(own);
    await click(button(own, "Approve"));
    expect(document.querySelector("dialog")).toBeNull();
    expect(mine.asked.filter((entry) => entry.payload["action"] === "approve")).toHaveLength(1);
  });

  it("asks once before approving an agent's proposal too, naming the chat it came from", async () => {
    const { client, asked } = owner([proposal()]);
    const page = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    await openProposal(page);
    await click(button(page, "Approve"));
    expect(asked.filter((entry) => entry.payload["action"] === "approve")).toEqual([]);
    expect(document.querySelector("dialog")?.textContent).toContain("Tavi proposed it in chat chat-1");
    await click(
      [...(document.querySelector("dialog")?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.textContent === "Yes, approve",
      ),
    );
    expect(asked.filter((entry) => entry.payload["action"] === "approve")).toHaveLength(1);
  });

  it("opens the proposal a chat card's Review asked for", async () => {
    const { client } = owner([
      proposal(),
      proposal({ skillId: "other", version: "1.0.0", reviewState: "approved", manifest: { name: "Other" } }),
    ]);
    requestSkillFocus({ skillId: "weekly-report", version: "proposed-20261027120000" });
    const page = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    expect(page.querySelector(".soul-skill-viewer h3")?.textContent).toBe("weekly-report@proposed-20261027120000");
    // Taken once: the page shown again opens nothing by itself.
    const again = await mount(
      <InWorkspace client={client}>
        <SkillsPane revision={0} />
      </InWorkspace>,
    );
    expect(again.querySelector(".soul-skill-viewer")).toBeNull();
  });
});
