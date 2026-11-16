import { describe, expect, it } from "vitest";
import { deciderName, roundGroupName } from "../../../src/features/chat/Approvals.js";
import { describeRequest, inputDetails } from "../../../src/features/chat/ApprovalParts.js";

describe("describeRequest", () => {
  it("keeps a summary that says more than the tool's name", () => {
    expect(describeRequest({ toolName: "files.remove", summary: "delete report.pdf", input: { path: "x" } })).toBe("delete report.pdf");
  });
  it("shows the input when the summary is the workflow's default", () => {
    // "Approve web_search?" told the reader nothing about the search itself.
    expect(
      describeRequest({ toolName: "web_search", summary: "Approve web_search?", input: { query: "jev typesafe.ai", maxResults: 5 } }),
    ).toBe("query: jev typesafe.ai, maxResults: 5");
  });
  it("cuts a long input and survives a bare one", () => {
    expect(describeRequest({ toolName: "t", summary: "Approve t?", input: { q: "a".repeat(300) } })?.length).toBe(120);
    expect(describeRequest({ toolName: "t", summary: "Approve t?", input: undefined })).toBeUndefined();
    expect(describeRequest({ toolName: "t", summary: "Approve t?", input: {} })).toBeUndefined();
  });
});

describe("what a card shows of a call's own input", () => {
  const rlo = String.fromCodePoint(0x202e);
  const zwsp = String.fromCodePoint(0x200b);
  it("marks what the input would hide, in the line and in the details", () => {
    const described = describeRequest({
      toolName: "files.remove",
      summary: "Approve files.remove?",
      input: { path: `report${rlo}fdp.exe` },
    });
    expect(described).toBe("path: report⟨U+202E⟩fdp.exe");
    // A summary from a round raised without a display is marked too.
    expect(describeRequest({ toolName: "files.remove", summary: `delete report${rlo}fdp.exe`, input: {} })).toBe(
      "delete report⟨U+202E⟩fdp.exe",
    );
    expect(inputDetails({ path: `a${zwsp}b`, nested: { note: `x${rlo}` } })).toBe(
      JSON.stringify({ path: "a⟨U+200B⟩b", nested: { note: "x⟨U+202E⟩" } }, null, 2),
    );
    expect(inputDetails({ path: `a${zwsp}b` }).includes(zwsp)).toBe(false);
  });

  it("names the hosts a grouped browser round allows", () => {
    const round = (hosts: readonly (string | undefined)[]) => ({
      requests: hosts.map((host) => ({
        display: host === undefined ? { title: "Use the browser" } : { title: `Open ${host} in the browser`, host },
      })),
    });
    expect(roundGroupName("browser.*", round(["example.com"]))).toBe("browser on example.com");
    expect(roundGroupName("browser.*", round([undefined]))).toBe("browser");
  });
});

describe("who decided a round", () => {
  it("names a blanket --approval decision for what it decided, and a person by name", () => {
    expect(deciderName("auto:operator", true)).toBe("automatic approval (--approval approve)");
    expect(deciderName("auto:operator", false)).toBe("automatic denial (--approval deny)");
    expect(deciderName("operator")).toBe("you");
    expect(deciderName("alex")).toBe("alex");
  });
});
