import type { AgentWaitOutcome } from "@tavi/contracts";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import type { McpElicitation } from "../../src/features/mcp/client.js";
import { planElicitation, type ElicitationPlan } from "../../src/features/mcp/elicitation.js";

/**
 * A server's question in a Bulgarian workspace: Tavi's frame, hints and buttons are Bulgarian, the server's own words
 * are as it wrote them, and an answer is read by which button it is, so an English answer still reads the same.
 */
const bg = coreIn("bg");

const answered = (label: string): AgentWaitOutcome => ({ kind: "answered", answers: [label] }) as AgentWaitOutcome;

function asked(plan: ElicitationPlan) {
  if (plan.kind !== "ask") throw new Error(`declined: ${plan.reason}`);
  return plan;
}

describe("an MCP server's question in Bulgarian", () => {
  it("frames a confirmation in Bulgarian and reads its buttons in either language", () => {
    const plan = asked(
      planElicitation(
        "Acme",
        { message: "Delete the draft?", requestedSchema: { type: "object", properties: {} } } as McpElicitation,
        "modern",
        bg,
      ),
    );
    expect(plan.question.question).toBe("Acme пита: Delete the draft?");
    expect(plan.question.context).toBe("Пита MCP сървърът Acme; извикването чака отговора ти до един ден.");
    expect(plan.question.choices?.options.map((option) => option.label)).toEqual(["Приеми", "Откажи"]);
    expect(plan.read(answered("Приеми"))).toEqual({ action: "accept", content: {} });
    expect(plan.read(answered("Откажи"))).toEqual({ action: "decline" });
    expect(plan.read(answered("Accept"))).toEqual({ action: "accept", content: {} });
  });

  it("asks yes or no with Bulgarian buttons and reads them as the field's value", () => {
    const plan = asked(
      planElicitation(
        "Acme",
        { message: "Send now?", requestedSchema: { type: "object", properties: { now: { type: "boolean" } } } } as McpElicitation,
        "legacy",
        bg,
      ),
    );
    expect(plan.question.choices?.options.map((option) => option.label)).toEqual(["Да", "Не", "Откажи"]);
    expect(plan.question.context).toContain("10 минути");
    expect(plan.read(answered("Да"))).toEqual({ action: "accept", content: { now: true } });
    expect(plan.read(answered("Не"))).toEqual({ action: "accept", content: { now: false } });
    expect(plan.read(answered("Yes"))).toEqual({ action: "accept", content: { now: true } });
  });

  it("says a page to open and the lines to answer with in Bulgarian", () => {
    const page = asked(
      planElicitation(
        "Acme",
        { mode: "url", message: "Finish signing in.", url: "https://acme.example/finish", elicitationId: "e1" } as McpElicitation,
        "modern",
        bg,
      ),
    );
    expect(page.question.question).toBe(
      "Acme иска да отвориш страница на acme.example: Finish signing in.\nhttps://acme.example/finish\nНе я отварям вместо теб. Избери „Готово“, когато приключиш там.",
    );
    expect(page.read(answered("Готово"))).toEqual({ action: "accept" });
    const form = asked(
      planElicitation(
        "Acme",
        {
          message: "Who is it for?",
          requestedSchema: { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"] },
        } as McpElicitation,
        "modern",
        bg,
      ),
    );
    expect(form.question.question).toBe(
      "Acme пита: Who is it for?\nОтговори с по един ред за всяко поле, като име: стойност; или отговори „Откажи“.\n- name\n- note (по избор)",
    );
    expect(form.read(answered("name: Ana"))).toEqual({ action: "accept", content: { name: "Ana" } });
  });

  it("keeps the English question byte for byte", () => {
    const plan = asked(
      planElicitation(
        "Acme",
        {
          message: "Pick one",
          requestedSchema: { type: "object", properties: { size: { type: "string", enum: ["s", "m", "l", "xl"] } } },
        } as McpElicitation,
        "modern",
      ),
    );
    expect(plan.question.question).toBe("Acme asks: Pick one\nsize (one of s, m, l, xl); or answer Decline");
  });
});
