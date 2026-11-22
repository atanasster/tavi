// @vitest-environment jsdom
import { textRef } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { ClientResponse } from "@tavi/client/browser";

import type { McpReview } from "../../../src/features/settings/plugins-api.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { McpReviewModal } from "../../../src/features/settings/McpServers.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { InWorkspace } from "../../support/workspace.js";
import { mountSettled as mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A review's warnings by key: said in the page's language, the overlap's remedy chosen by its key, not its English. */

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const OVERLAP = "send_email overlaps Tavi's built-in mail tools (gmail.me.send_draft): the model may pick either";
const SHADOWING = "find's description names other tools (web_search): it may steer the model toward or away from them (shadowing)";

const REVIEW: McpReview = {
  pluginId: "mcp.docs",
  version: "1.0.0",
  reviewState: "approved",
  sandboxState: "srt",
  transport: "http",
  probedAt: "2026-10-14T00:00:00.000Z",
  launch: ["url https://docs.example/mcp"],
  disclosure: [],
  tools: [],
  notices: [],
  warnings: [OVERLAP, SHADOWING],
  warningRefs: [
    textRef("error.mcp.overlap.one", { which: "send_email", family: textRef("error.mcp.family.mail"), members: "gmail.me.send_draft" }),
    textRef("error.mcp.shadowing.description", { tool: "find", names: "web_search" }),
  ],
};

const client: SettingsClient = {
  request: async (command, payload) =>
    (command === "mcp" && (payload as { action?: unknown }).action === "show"
      ? { ok: true, result: { review: REVIEW } }
      : { ok: true, result: {} }) as ClientResponse,
};

const warningsOf = (label: string): readonly string[] =>
  [...(document.body.querySelector(`[aria-label="${label}"]`)?.querySelectorAll("li") ?? [])].map((item) => item.textContent ?? "");

describe("an MCP review's warnings", () => {
  it("says them in Bulgarian, the overlap with the page's own remedy", async () => {
    await setLocale("bg");
    await mount(
      <InWorkspace client={client}>
        <McpReviewModal pluginId="mcp.docs" onClose={() => undefined} onDone={() => undefined} />
      </InWorkspace>,
    );
    expect(warningsOf("Предупреждения")).toEqual([
      "send_email се застъпва с вградените инструменти на Tavi за поща (gmail.me.send_draft): моделът може да избере всеки от тях. Изключи онези, които не ти трябват.",
      "Описанието на find споменава други инструменти (web_search): може да насочи модела към тях или да го отклони от тях",
    ]);
  });

  it("says them in English as the owner wrote them", async () => {
    await mount(
      <InWorkspace client={client}>
        <McpReviewModal pluginId="mcp.docs" onClose={() => undefined} onDone={() => undefined} />
      </InWorkspace>,
    );
    expect(warningsOf("Warnings")).toEqual([`${OVERLAP}; leave out the ones you do not need`, SHADOWING]);
  });
});
