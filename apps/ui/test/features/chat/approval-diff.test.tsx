// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { CallLine, DiffBlock } from "../../../src/features/chat/ApprovalParts.js";
import { mount, unmountAll } from "../../support/dom.js";

afterEach(unmountAll);

describe("an approval card's diff", () => {
  it("marks each added and removed line, and keeps the text as it was", async () => {
    const diff = "--- notes.txt\n+++ notes.txt\n@@ -1,2 +1,2 @@\n keep\n-Buy milk\n+Buy oat milk";
    const page = await mount(<DiffBlock diff={diff} />);
    const pre = page.querySelector("pre.call-diff");
    expect(pre?.textContent).toBe(`${diff}\n`);
    const marked = (kind: string) => [...page.querySelectorAll(`.${kind}`)].map((line) => line.textContent?.trimEnd());
    expect(marked("diff-added")).toEqual(["+Buy oat milk"]);
    expect(marked("diff-removed")).toEqual(["-Buy milk"]);
    expect(marked("diff-hunk")).toEqual(["@@ -1,2 +1,2 @@"]);
    expect(marked("diff-file")).toEqual(["--- notes.txt", "+++ notes.txt"]);
  });
});

describe("an approval card's read-back", () => {
  const call = (display: Record<string, unknown>) =>
    ({
      callId: "c1",
      toolName: "schedules.create",
      summary: "Schedule morning-brief",
      input: { name: "morning-brief" },
      risk: { level: "medium", reasons: ["An unattended run does this at each time it fires"] },
      display: { title: "Schedule morning-brief", ...display },
    }) as never;

  it("says a schedule's when, where its results go and what it runs on the card, not under Details", async () => {
    const detail = "When: Daily 07:00 · Europe/London\nPosts to: Home\nRuns: Summarise my inbox";
    const page = await mount(<CallLine request={call({ detail })} grouped={false} />);
    expect(page.querySelector(".call-readback")?.textContent).toBe(detail);
    expect(page.querySelector(".call-readback")?.closest("details")).toBeNull();
    // Shown once: Details keeps only the full input.
    expect(page.querySelector(".call-details .call-command")).toBeNull();
  });

  it("puts an email's draft whole on the card, its recipients still under Details", async () => {
    const detail = "To: you@example.com\n\nGot it.";
    const page = await mount(<CallLine request={call({ destination: "you@example.com", detail })} grouped={false} />);
    expect(page.querySelector(".call-readback")?.textContent).toBe(detail);
    expect(page.querySelector(".call-readback")?.closest("details")).toBeNull();
    expect(page.querySelector(".call-details .call-command")?.textContent).toBe("you@example.com");
  });

  it("keeps a command and a diff under Details", async () => {
    const command = await mount(<CallLine request={call({ command: "make test", detail: "in /work" })} grouped={false} />);
    expect(command.querySelector(".call-readback")).toBeNull();
    expect(command.querySelector(".call-details .call-command")?.textContent).toBe("make test");
    const diff = await mount(<CallLine request={call({ detail: "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-a\n+b" })} grouped={false} />);
    expect(diff.querySelector(".call-readback")).toBeNull();
    expect(diff.querySelector(".call-details .call-diff")).not.toBeNull();
  });
});
