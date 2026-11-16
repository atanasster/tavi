import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Canvas } from "../../../src/features/chat/Canvas.js";
import { canvasCss } from "../../css.js";
import { InWorkspace } from "../../support/workspace.js";

/** A slash command's answer keeps its lines: `/forget`'s numbered matches and `/why`'s list, one to a line. */
describe("a slash command's answer", () => {
  const noop = () => undefined;
  const html = (failed?: true) =>
    renderToStaticMarkup(
      <InWorkspace>
        <Canvas
          state={{
            connection: "ready",
            runs: [],
            commandAnswer: { name: "forget", text: "3 matches:\n1. I'm vegetarian\n2. I live in Lisbon", ...(failed ? { failed } : {}) },
          }}
          session={undefined}
          onSubmit={noop}
          onDecide={noop}
          onAbort={noop}
          onExpand={noop}
        />
      </InWorkspace>,
    );

  it("is shown in a note that keeps its line breaks, answered or refused", () => {
    expect(html()).toContain('<p class="notice command-answer">/forget: 3 matches:\n1. I&#x27;m vegetarian');
    expect(html(true)).toContain('<p class="failure command-answer">');
    expect(canvasCss().replace(/\s+/g, " ")).toMatch(/\.main > \.command-answer \{ white-space: pre-line; \}/);
  });
});
