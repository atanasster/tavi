import { describe, expect, it } from "vitest";
import { SHIPPED_TOOL_RULES, type ToolRule } from "@tavi/contracts";

import { permissionsCommand } from "../../src/features/permissions/owner.js";
import { renderPermissions } from "../../src/features/permissions/client.js";

const rule: ToolRule = {
  ruleId: "rule-abc",
  workspaceId: "default",
  toolPattern: "browser.*",
  decision: "ask",
  source: "operator",
  createdBy: "operator",
  createdVia: "cli",
  createdAt: "2026-11-04T00:00:00.000Z",
  note: "Ask before every browser step",
};

describe("tavi permissions as text", () => {
  it("rm names the rule it removed, as add names the rule it added", () => {
    expect(renderPermissions({ removed: true, rule })).toBe("removed rule-abc: ask browser.*");
  });

  it("list prints a header, padded columns, and each note indented on its own line", () => {
    const text = renderPermissions({ rules: [SHIPPED_TOOL_RULES[0] as ToolRule, rule] });
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^RULE\s+DECISION\s+TOOL\s+SOURCE$/);
    expect(text).not.toContain("\t");
    // The columns line up: every rule row has its decision where the header has DECISION.
    const at = lines[0]?.indexOf("DECISION");
    const rows = lines.filter((line) => !line.startsWith(" ") && line !== lines[0]);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.slice(at).startsWith("ask") || /^(allow|deny|ask)\b/.test(row.slice(at))).toBe(true);
    expect(lines).toContain("    Ask before every browser step");
    expect(text).toContain("yours");
    // No line runs past the width a terminal shows.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("grants name the chat by its title, with its id beside it", () => {
    const text = renderPermissions({
      grants: [
        {
          grantId: "g1",
          taskId: "task-1",
          taskTitle: "Shopping notes",
          workspaceId: "default",
          toolId: "fs.write",
          approvalId: "a",
          createdBy: "operator",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(text).toContain('chat "Shopping notes" (task-1)');
  });

  it("breaks a note's word too long for a line, as it wraps the rest", () => {
    const word = "n".repeat(150);
    const text = renderPermissions({ rules: [{ ...rule, note: `see ${word}` }] });
    const notes = text.split("\n").slice(2);
    for (const line of notes) expect(line.length, line).toBeLessThanOrEqual(100);
    expect(notes.join("").replaceAll(" ", "")).toBe(`see${word}`);
  });
});

describe("permissions remove on the owner", () => {
  it("answers with the rule it removed", async () => {
    const rules = [rule];
    const answer = await permissionsCommand(
      {
        repositories: {
          toolPolicy: { deleteRule: async () => true } as never,
          tasks: { get: async () => undefined } as never,
        },
        rulesInForce: async () => rules,
        now: () => "2026-11-04T00:00:00.000Z",
        chatGrants: { listInForce: async () => [] },
        fromBridge: false,
        via: "cli",
      },
      { action: "remove", workspaceId: "default", ruleId: "rule-abc" },
    );
    expect(answer).toEqual({ ok: true, result: { removed: true, rule } });
  });

  it("names each grant's chat by its title", async () => {
    const grant = {
      grantId: "g1",
      taskId: "task-1",
      workspaceId: "default",
      toolId: "fs.write",
      approvalId: "a",
      createdBy: "operator",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const answer = await permissionsCommand(
      {
        repositories: {
          toolPolicy: {} as never,
          tasks: { get: async (taskId: string) => (taskId === "task-1" ? { title: "Shopping notes" } : undefined) } as never,
        },
        rulesInForce: async () => [],
        now: () => "2026-11-04T00:00:00.000Z",
        chatGrants: { listInForce: async () => [grant] },
        fromBridge: false,
        via: "cli",
      },
      { action: "grants", workspaceId: "default" },
    );
    expect(answer).toEqual({ ok: true, result: { grants: [{ ...grant, taskTitle: "Shopping notes" }] } });
  });
});
