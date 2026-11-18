// @vitest-environment jsdom
import type { PendingRound } from "@tavi/client/browser";
import { GATE_REASONS, GATE_REASON_WORDS, labelSummary, untrustedLabel, type ApprovalProvenance, type LabelSummary } from "@tavi/contracts";
import { act, useRef } from "react";
import { describe, expect, it } from "vitest";

import { Provenance } from "../../../src/features/chat/ApprovalParts.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { TaintChip, TaintChipView } from "../../../src/features/chat/TaintChip.js";
import { InWorkspace } from "../../support/workspace.js";
import { mount, rerender, unmountAll } from "../../support/dom.js";

/**
 * UNTRUSTED-CONTENT U4 in the canvas: an approval card says why it asks, in
 * plain words per gate reason, and where the chat's content came from — the
 * host Tavi parsed first, a page's own title after it as its claim, inert —
 * and where the call's values appear; the chat header's taint chip names up
 * to three sources and offers the remedy.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-10-13T10:00:00.000Z";
type Request = PendingRound["requests"][number];

function request(provenance: ApprovalProvenance | undefined, label?: LabelSummary): Request {
  return {
    callId: "c1",
    toolName: "http.request",
    summary: "Send",
    input: {},
    approvalId: "a1",
    risk: { level: "high", reasons: [], tainted: true, ...(label === undefined ? {} : { label }) },
    allowedScopes: ["once"],
    ...(provenance === undefined ? {} : { provenance }),
  };
}

const webRef = (title?: string) => ({
  source: "web" as const,
  ref: "call-1",
  host: "news.example",
  ...(title === undefined ? {} : { title }),
  at: AT,
});

describe("the approval card's provenance", () => {
  it("says why it asks, in plain words, for every gate reason", async () => {
    for (const gateReason of GATE_REASONS) {
      const shown = await mount(
        <Provenance request={request({ gateReason, sources: ["web"], principals: [], refs: [webRef()], argOrigins: [] })} />,
      );
      expect(shown.querySelector(".why-asked")?.textContent, gateReason).toBe(`Why am I asked? ${GATE_REASON_WORDS[gateReason]}`);
      unmountAll();
      shown.remove();
    }
  });

  it("names the skill whose allowed-tools a call falls outside, and its names no Tavi tool answers to", async () => {
    const shown = await mount(
      <Provenance
        request={request({
          gateReason: "outside-skill-ceiling",
          skillCeiling: { skillIds: ["pdf-forms"], declared: ["Read", "Frobnicate"], unenforceable: ["Frobnicate"] },
          sources: [],
          principals: [],
          refs: [],
          argOrigins: [],
        })}
      />,
    );
    const why = shown.querySelector(".why-asked")?.textContent ?? "";
    expect(why).toContain("skill “pdf-forms”");
    expect(why).toContain("allowed-tools: Read, Frobnicate");
    expect(why).toContain("Declared but not enforceable here: Frobnicate.");
  });

  it("leads each source chip with what Tavi established; a hostile title follows as an inert, clipped claim", async () => {
    const hostile = `<img src=x onerror=alert(1)><script>alert(2)</script>\u202Eexe.txt" ${"A".repeat(10 * 1024)}`;
    const shown = await mount(
      <Provenance
        request={request({
          gateReason: "tainted-message",
          sources: ["web", "email"],
          principals: [],
          refs: [webRef(hostile.slice(0, 120)), { source: "email", ref: "m1", host: "x.example", at: AT }],
          argOrigins: [],
        })}
      />,
    );
    expect(shown.querySelector("img, script")).toBeNull();
    const chips = [...shown.querySelectorAll(".source-chip")];
    expect(chips.map((chip) => chip.querySelector(".source-established")?.textContent)).toEqual([
      "news.example",
      "mail you forwarded or quoted (via x.example)",
    ]);
    const claim = chips[0]?.querySelector(".source-claim")?.textContent ?? "";
    // After the host, never before it; markup and the bidi override neutralized; the title at most 60 characters.
    expect(chips[0]?.textContent?.indexOf("news.example")).toBe(0);
    expect(claim).toMatch(/^ — the page calls itself “‹img src=x onerror=alert\(1\)›/);
    expect(claim).not.toMatch(/[<>\u202E]/);
    expect(Array.from(claim.slice(" — the page calls itself “".length, -1)).length).toBeLessThanOrEqual(60);
  });

  it("highlights where the call's values appear: the person's message, a page, or neither", async () => {
    const shown = await mount(
      <Provenance
        request={request({
          gateReason: "tainted-payload",
          sources: ["web"],
          principals: [],
          refs: [webRef()],
          argOrigins: [
            { path: "to", value: "alice@home.example", from: "person" },
            {
              path: "body",
              value: "bob@x.example",
              from: "content",
              source: "web",
              host: "news.example",
              toolId: "web_fetch",
              ref: "call-1",
            },
            { path: "url", value: "https://collect.attacker.example/?q=<b>x</b>", from: "unmatched" },
          ],
        })}
      />,
    );
    const items = [...shown.querySelectorAll(".arg-origins li")].map((item) => [item.querySelector("mark")?.className, item.textContent]);
    expect(items).toEqual([
      ["arg-origin arg-origin-person", "“alice@home.example” from your message"],
      ["arg-origin arg-origin-content", "“bob@x.example” appears in news.example"],
      [
        "arg-origin arg-origin-unmatched",
        "“https://collect.attacker.example/?q=‹b›x‹/b›” not in this chat's recent text (written by the model, or older)",
      ],
    ]);
    expect(shown.querySelector("b")).toBeNull();
  });

  it("neutralizes an argument's path in its tooltip", async () => {
    const shown = await mount(
      <Provenance
        request={request({
          gateReason: "tainted-payload",
          sources: ["web"],
          principals: [],
          refs: [webRef()],
          argOrigins: [{ path: "headers.x\u202Eevil\u0007<b>", value: "a value long enough here", from: "unmatched" }],
        })}
      />,
    );
    expect(shown.querySelector("mark")?.getAttribute("title")).toBe("headers.x evil ‹b›");
  });

  it("shows an older owner's label as chips when the request carries no provenance, and nothing for a clean call", async () => {
    const label = labelSummary(untrustedLabel("email", { ref: { ref: "m1", host: "x.example", at: AT } }));
    const shown = await mount(<Provenance request={request(undefined, label)} />);
    expect(shown.querySelector(".why-asked")?.textContent).toMatch(/steering this call/);
    expect(shown.querySelector(".source-established")?.textContent).toBe("mail you forwarded or quoted (via x.example)");
    unmountAll();
    shown.remove();
    const clean = await mount(<Provenance request={{ ...request(undefined), risk: { level: "medium", reasons: [], tainted: false } }} />);
    expect(clean.innerHTML).toBe("");
  });
});

describe("the chat header's taint chip", () => {
  const label = labelSummary({
    integrity: "untrusted",
    sources: ["web", "email", "search", "download"],
    principals: [],
    confidentiality: "public",
    refs: [webRef("Daily <b>news</b>"), { source: "email", ref: "m1", host: "x.example", at: AT }],
  });

  it("names up to three sources, and its details say what it changes, the remedy, and that Fresh context does not clear it", async () => {
    let fresh = 0;
    let closed = 0;
    const shown = await mount(
      <TaintChipView
        label={label}
        open={true}
        onToggle={() => undefined}
        onClose={() => {
          closed += 1;
        }}
        onFreshChat={() => {
          fresh += 1;
        }}
      />,
    );
    // An icon: what it read is its name.
    expect(shown.querySelector(".taint-chip")?.getAttribute("aria-label")).toBe(
      "Untrusted content: Read news.example, mail you forwarded or quoted (via x.example), search results and 1 more",
    );
    const panel = shown.querySelector(".taint-panel");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.textContent).toMatch(/Fresh context \(\/compact\) does not clear it/);
    expect([...shown.querySelectorAll(".taint-panel .source-established")].map((chip) => chip.textContent)).toEqual([
      "news.example",
      "mail you forwarded or quoted (via x.example)",
      "search results",
      "a download",
    ]);
    expect(shown.querySelector(".taint-panel b")).toBeNull();
    const remedy = [...shown.querySelectorAll("button")].find((button) => button.textContent === "Start a fresh chat");
    await act(async () => remedy?.click());
    expect([fresh, closed]).toEqual([1, 1]);
  });

  it("places its details by its chip, at the page's end, so they are kept inside the window", async () => {
    const Anchored = () => {
      const chip = useRef<HTMLButtonElement>(null);
      return <TaintChipView label={label} open={true} chip={chip} onToggle={() => undefined} onClose={() => undefined} />;
    };
    await mount(<Anchored />);
    const panel = document.querySelector<HTMLElement>(".taint-panel");
    expect(panel?.parentElement).toBe(document.body);
    expect(panel?.classList.contains("taint-panel-anchored")).toBe(true);
  });

  it("closes its details on Escape while focus is still on the chip", async () => {
    let closed = 0;
    const shown = await mount(
      <TaintChipView
        label={label}
        open={true}
        onToggle={() => undefined}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    const chip = shown.querySelector<HTMLButtonElement>(".taint-chip");
    chip?.focus();
    await act(async () => chip?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(closed).toBe(1);
  });

  it("reads the chat's label alone, and shows nothing for a clean chat", async () => {
    const asked: unknown[] = [];
    let answer: LabelSummary | null = labelSummary({
      integrity: "trusted",
      sources: [],
      principals: [],
      confidentiality: "public",
      refs: [],
    });
    const client: SettingsClient = {
      request: async (command, payload) => {
        asked.push([command, payload]);
        return { ok: true, result: { taskId: "task-1", contextLabel: answer } };
      },
    };
    const shown = await mount(
      <InWorkspace client={client} workspaceId="default">
        <TaintChip taskId="task-1" version="1" />
      </InWorkspace>,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(asked).toEqual([["tasks", { action: "label", taskId: "task-1", workspaceId: "default" }]]);
    expect(shown.querySelector(".taint-chip")).toBeNull();
    answer = label;
    await rerender(
      <InWorkspace client={client} workspaceId="default">
        <TaintChip taskId="task-1" version="2" />
      </InWorkspace>,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(shown.querySelector(".taint-chip")?.getAttribute("aria-label")).toContain("Read news.example");
  });
});
