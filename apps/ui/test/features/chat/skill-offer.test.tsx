// @vitest-environment jsdom
import type { SkillVersion } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { takeSkillFocus } from "../../../src/features/center/skills-api.js";
import { chatSkillOffer, proposesSkill, SkillOfferCard, skillOfferHost } from "../../../src/features/chat/SkillOffer.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { button, clickSettled as click, mountSettled as mount } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * The end-of-turn card for a skill the agent offered on its own: placed after
 * the turn that filed it, with Review (opens it in the Skills review), Not
 * now (it keeps waiting) and Don't suggest this (rejected: the 30-day hold).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-10-27T12:00:00.000Z";

const version = (overrides: Partial<SkillVersion> = {}, requested = false): SkillVersion => ({
  skillId: "weekly-report",
  version: "proposed-20261027120000",
  contentHash: "a".repeat(64),
  scopeKey: "default",
  manifest: {
    name: "Weekly report",
    description: "How the weekly report is written",
    proposal: { taskId: "chat-1", note: "ok", requested },
  },
  provenance: "chat:chat-1",
  reviewState: "proposed",
  packageArtifactId: "artifact-1",
  importedBy: "operator",
  importedAt: AT,
  ...overrides,
});

/** A turn: its tool lines (a saved turn's carry no output), and when it last spoke. */
const turn = (tools: readonly { readonly name: string; readonly output?: unknown }[], lastAt?: string) =>
  ({
    run: {
      transcript: tools.map((tool, index) => ({
        kind: "tool",
        key: `k${index}`,
        attemptId: "a",
        callId: `c${index}`,
        toolName: tool.name,
        status: "completed",
        ...(tool.output === undefined ? {} : { output: tool.output }),
      })),
    },
    ...(lastAt === undefined ? {} : { lastAt }),
  }) as never;

function owner(versions: SkillVersion[]) {
  const asked: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const body = payload as Record<string, unknown>;
      asked.push(body);
      if (body["action"] === "reject") {
        const index = versions.findIndex((entry) => entry.skillId === body["skillId"] && entry.version === body["version"]);
        versions[index] = { ...versions[index]!, reviewState: "rejected", reviewedAt: AT };
        return { ok: true, result: versions[index] } as never;
      }
      return { ok: true, result: { versions, activations: [], usage: [] } } as never;
    },
  };
  return { client, asked };
}

describe("the chat's skill offer card", () => {
  it("is placed after the turn whose skills.propose filed the chat's unasked offer", () => {
    const offer = version();
    expect(proposesSkill(turn([{ name: "skills.propose" }]))).toBe(true);
    expect(proposesSkill(turn([{ name: "web_fetch" }]))).toBe(false);
    // Only an unasked proposal of this chat is an offer.
    expect(chatSkillOffer([version({}, true)], "chat-1")).toBeUndefined();
    expect(chatSkillOffer([offer, version({ provenance: "chat:other" })], "chat-1")).toBe(offer);
    // A live turn's call names it; an earlier turn's asked-for proposal does not.
    const named = [
      turn([{ name: "skills.propose", output: { skillId: "asked", version: "proposed-1" } }], "2026-10-27T11:00:00.000Z"),
      turn([{ name: "skills.propose", output: { skillId: "weekly-report", version: offer.version } }], "2026-10-27T12:00:01.000Z"),
    ];
    expect(skillOfferHost(named, offer)).toBe(1);
    // Saved turns carry no output: the first that ended after it was filed.
    const saved = [
      turn([{ name: "skills.propose" }], "2026-10-27T11:00:00.000Z"),
      turn([{ name: "web_fetch" }], "2026-10-27T12:00:05.000Z"),
      turn([{ name: "skills.propose" }], "2026-10-27T12:00:05.000Z"),
    ];
    expect(skillOfferHost(saved, offer)).toBe(2);
  });

  it("offers Review, Not now and Don't suggest this; Review opens the proposal in the Skills review", async () => {
    const { client } = owner([version()]);
    let reviewed = 0;
    const runs = [turn([{ name: "web_fetch" }], AT), turn([{ name: "skills.propose" }], "2026-10-27T12:00:05.000Z")];
    // Not the turn that filed it: nothing.
    const elsewhere = await mount(
      <InWorkspace client={client}>
        <SkillOfferCard taskId="chat-1" runs={runs} index={0} />
      </InWorkspace>,
    );
    expect(elsewhere.querySelector(".skill-offer")).toBeNull();
    const page = await mount(
      <InWorkspace client={client}>
        <SkillOfferCard taskId="chat-1" runs={runs} index={1} onReview={() => (reviewed += 1)} />
      </InWorkspace>,
    );
    expect(page.querySelector(".memory-card-heading")?.textContent).toBe("Save how I did this as a skill?");
    expect(page.querySelector(".memory-card-title")?.textContent).toBe("Weekly report");
    expect([...page.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual(["Review", "Not now", "Don't suggest this"]);
    await click(button(page, "Review"));
    expect(reviewed).toBe(1);
    expect(takeSkillFocus()).toEqual({ skillId: "weekly-report", version: "proposed-20261027120000" });
  });

  it("leaves it waiting on Not now, kept folded in this browser", async () => {
    window.localStorage.clear();
    const { client, asked } = owner([version()]);
    const runs = [turn([{ name: "skills.propose" }], "2026-10-27T12:00:05.000Z")];
    const page = await mount(
      <InWorkspace client={client}>
        <SkillOfferCard taskId="chat-1" runs={runs} index={0} onReview={() => undefined} />
      </InWorkspace>,
    );
    await click(button(page, "Not now"));
    expect(page.querySelector(".memory-card-heading")?.textContent).toBe("Waiting for your review: Weekly report");
    expect([...page.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual(["Review"]);
    expect(asked.some((entry) => entry["action"] === "reject")).toBe(false);
    const again = await mount(
      <InWorkspace client={client}>
        <SkillOfferCard taskId="chat-1" runs={runs} index={0} onReview={() => undefined} />
      </InWorkspace>,
    );
    expect(again.querySelector(".memory-card-heading")?.textContent).toBe("Waiting for your review: Weekly report");
  });

  it("rejects it on Don't suggest this, so its topic is held for 30 days", async () => {
    window.localStorage.clear();
    const { client, asked } = owner([version()]);
    const runs = [turn([{ name: "skills.propose" }], "2026-10-27T12:00:05.000Z")];
    const page = await mount(
      <InWorkspace client={client}>
        <SkillOfferCard taskId="chat-1" runs={runs} index={0} />
      </InWorkspace>,
    );
    await click(button(page, "Don't suggest this"));
    expect(asked.find((entry) => entry["action"] === "reject")).toEqual({
      action: "reject",
      skillId: "weekly-report",
      version: "proposed-20261027120000",
      workspaceId: "default",
    });
    expect(page.querySelector(".memory-card-heading")?.textContent).toBe("Not suggested again for 30 days: Weekly report");
    expect(page.querySelectorAll("button")).toHaveLength(0);
  });

  it("follows an edit made in the review: the card shows the edited version's state", async () => {
    const original = version({ reviewState: "rejected" });
    const edited = version({ version: "edited-20261027130000", parentVersion: original.version, importedAt: "2026-10-27T13:00:00.000Z" });
    const { client } = owner([original, edited]);
    const page = await mount(
      <InWorkspace client={client}>
        <SkillOfferCard taskId="chat-1" runs={[turn([{ name: "skills.propose" }], "2026-10-27T12:00:05.000Z")]} index={0} />
      </InWorkspace>,
    );
    expect(page.querySelector(".skill-offer")?.getAttribute("data-skill-offer")).toBe("weekly-report@edited-20261027130000");
    expect(page.querySelector(".memory-card-heading")?.textContent).toBe("Save how I did this as a skill?");
  });
});
