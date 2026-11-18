// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { composePrompt, FILES_ONLY_PROMPT } from "../../../src/features/chat/attachments.js";
import { Prompt } from "../../../src/features/chat/RunView.js";
import { click, mount } from "../../support/dom.js";

/** A sent message's files: badges under its words, never their whole text in the bubble. */
describe("a message's files", () => {
  it("shows an inlined text file as a badge that opens to its lines, under the words typed", async () => {
    const shown = await mount(
      <Prompt id="p" text={composePrompt("Summarize", [{ name: "QA_REPORT_v3.md", text: "# Report\nall good" }])} />,
    );
    expect(shown.querySelector(".prompt")?.textContent).toBe("you: Summarize");
    // A badge only: the file's lines are not in the page until it is opened, and then in a dialog.
    expect(shown.querySelector(".prompt-file")?.textContent).toBe("QA_REPORT_v3.md");
    expect(shown.textContent).not.toContain("all good");
    await click(shown.querySelector(".prompt-file button"));
    const dialog = document.querySelector("dialog");
    expect(dialog?.querySelector("h2")?.textContent).toBe("QA_REPORT_v3.md");
    expect(dialog?.querySelector("pre")?.textContent).toBe("# Report\nall good");
    expect(shown.querySelector(".prompt")?.textContent).not.toContain("reference content");
  });

  it("names uploaded files, and a message of files alone shows only its badges", async () => {
    const shown = await mount(<Prompt id="p" text={FILES_ONLY_PROMPT} fileNames={["grab3885.png"]} />);
    expect(shown.querySelector(".prompt")).toBeNull();
    const list = shown.querySelector(".prompt-files");
    expect(list?.id).toBe("p");
    expect(list?.textContent).toBe("grab3885.png");
  });

  it("leaves a message with no files as it was", async () => {
    const shown = await mount(<Prompt id="p" text="just words" />);
    expect(shown.querySelector(".prompt")?.textContent).toBe("you: just words");
    expect(shown.querySelector(".prompt-files")).toBeNull();
  });
});
