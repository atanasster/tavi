import { describe, expect, it } from "vitest";

import { approvalQuery, shownInput } from "../../src/features/approvals/prompt.js";
import { renderPermissions } from "../../src/features/permissions/client.js";

const rlo = String.fromCodePoint(0x202e);
const esc = String.fromCodePoint(0x1b);
const zwsp = String.fromCodePoint(0x200b);

describe("a call's input in the terminal", () => {
  it("marks what the foreground prompt would hide", () => {
    const query = approvalQuery(`Run ${rlo}ls`, { command: `rm -rf ~${rlo}txt.exe`, note: `a${zwsp}b` }, "y/s/N");
    expect(query).toBe('Run ⟨U+202E⟩ls {"command":"rm -rf ~⟨U+202E⟩txt.exe","note":"a⟨U+200B⟩b"} [y/s/N] ');
    expect(query.includes(rlo) || query.includes(zwsp)).toBe(false);
  });

  it("names only the call when the stream above already printed it", () => {
    expect(approvalQuery(`Edit todo.txt${rlo}`, { path: "todo.txt" }, "y/s/a/N", true)).toBe("Approve Edit todo.txt⟨U+202E⟩? [y/s/a/N] ");
  });

  it("marks what tavi approvals show's full input would hide", () => {
    const shown = shownInput({ path: `report${rlo}fdp.exe`, raw: `x${esc}[8my` }, 2);
    expect(shown).toBe(["{", '  "path": "report⟨U+202E⟩fdp.exe",', '  "raw": "x⟨ESC⟩[8my"', "}"].join("\n"));
    expect(shownInput(undefined)).toBe("null");
  });
});

describe("a rule's and a grant's matcher in tavi permissions", () => {
  it("marks what a matcher would hide", () => {
    const rule = {
      ruleId: "r1",
      workspaceId: "default",
      toolPattern: "sandbox.run",
      argMatcher: `ls ${rlo}gpj.exe`,
      decision: "allow",
      source: "operator",
      createdBy: "me",
      createdVia: "cli",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const grant = {
      grantId: "g1",
      taskId: "t1",
      workspaceId: "default",
      toolId: "browser.navigate",
      argMatcher: `example.com${zwsp}`,
      approvalId: "a",
      createdBy: "alice",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const rules = renderPermissions({ rules: [rule] });
    const grants = renderPermissions({ grants: [grant] });
    expect(rules).toContain("matching ls ⟨U+202E⟩gpj.exe");
    expect(grants).toContain("matching example.com⟨U+200B⟩");
    expect(renderPermissions({ rule })).toContain("⟨U+202E⟩");
  });
});
